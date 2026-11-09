// The node's side of a session's host. `fleetd session-host <dir> <session id>
// -- <claude> <args…>` (./host/serve.ts, this binary) owns the session's claude, runs the stream mapper, the kill ladder
// and the transcript, and outlives the node. The node starts it detached (a session of its own and, where systemd
// answers, a scope of its own that the node's unit doesn't stop: scope.ts), waits for its registration (`host.json`),
// and talks to its socket (`sock`), one JSON object per line:
// - host → node: `{"seq":n,"event":<RunnerEvent>}`; the host keeps each until acknowledged and resends what it kept;
// - node → host: `{"ack":n}` once the service applied events up to n, `{"command":<SessionCommand>}`, and `"stop"`.
// Hosts the Rust build started speak the same lines and write the same registration, so a node adopts them as its own.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Env } from "../util.ts";
import { agentSpawn } from "../oom.ts";
import { failed as scopeFailed, hostScope, type Scope, spawnScoped } from "./scope.ts";
import { dedupe, descendants, gone, signal, statOf, table, type Proc } from "./procs.ts";

/** Bumped when the lines between a host and a node change incompatibly (host.rs PROTOCOL). */
export const PROTOCOL = 1;
export const COMMAND = "session-host";
const START_TIMEOUT_MS = 10_000;
const ACK_EVERY_MS = 200;
const DRAIN_MS = 5_000;
const CLOSE_MS = 1_000;
const STOP_WAIT_MS = 8_000;

export type Registration = {
  protocol: number;
  hostPid: number;
  hostStart?: number | null;
  pid: number;
  start?: number | null;
  marker: string;
  refused?: { message: string; missing: boolean } | null;
};

export function readRegistration(dir: string): Registration | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as Registration;
  } catch {
    return undefined;
  }
}

/** A process's start time, `/proc/<pid>/stat` field 22; undefined when it's gone or a zombie. */
export function startOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (fields[0] === "Z") return undefined;
    return Number(fields[19]);
  } catch {
    return undefined;
  }
}

function alive(pid: number, start: number | null | undefined): boolean {
  if (pid <= 1) return false;
  if (start !== undefined && start !== null) return startOf(pid) === start;
  if (process.platform === "linux") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const hostAlive = (r: Registration) => alive(r.hostPid, r.hostStart);

/** The marker each process of one spawn carries (process.rs `marker`): the session id plus a nonce. */
let spawns = 0;
export const marker = (session: string) => `${session}.${process.pid}.${(Date.now() * 1e6).toString(16)}.${spawns++}`;

/** Normalized events of one session (runner/mod.rs `RunnerEvent`), as serde writes an externally tagged enum. */
export type RunnerEvent = Record<string, any> | string;
/** Commands to a session's process (`SessionCommand`). */
export type SessionCommand =
  | { Send: { run_id: string; text: string; mode: "plain" | "boundary" | "now" } }
  | { Withdraw: { run_id: string } }
  | "Interrupt"
  | { Answer: { request_id: string; decision: unknown; by: string | null } }
  | { Shutdown: { grace: { secs: number; nanos: number } } };

export const shutdown = (graceMs = 0): SessionCommand => ({
  Shutdown: { grace: { secs: Math.floor(graceMs / 1000), nanos: (graceMs % 1000) * 1e6 } },
});

/** The node's link to one host: events in order, commands out, acknowledgements of what the service applied. */
export class HostLink {
  /** Events the service applied: what the node acknowledges. */
  applied = 0;
  /** The node let go of the host (its shutdown): the events end without an exit, and the session goes on. */
  detached = false;
  #socket: Bun.Socket<undefined> | undefined;
  /** What the socket hasn't taken yet: Bun's sockets don't buffer, so a write past what the kernel takes at once goes
   * when it drains (a long message, a pasted image, went cut otherwise). */
  #out: Uint8Array | undefined;
  #buf = "";
  #handed: number[] = [];
  #acked = 0;
  #last = 0;
  #ended = false;
  #exitSeen = false;
  #queue: RunnerEvent[] = [];
  #waiter: ((e: RunnerEvent | undefined) => void) | undefined;
  #ticker: ReturnType<typeof setInterval> | undefined;
  #closed: Promise<void>;
  #closedResolve!: () => void;

  private constructor(readonly registration: Registration) {
    this.#closed = new Promise((r) => (this.#closedResolve = r));
  }

  /** Connects to the host in `dir`: its events start with every one it kept. Refused for another PROTOCOL. */
  static async connect(dir: string): Promise<HostLink> {
    const registration = readRegistration(dir);
    if (!registration) throw new Error("no registration");
    if (registration.protocol !== PROTOCOL) throw new Error(`it speaks protocol ${registration.protocol}, this node ${PROTOCOL}`);
    if (registration.refused) throw new Error(registration.refused.message);
    const link = new HostLink(registration);
    // One decoder for the connection, streaming: a character split across two reads comes out whole.
    const decoder = new TextDecoder();
    link.#socket = await dialSocket(dir, {
      data: (_s, chunk) => link.#data(decoder.decode(chunk, { stream: true })),
      drain: () => link.#flush(),
      close: () => link.#gone(),
      error: () => link.#gone(),
    });
    link.#ticker = setInterval(() => link.#ack(), ACK_EVERY_MS);
    return link;
  }

  get pid(): number {
    return this.registration.pid;
  }

  #data(text: string): void {
    this.#buf += text;
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      let parsed: { seq: number; event: RunnerEvent };
      try {
        parsed = JSON.parse(line);
      } catch {
        this.#gone();
        return;
      }
      if (parsed.seq <= this.#last) continue;
      this.#last = parsed.seq;
      if (typeof parsed.event === "object" && "Exited" in parsed.event) this.#exitSeen = true;
      this.#handed.push(parsed.seq);
      this.#push(parsed.event);
    }
  }

  #push(event: RunnerEvent | undefined): void {
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter(event);
    } else if (event !== undefined) this.#queue.push(event);
  }

  #gone(): void {
    if (this.#ended) return;
    this.#ended = true;
    clearInterval(this.#ticker);
    this.#closedResolve();
    if (!this.detached && !this.#exitSeen) killTree(this.registration);
    this.#push(undefined);
  }

  /** The next event; undefined once the host went away (or the node let go of it). */
  next(): Promise<RunnerEvent | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve) => (this.#waiter = resolve));
  }

  #write(line: unknown): boolean {
    if (this.#ended || !this.#socket) return false;
    const bytes = new TextEncoder().encode(`${JSON.stringify(line)}\n`);
    this.#out = this.#out ? Buffer.concat([this.#out, bytes]) : bytes;
    this.#flush();
    return true;
  }

  #flush(): void {
    const out = this.#out;
    if (!out || !this.#socket) return;
    const wrote = this.#socket.write(out);
    this.#out = wrote < 0 || wrote >= out.length ? undefined : out.subarray(wrote);
  }

  send(command: SessionCommand): boolean {
    return this.#write({ command });
  }

  #ack(): void {
    let upto: number | undefined;
    while (this.#acked < this.applied && this.#handed.length) {
      upto = this.#handed.shift();
      this.#acked++;
    }
    if (upto !== undefined) this.#write({ ack: upto });
  }

  /** Lets go of the host without ending its session, once the service applied what it was handed. */
  async detach(): Promise<void> {
    if (this.#ended) return;
    this.detached = true;
    const total = this.#acked + this.#handed.length;
    const deadline = Date.now() + DRAIN_MS;
    while (this.applied < total && Date.now() < deadline) await Bun.sleep(10);
    this.#ack();
    while (this.#out && Date.now() < deadline) await Bun.sleep(10);
    this.#socket?.end();
    await Promise.race([this.#closed, Bun.sleep(CLOSE_MS)]);
    this.#gone();
  }
}

const socketPath = (dir: string) => join(dir, "sock");

/** Connects to the socket in `dir` however deep the node's home: on Linux, through an open fd of the dir when its own
 * path is too long for a socket address (host.rs `at_socket`). */
async function dialSocket(dir: string, handlers: Bun.SocketHandler<undefined>): Promise<Bun.Socket<undefined>> {
  const path = socketPath(dir);
  if (path.length < 100 || process.platform !== "linux") return Bun.connect({ unix: path, socket: handlers });
  const fd = openSync(dir, "r");
  try {
    return await Bun.connect({ unix: `/proc/self/fd/${fd}/sock`, socket: handlers });
  } finally {
    closeSync(fd);
  }
}

/** What launch needs: claude's command and everything it runs with. */
export type Launch = {
  /** The command that runs fleetd (the node's pinned binary, or Bun with its entry from source): it runs the host. */
  fleetd: string[];
  dir: string;
  sessionId: string;
  program: string;
  args: string[];
  cwd: string;
  env: Env;
  /** This machine's scope (scope.ts `current`), when systemd answers. */
  scope?: Scope;
};

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly refused?: { message: string; missing: boolean },
  ) {
    super(message);
  }
}

/**
 * Starts a session's host detached from the node (a session and, with `scope`, a scope of its own that the node's unit
 * doesn't stop) and connects to it once it registered.
 */
export async function launch(l: Launch): Promise<HostLink> {
  prepare(l.dir);
  const log = openSync(join(l.dir, "host.log"), "w");
  let child: ChildProcess;
  try {
    child = await startHost(l, log);
  } catch (error) {
    closeSync(log);
    throw new LaunchError(`no host came up: it didn't start: ${(error as Error).message}`);
  }
  closeSync(log);
  let exited: string | undefined;
  child.on("exit", (code, signal) => (exited = `it exited at once (${signal ?? `exit status: ${code}`})`));
  child.on("error", (e) => (exited = `it didn't start: ${e.message}`));
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let registration: Registration | undefined;
  while (!(registration = readRegistration(l.dir))) {
    if (exited) throw new LaunchError(`no host came up: ${exited}`);
    if (Date.now() >= deadline) {
      child.kill("SIGKILL");
      throw new LaunchError(`no host came up: it hadn't started claude after ${START_TIMEOUT_MS / 1000} s`);
    }
    await Bun.sleep(2);
  }
  if (registration.refused) throw new LaunchError(registration.refused.message, registration.refused);
  try {
    return await HostLink.connect(l.dir);
  } catch (error) {
    throw new LaunchError(`no host came up: it doesn't answer: ${(error as Error).message}`);
  }
}

/**
 * The host's process, its stderr to `log`: detached (a session of its own), at the agents' OOM score, and in a scope of
 * its own that isn't `PartOf=` the node's unit when `l.scope` works, else without one (scope.ts says so once).
 */
export async function startHost(l: Launch, log: number): Promise<ChildProcess> {
  const started = await spawnScoped(
    l.scope && hostScope(l.scope),
    l.fleetd[0]!,
    [...l.fleetd.slice(1), COMMAND, l.dir, l.sessionId, "--", l.program, ...l.args],
    l.sessionId,
    (program, argv, scope) =>
      // A session's whole tree goes before the node and the hub when memory runs out.
      spawn(...agentSpawn(program, argv), {
        cwd: l.cwd,
        env: { ...l.env, ...scope?.env },
        stdio: ["ignore", "ignore", log],
        // A session of its own: no signal for the node's group or terminal reaches it.
        detached: true,
      }),
  );
  if (started.failed !== undefined) scopeFailed(started.failed);
  return started.child;
}

/** Makes `dir` empty and private, stopping a host a previous spawn of the session left there. */
function prepare(dir: string): void {
  const left = readRegistration(dir);
  if (left && hostAlive(left)) killTree(left);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

/** Ends the host in `dir` and its session, then removes the dir. */
export async function stop(dir: string): Promise<void> {
  const registration = readRegistration(dir);
  if (existsSync(socketPath(dir))) {
    let closed!: () => void;
    const done = new Promise<void>((r) => (closed = r));
    try {
      const socket = await dialSocket(dir, { data() {}, close: () => closed(), error: () => closed() });
      socket.write('"stop"\n');
      await Promise.race([done, Bun.sleep(STOP_WAIT_MS)]);
      socket.end();
    } catch {}
  }
  if (registration) killTree(registration);
  rmSync(dir, { recursive: true, force: true });
}

/** Where the host in `dir` records the orphans its session leaves it: beside the dir, which the session's next host
 * starts afresh, so the record holds every host's of the session until its task ends (endLeft). */
export const leftFile = (dir: string) => `${dir}.left`;

/** The session's task ended: SIGKILLs what its hosts recorded its tree left behind (by pid and start time, whatever
 * scope or environment it has now) and everything those started, and forgets the record. Never between the session's
 * turns, which may leave a browser or a server running on purpose. How many processes it ended. */
export async function endLeft(dir: string): Promise<number> {
  const file = leftFile(dir);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  const roots: Proc[] = [];
  for (const line of text.split("\n")) {
    const [pid, start] = line.trim().split(" ").map(Number);
    const p = pid !== undefined && pid > 1 ? statOf(pid) : undefined;
    if (p && !p.zombie && p.start === start) roots.push(p);
  }
  const procs = roots.length ? table() : [];
  const found = dedupe([...roots, ...roots.flatMap((r) => descendants(procs, r.pid))]);
  signal(found, "SIGKILL");
  await gone(found, STOP_WAIT_MS);
  rmSync(file, { force: true });
  return found.length;
}

/** Every pid whose environment carries `marker` (Linux). */
function marked(markerValue: string): number[] {
  if (process.platform !== "linux" || !markerValue) return [];
  const want = `FLEETD_RUNNER_SESSION=${markerValue}`;
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${name}/environ`, "latin1").split("\0").includes(want)) found.push(Number(name));
    } catch {}
  }
  return found;
}

/** SIGKILLs what's left of a host: claude's group, every process carrying the spawn's marker, and the host. */
export function killTree(r: Registration): void {
  const kill = (pid: number, group = false) => {
    if (pid <= 1 || pid === process.pid) return;
    try {
      process.kill(group ? -pid : pid, "SIGKILL");
    } catch {}
  };
  if (r.pid && alive(r.pid, r.start)) kill(r.pid, true);
  for (const pid of marked(r.marker)) if (pid !== r.hostPid) kill(pid);
  if (r.pid && alive(r.pid, r.start)) kill(r.pid);
  if (hostAlive(r)) kill(r.hostPid);
}

/** Stops every host in `hosts` but those of `keep`, and removes their dirs. How many were still running. */
export async function sweep(hosts: string, keep: Set<string>): Promise<number> {
  if (!existsSync(hosts)) return 0;
  let stopped = 0;
  for (const name of readdirSync(hosts)) {
    const dir = join(hosts, name);
    if (keep.has(name) || !statSync(dir).isDirectory()) continue;
    const r = readRegistration(dir);
    if (r && hostAlive(r)) stopped++;
    await stop(dir);
  }
  return stopped;
}

/** A random hex id. */
export const newId = () => randomBytes(16).toString("hex");
