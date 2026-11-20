// The node's side of a session's host. `fleetd session-host <dir> <session id>
// -- <claude> <args…>` (./host/serve.ts, this binary) owns the session's claude, runs the stream mapper, the kill ladder
// and the transcript, and outlives the node. The node starts it detached (a session of its own and, where systemd
// answers, a scope of its own that the node's unit doesn't stop: scope.ts), waits for its registration (`host.json`),
// and talks to its socket (`sock`) in the lines of ./host_link.ts.
// Hosts the Rust build started speak the same lines and write the same registration, so a node adopts them as its own.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Env } from "../util.ts";
import { agentSpawn } from "../oom.ts";
import { failed as scopeFailed, hostScope, type Scope, spawnScoped } from "./scope.ts";
import { dedupe, descendants, gone, signal, statOf, table, type Proc } from "./procs.ts";
import { destroyBox } from "../place/left_vm.ts";
import { HostLink as Link, type HostDial, type Registration } from "./host_link.ts";

export { PROTOCOL, shutdown, type HostDial, type HostHandlers, type HostSocket, type Numbered, type Refusal, type Registration, type RunnerEvent, type SessionCommand } from "./host_link.ts";

export const COMMAND = "session-host";
const START_TIMEOUT_MS = 10_000;
const STOP_WAIT_MS = 8_000;

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

/** The node's link to the host in `dir` (./host_link.ts): its own socket and registration, unless a host in a box
 * comes with its own `dial` (../sandbox/box.ts dialHost) and `registration`. What a dropped link leaves of the host
 * is killed. */
export type HostLink = Link;
export const HostLink = {
  async connect(dir: string, o: { dial?: HostDial; registration?: Registration } = {}): Promise<HostLink> {
    const registration = o.registration ?? readRegistration(dir);
    if (!registration) throw new Error("no registration");
    return Link.open({ registration, dial: o.dial ?? ((h) => dialSocket(dir, h)), lost: killTree });
  },
};

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
  await prepare(l.dir);
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

/** Makes `dir` empty and private, stopping a host (or a box: ../place/left_vm.ts) a previous spawn of the session
 * left there. */
export async function prepare(dir: string): Promise<void> {
  const left = readRegistration(dir);
  if (left && hostAlive(left)) killTree(left);
  await destroyBox(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

/** Ends the host in `dir` and its session, and the box it ran in if any, then removes the dir. */
export async function stop(dir: string): Promise<void> {
  // A hosted session's box (node/place/hosted.ts), loaded only where one is recorded.
  if (existsSync(join(dir, "place.json"))) await (await import("../place/hosted.ts")).destroyHosted(dir);
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
  await destroyBox(dir);
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
