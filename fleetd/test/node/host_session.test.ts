// The session host's kill ladder against real processes (crates/fleetd/src/node/runner/claude/session/tests.rs). The
// fake claude does what made a group kill insufficient: it starts a "tool" child in its own session (so outside
// claude's process group) that ignores SIGTERM, and it ignores SIGTERM itself. Only the descendant sweep, the SIGKILL
// step and the subreaper's reaping can end that tree cleanly. Linux only: the sweeps read /proc.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostLink, marker, readRegistration, type RunnerEvent } from "../../src/node/runner/host.ts";
import type { ExitInfo } from "../../src/node/runner/host/events.ts";
import { StreamMapper } from "../../src/node/runner/host/mapper.ts";
import { startSession, type Session } from "../../src/node/runner/host/session.ts";
import { statOf } from "../../src/node/runner/procs.ts";

const FAKE_CLAUDE = `#!/bin/sh
trap '' TERM
setsid sh -c 'trap "" TERM; echo $$ > "$PIDFILE.tmp"; mv "$PIDFILE.tmp" "$PIDFILE"; exec sleep 300' &
while [ ! -s "$PIDFILE" ]; do :; done
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake"}'
cat > "$STDIN_LOG"
exec sleep 300
`;

/** Starts $TOOL detached (setsid) from a shell that exits at once, so the tool is orphaned to its host while claude
 * still runs, the way an agent's \`setsid server &\` would be. */
const DETACHING_CLAUDE = `#!/bin/sh
export HOST_PID=$PPID
sh -c 'setsid "$TOOL" &'
while [ ! -s "$PIDFILE" ]; do :; done
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake"}'
cat > "$STDIN_LOG"
`;

/** Starts its tool detached and without the marker, which the tool takes on by its last \`exec\` only once the test
 * writes to $FIFO. Until then it is what a sweep sees of a tool mid-\`exec\`: a process whose marker can't be read. */
const LATE_MARKER_CLAUDE = `#!/bin/sh
setsid env -u FLEETD_RUNNER_SESSION sh -c 'echo $$ > "$PIDFILE.tmp"; mv "$PIDFILE.tmp" "$PIDFILE"; read line < "$FIFO"; exec env FLEETD_RUNNER_SESSION="$1" sleep 300' sh "$FLEETD_RUNNER_SESSION" &
while [ ! -s "$PIDFILE" ]; do :; done
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake"}'
exec sleep 300
`;

/** Waits until it has been reparented to the host, says so, then exits on its own once the test writes to $FIFO. */
const DETACHED_TOOL = `#!/bin/sh
while [ "$(cut -d' ' -f4 /proc/$$/stat)" != "$HOST_PID" ]; do :; done
echo $$ > "$PIDFILE.tmp"; mv "$PIDFILE.tmp" "$PIDFILE"
read line < "$FIFO"
`;

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-session-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

/** Gone entirely: killed and reaped, not left as a zombie. */
const gone = (pid: number) => !existsSync(`/proc/${pid}`);
/** Running (not a zombie). */
const alive = (pid: number) => statOf(pid)?.zombie === false;
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);
async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(10);
  }
}

class Fake {
  readonly dir = join(root, `fake-${++n}`);
  readonly events: RunnerEvent[] = [];
  #waiters: (() => void)[] = [];
  session!: Session;

  constructor() {
    mkdirSync(this.dir);
    Bun.spawnSync(["mkfifo", this.path("fifo")]);
    this.#executable("tool", DETACHED_TOOL);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  #executable(name: string, text: string): string {
    writeFileSync(this.path(name), text);
    chmodSync(this.path(name), 0o755);
    return this.path(name);
  }

  env(): Record<string, string> {
    return { PIDFILE: this.path("tool.pid"), STDIN_LOG: this.path("stdin.log"), TOOL: this.path("tool"), FIFO: this.path("fifo") };
  }

  /** Starts `script` as a session in this process, and waits for its init: by then the tool wrote its pid. */
  async start(session: string, script: string): Promise<this> {
    const program = this.#executable("claude", script);
    Object.assign(process.env, this.env());
    try {
      for (let tries = 0; ; tries++) {
        try {
          // A marker of its own, never the session this test may run in: the sweeps kill whatever carries it.
          const mark = marker(session);
          if (mark === process.env.FLEETD_RUNNER_SESSION) throw new Error("the fake's marker is this session's");
          this.session = await startSession(program, [], session, mark, (e) => this.#event(e), new StreamMapper(session, () => undefined));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ETXTBSY" || tries > 100) throw error;
          await Bun.sleep(10);
        }
      }
    } finally {
      for (const k of Object.keys(this.env())) delete process.env[k];
    }
    await within(this.next((e) => typeof e === "object" && "Init" in e), 10_000, "init");
    return this;
  }

  #event(event: RunnerEvent): void {
    this.events.push(event);
    for (const w of this.#waiters.splice(0)) w();
  }

  /** The first event matching `want`, once it came. */
  async next(want: (e: RunnerEvent) => boolean): Promise<RunnerEvent> {
    for (;;) {
      const found = this.events.find(want);
      if (found) return found;
      await new Promise<void>((r) => this.#waiters.push(r));
    }
  }

  /** Every event before the exit, and the exit. */
  async untilExit(): Promise<[RunnerEvent[], ExitInfo]> {
    const exit = await within(this.next((e) => typeof e === "object" && "Exited" in e), 20_000, "the exit");
    return [this.events.filter((e) => e !== exit && !(typeof e === "object" && "Init" in e)), (exit as { Exited: ExitInfo }).Exited];
  }

  toolPid(): number {
    return Number(readFileSync(this.path("tool.pid"), "utf8").trim());
  }

  /** Waits until the tool runs its last image with its marker readable (mid-exec its environ reads empty). */
  async settled(): Promise<void> {
    const tool = this.toolPid();
    await until(
      () => {
        let comm = "";
        let env = "";
        try {
          comm = readFileSync(`/proc/${tool}/comm`, "utf8").trim();
          env = readFileSync(`/proc/${tool}/environ`, "latin1");
        } catch {}
        return ["sleep", "tool"].includes(comm) && env.split("\0").some((v) => v.startsWith("FLEETD_RUNNER_SESSION="));
      },
      30_000,
      `the tool ${tool} never started`,
    );
  }

  /** The processes that carry this fake's environment, as `pid ppid` pairs. */
  processes(): string {
    const ours = `PIDFILE=${this.path("tool.pid")}`;
    return readdirSync("/proc")
      .filter((p) => /^\d+$/.test(p))
      .flatMap((p) => {
        try {
          if (!readFileSync(`/proc/${p}/environ`, "latin1").split("\0").includes(ours)) return [];
          return [`${p} ${statOf(Number(p))?.ppid}`];
        } catch {
          return [];
        }
      })
      .join(", ");
  }

  /** A failing test must not leak its tree: the tool, by its recorded pid, while it is still this fake's. */
  cleanup(): void {
    let pid: number;
    try {
      pid = this.toolPid();
    } catch {
      return;
    }
    let env = "";
    try {
      env = readFileSync(`/proc/${pid}/environ`, "latin1");
    } catch {}
    if (env.split("\0").includes(`PIDFILE=${this.path("tool.pid")}`))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  }
}

const shutdown = (ms: number) => ({ Shutdown: { grace: { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 } } }) as const;

test.skipIf(process.platform !== "linux")("a tool that detaches and exits on its own does not linger", async () => {
  // A real host: only a subreaper gets the orphan, and this test process must not become one.
  const fake = new Fake();
  const dir = fake.path("host");
  mkdirSync(dir);
  writeFileSync(fake.path("claude"), DETACHING_CLAUDE);
  chmodSync(fake.path("claude"), 0o755);
  // A clean environment and a marker of its own: a host takes FLEETD_RUNNER_SESSION as its spawn's marker, and this
  // test may run inside a session, whose marker its sweeps would then match, killing that session's whole tree.
  const mark = marker("s-a3");
  expect(mark).not.toBe(process.env.FLEETD_RUNNER_SESSION);
  const home = fake.path("home");
  const host = Bun.spawn([process.execPath, join(import.meta.dir, "../../src/main.ts"), "session-host", dir, "s-a3", "--", fake.path("claude")], {
    env: { PATH: "/usr/bin:/bin", HOME: home, FLEETD_HOME: join(home, ".fleetd"), FLEETD_RUNNER_SESSION: mark, ...fake.env() },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await until(() => !!readRegistration(dir), 10_000, "the host registered");
    const link = await HostLink.connect(dir);
    /** The next event, or what the fake's processes look like when none came. */
    const next = async (what: string) => {
      try {
        return await within(link.next(), 10_000, what);
      } catch (error) {
        throw new Error(`${(error as Error).message}; host ${host.pid}, fake's processes (pid ppid): ${fake.processes()}`);
      }
    };
    // Every event counted once applied, the init included, as the session service does: the host keeps what isn't.
    for (;;) {
      const e = await next("init");
      if (e === undefined) throw new Error("the host went before claude's init");
      link.applied++;
      if (typeof e === "object" && "Init" in e) break;
    }
    // The tool wrote its pid only once it was the host's child.
    const tool = fake.toolPid();
    await within(Bun.spawn(["sh", "-c", `echo go > '${fake.path("fifo")}'`]).exited, 5_000, "the tool read its line");
    await until(() => gone(tool), 5_000, `the detached tool ${tool} lingers as a zombie`);
    link.send(shutdown(10_000));
    let exit: ExitInfo | undefined;
    for (let e = await next("the exit"); e !== undefined; e = await next("the exit")) {
      link.applied++;
      if (typeof e === "object" && "Exited" in e) exit = e.Exited;
    }
    expect(exit?.code).toBe(0);
    expect(await within(host.exited, 10_000, "the host exited")).toBe(0);
  } finally {
    host.kill("SIGKILL");
    fake.cleanup();
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("nobody reading the events ends the session and its tree", async () => {
  const fake = await new Fake().start("00000000-0000-4000-8000-0000000000a4", FAKE_CLAUDE);
  try {
    await fake.settled();
    const tool = fake.toolPid();
    fake.session.close();
    await until(() => gone(tool), 15_000, `the tool child ${tool} survived`);
  } finally {
    fake.cleanup();
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("two spawns of one session never sweep each other", async () => {
  const session = "00000000-0000-4000-8000-0000000000a5";
  const old = await new Fake().start(session, FAKE_CLAUDE);
  const next = await new Fake().start(session, FAKE_CLAUDE);
  try {
    await old.settled();
    await next.settled();
    const [oldTool, newTool] = [old.toolPid(), next.toolPid()];
    process.kill(old.session.pid, "SIGKILL");
    await old.untilExit();
    // The sweep at the old claude's exit may still be ending its tree as the exit is read.
    await until(() => gone(oldTool), 5_000, "the old tool went");
    expect(alive(newTool)).toBe(true);
    next.session.command(shutdown(0));
    await next.untilExit();
    await until(() => gone(newTool), 5_000, "the new tool went");
  } finally {
    old.cleanup();
    next.cleanup();
  }
}, 40_000);

test.skipIf(process.platform !== "linux")("shutdown interrupts the run, then escalates to SIGKILL and takes escaped children along", async () => {
  const fake = await new Fake().start("00000000-0000-4000-8000-0000000000a1", FAKE_CLAUDE);
  try {
    await fake.settled();
    const tool = fake.toolPid();
    const runId = "00000000-0000-4000-8000-0000000000r1";
    fake.session.command({ Send: { run_id: runId, text: "Run `sleep 300`.", mode: "plain" } });
    fake.session.command(shutdown(1000));
    const [events, exit] = await fake.untilExit();
    // SIGTERM is ignored by both, so only the SIGKILL step ends them.
    expect([exit.code, exit.signal]).toEqual([null, 9]);
    expect(gone(tool)).toBe(true);
    // The node stopped it: the cut run is interrupted, not failed.
    expect(events).toEqual([{ RunEnded: { run_id: runId, outcome: "Interrupted", usage: null } }]);
    // The interrupt went in before stdin closed.
    const lines = readFileSync(fake.path("stdin.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);
    expect(lines[0].uuid).toBe(runId);
    expect(lines[1].request.subtype).toBe("interrupt");
  } finally {
    fake.cleanup();
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("a crashed claude leaves no orphan behind", async () => {
  const fake = await new Fake().start("00000000-0000-4000-8000-0000000000a2", FAKE_CLAUDE);
  try {
    await fake.settled();
    const tool = fake.toolPid();
    // A crash: claude dies at once and its tool child, in another session, is orphaned.
    process.kill(fake.session.pid, "SIGKILL");
    const [events, exit] = await fake.untilExit();
    expect(exit.signal).toBe(9);
    expect(events).toEqual([]);
    await until(() => !alive(tool), 5_000, `the orphaned tool child ${tool} survived`);
  } finally {
    fake.cleanup();
  }
}, 30_000);

test.skipIf(process.platform !== "linux")("a tool still in exec when claude dies is killed by the resweep", async () => {
  const fake = await new Fake().start("00000000-0000-4000-8000-0000000000a6", LATE_MARKER_CLAUDE);
  try {
    const tool = fake.toolPid();
    process.kill(fake.session.pid, "SIGKILL");
    await fake.untilExit();
    expect(alive(tool)).toBe(true);
    // Its exec completes: its marker is readable now, and the resweep finds it.
    await Bun.spawn(["sh", "-c", `echo go > '${fake.path("fifo")}'`]).exited;
    await until(() => !alive(tool), 10_000, `the tool ${tool} outlived the resweep`);
  } finally {
    fake.cleanup();
  }
}, 30_000);
