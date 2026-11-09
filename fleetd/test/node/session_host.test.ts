// Session hosts against a real process (crates/fleetd/src/node/runner/host/tests.rs): a fake claude that says
// `system/init` once per line it is asked for, so each event is told apart by its model (`m1`, `m2`, …). The host runs
// in this process, as the node's restart is what's tested: a node is a connection, and its restart a detach, a crash or
// a drop, then a connection again. The last test has a host the Rust build started adopted by this node's link.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostLink, marker, PROTOCOL, readRegistration, startOf, stop, sweep, type RunnerEvent } from "../../src/node/runner/host.ts";
import { BOUNDS, host, register, type Bounds, type Server } from "../../src/node/runner/host/serve.ts";

/** Says m1..m3, waits for a line on the FIFO `$1`, says m4..m6, then runs until its stdin closes. */
const TALKING_CLAUDE = `#!/bin/sh
init() { echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"claude_code_version\\":\\"2.1.302\\",\\"model\\":\\"m$1\\",\\"cwd\\":\\"/fake\\"}"; }
init 1; init 2; init 3
read go < "$1"
init 4; init 5; init 6
exec cat > /dev/null
`;

/** Says m1 and exits. */
const BRIEF_CLAUDE = `#!/bin/sh
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"m1","cwd":"/fake"}'
`;

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-host-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let fakes = 0;

class Fake {
  readonly dir = join(root, `fake-${++fakes}`);
  constructor() {
    mkdirSync(this.dir);
    Bun.spawnSync(["mkfifo", join(this.dir, "go")]);
  }

  hostDir(name: string): string {
    const dir = join(this.dir, "hosts", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A host for `script` in `hosts/<name>`, serving in this process: its dir, claude's pid and the server. */
  async host(name: string, script: string, bounds: Bounds = BOUNDS): Promise<[string, number, Server]> {
    const program = join(this.dir, `claude-${name.slice(0, 40)}`);
    writeFileSync(program, script);
    chmodSync(program, 0o755);
    const dir = this.hostDir(name);
    // A marker of its own: this test may itself run inside a session, whose marker its sweeps must never match.
    const mark = marker(`host-test-${name.slice(0, 20)}`);
    for (let tries = 0; ; tries++) {
      try {
        const server = await host(dir, name, program, [join(this.dir, "go")], mark, bounds);
        return [dir, readRegistration(dir)!.pid, server];
      } catch (error) {
        // Another test's fork may briefly hold the script's write fd.
        if ((error as NodeJS.ErrnoException).code !== "ETXTBSY" || tries > 100) throw error;
        await Bun.sleep(10);
      }
    }
  }

  /** Lets the fake claude say its second half. */
  async go(): Promise<void> {
    await Bun.spawn(["sh", "-c", `echo go > '${join(this.dir, "go")}'`]).exited;
  }
}

const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, Bun.sleep(ms).then(() => Promise.reject(new Error(`timed out: ${what}`)))]);

/** Applies events as the session service does (each counted once applied) until `n` inits came; their models. */
async function applyInits(link: HostLink, n: number): Promise<string[]> {
  const models: string[] = [];
  while (models.length < n) {
    const event = await within(link.next(), 10_000, "an event");
    expect(event).toBeDefined();
    if (typeof event === "object" && "Init" in event!) models.push(event.Init.model);
    link.applied++;
  }
  return models;
}

/** Applies events until the exit. */
async function untilExit(link: HostLink): Promise<void> {
  for (;;) {
    const event: RunnerEvent | undefined = await within(link.next(), 15_000, "an event");
    expect(event).toBeDefined();
    link.applied++;
    if (typeof event === "object" && "Exited" in event!) return;
  }
}

const running = (pid: number) => startOf(pid) !== undefined;
const ended = (server: Server) => within(server.done, 15_000, "the host ended");
const zero = { Shutdown: { grace: { secs: 0, nanos: 0 } } } as const;

test("a session runs on through a node restart and each event arrives once", async () => {
  const fake = new Fake();
  const [dir, pid, server] = await fake.host("s1", TALKING_CLAUDE);
  const first = await HostLink.connect(dir);
  expect(first.pid).toBe(pid);
  const seen = await applyInits(first, 3);

  // The node stops for its update: it lets go, and the session goes on without it.
  await first.detach();
  expect(await first.next()).toBeUndefined();
  expect(first.detached).toBe(true);
  await fake.go();
  await Bun.sleep(200);
  expect(running(pid)).toBe(true);

  // The next node takes it from there: what the last one applied never again, what it said meanwhile once.
  const second = await HostLink.connect(dir);
  expect(second.pid).toBe(pid);
  seen.push(...(await applyInits(second, 3)));
  expect(seen).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  const more = await Promise.race([second.next(), Bun.sleep(300).then(() => "none")]);
  expect(more).toBe("none");

  // It still ends as a session does, and its host with it once the node took the exit.
  second.send(zero);
  await untilExit(second);
  await ended(server);
  expect(running(pid)).toBe(false);
}, 30_000);

test("a host keeps what no node acknowledged", async () => {
  const fake = new Fake();
  const [dir, pid, server] = await fake.host("s1", TALKING_CLAUDE);
  // A node that reads three events and dies before saying it applied them.
  let lines = 0;
  let got!: () => void;
  const three = new Promise<void>((r) => (got = r));
  const socket = await Bun.connect({
    unix: join(dir, "sock"),
    socket: {
      data(_s, chunk) {
        lines += new TextDecoder().decode(chunk).split("\n").length - 1;
        if (lines >= 3) got();
      },
    },
  });
  await within(three, 10_000, "three lines");
  socket.end();
  const next = await HostLink.connect(dir);
  expect(await applyInits(next, 3)).toEqual(["m1", "m2", "m3"]);
  // Once applied and acknowledged, they're the host's no more.
  await Bun.sleep(600);
  await next.detach();
  const last = await HostLink.connect(dir);
  await fake.go();
  expect(await applyInits(last, 3)).toEqual(["m4", "m5", "m6"]);
  last.send(zero);
  await untilExit(last);
  await ended(server);
  expect(running(pid)).toBe(false);
}, 30_000);

test("a host waits for a node to take the exit, and no longer than its bound", async () => {
  const fake = new Fake();
  const [dir, , server] = await fake.host("s1", BRIEF_CLAUDE);
  await Bun.sleep(500);
  expect(await Promise.race([server.done.then(() => "done"), Bun.sleep(0).then(() => "waiting")])).toBe("waiting");
  const node = await HostLink.connect(dir);
  expect(await applyInits(node, 1)).toEqual(["m1"]);
  await untilExit(node);
  await ended(server);

  // With no node at all, it waits only so long.
  const [, , alone] = await fake.host("s2", BRIEF_CLAUDE, { ...BOUNDS, lingerMs: 200 });
  await ended(alone);
}, 30_000);

test("a host no node comes back to ends its session", async () => {
  const fake = new Fake();
  const [dir, pid, server] = await fake.host("s1", TALKING_CLAUDE, { ...BOUNDS, aloneMs: 500 });
  // A node that connects, then goes without letting go: the clock starts over from then.
  const node = await HostLink.connect(dir);
  await applyInits(node, 3);
  await Bun.sleep(700);
  expect(running(pid)).toBe(true);
  await node.detach();
  await ended(server);
  expect(running(pid)).toBe(false);
}, 30_000);

test("hosts no node adopts are stopped with their sessions", async () => {
  const fake = new Fake();
  const [keptDir, kept, keptServer] = await fake.host("kept", TALKING_CLAUDE);
  const [orphanDir, orphan, orphanServer] = await fake.host("orphan", TALKING_CLAUDE);
  expect(await sweep(join(fake.dir, "hosts"), new Set(["kept"]))).toBe(1);
  await ended(orphanServer);
  expect(running(orphan)).toBe(false);
  expect(existsSync(orphanDir)).toBe(false);
  expect(running(kept) && existsSync(keptDir)).toBe(true);

  await stop(keptDir);
  await ended(keptServer);
  expect(running(kept)).toBe(false);
  expect(existsSync(keptDir)).toBe(false);
}, 30_000);

test("a host of another protocol is not adopted, nor one whose claude didn't start", async () => {
  const dir = join(root, "protocol");
  mkdirSync(dir);
  const registration = (protocol: number, refused: { message: string; missing: boolean } | null) =>
    register(dir, { protocol, hostPid: process.pid, hostStart: startOf(process.pid) ?? null, pid: 0, start: null, marker: "", refused });
  registration(PROTOCOL + 1, null);
  expect(HostLink.connect(dir)).rejects.toThrow("protocol");
  registration(PROTOCOL, { message: "no claude", missing: true });
  expect(HostLink.connect(dir)).rejects.toThrow("no claude");
});

test("a host in a deep home still answers", async () => {
  const fake = new Fake();
  const [dir, pid, server] = await fake.host(`deep-${"d".repeat(120)}`, BRIEF_CLAUDE);
  expect(join(dir, "sock").length).toBeGreaterThan(108);
  const node = await HostLink.connect(dir);
  expect(node.pid).toBe(pid);
  expect(await applyInits(node, 1)).toEqual(["m1"]);
  await untilExit(node);
  await ended(server);
}, 30_000);

// A host the Rust build started before the switch: its sessions run on, and the TypeScript node adopts them as its own.
// FLEETD_RUST_HOST names the Rust binary, else a kept `fleetd-session-host`; without one the test is skipped.
const rust = [process.env.FLEETD_RUST_HOST, join(process.env.HOME ?? "", ".fleetd/bin/fleetd-session-host")].find((p) => p && existsSync(p));
test.skipIf(!rust)("a host the Rust build started is adopted by this node, and ends as one of its own", async () => {
  const fake = new Fake();
  const program = join(fake.dir, "claude-rust");
  writeFileSync(program, TALKING_CLAUDE);
  chmodSync(program, 0o755);
  const dir = fake.hostDir("rust");
  const mark = marker("host-test-rust");
  const proc = Bun.spawn([rust!, "session-host", dir, "rust", "--", program, join(fake.dir, "go")], {
    env: { PATH: "/usr/bin:/bin", FLEETD_RUNNER_SESSION: mark },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    for (let i = 0; !readRegistration(dir) && i < 500; i++) await Bun.sleep(10);
    const registration = readRegistration(dir)!;
    expect(registration).toMatchObject({ protocol: PROTOCOL, hostPid: proc.pid, marker: mark, refused: null });
    // A node before the restart.
    const first = await HostLink.connect(dir);
    expect(await applyInits(first, 3)).toEqual(["m1", "m2", "m3"]);
    await first.detach();
    await fake.go();
    // This node, after it: it takes the session on where the last one let go, commands included.
    const second = await HostLink.connect(dir);
    expect(second.pid).toBe(registration.pid);
    expect(await applyInits(second, 3)).toEqual(["m4", "m5", "m6"]);
    second.send(zero);
    await untilExit(second);
    expect(await within(proc.exited, 15_000, "the Rust host ended")).toBe(0);
    expect(running(registration.pid)).toBe(false);
  } finally {
    proc.kill("SIGKILL");
  }
}, 30_000);
