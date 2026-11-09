// Each session's host in a transient systemd scope of its own (crates/fleetd/src/node/runner/scope.rs), on Linux when
// the user's systemd manager answers. Without one a host shares the node's cgroup, and the node unit's stop
// (KillMode=mixed) kills it, and its agent, with the node: an update or a restart cut every agent off mid-step. In a
// scope of its own a host outlives the node, and the next node re-adopts it. One build the kernel kills for memory
// also lands in that one scope, which has `OOMPolicy=continue`, rather than failing the node's whole unit.
//
// `systemd-run --scope` moves itself into the new scope and then execs the command, so the host keeps the pid and the
// session the node gave it. A scope never fails a session: when systemd-run doesn't start the host, the session starts
// again without one (`spawnScoped`), scopes stay off until the next check (`RECHECK_MS`), and the node says so once.
// Without a user manager (macOS, a container, a node started by hand outside a login session) sessions start in the
// node's own cgroup.
import { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { nowIso } from "../util.ts";

/** systemd-run reaches the user manager through these, and a session's environment starts empty. */
const BUS_VARS = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;
/** How long a probe may take before the node counts scopes as unavailable. */
const PROBE_TIMEOUT_MS = 5_000;
/** How long systemd-run may take to set up a session's scope and exec the host before the session starts without one. */
export const START_TIMEOUT_MS = 5_000;
/** While scopes are off, how often the node checks again whether they work. */
export const RECHECK_MS = 10 * 60_000;

/** How to start a session in a scope of its own on this machine. */
export type Scope = {
  /** `systemd-run`, as found on the node's PATH. */
  program: string;
  /**
   * The node's own unit when it runs as one (`fleetd-node.service`). A scope `PartOf=` it stops with the node; a
   * session host's scope (`hostScope`) is not, so it outlives the node.
   */
  nodeUnit?: string;
  /** `OOMPolicy=continue` on the scope; an older systemd that can't set it on a scope still gets a scope. */
  oomContinue: boolean;
  /** The node's `BUS_VARS`, added to the session's environment. */
  env: Record<string, string>;
};

/** A session host's scope: not `PartOf=` the node's unit, so stopping or restarting the node leaves the session running. */
export const hostScope = (scope: Scope): Scope => ({ program: scope.program, oomContinue: scope.oomContinue, env: scope.env });

/** `systemd-run`'s own arguments, up to and including the `--` before the command. */
function scopeArgs(scope: Scope, sessionId: string): string[] {
  const args = ["--user", "--scope", "--collect", "--quiet", `--description=fleetd agent ${sessionId}`];
  if (scope.oomContinue) args.push("--property=OOMPolicy=continue");
  if (scope.nodeUnit !== undefined) args.push(`--property=PartOf=${scope.nodeUnit}`, `--property=Before=${scope.nodeUnit}`);
  args.push("--");
  return args;
}

/** The program and argv that start `binary args…` for a session: as is, or through `systemd-run` in a scope of its own. */
export function command(binary: string, args: string[], scope: Scope | undefined, sessionId: string): [string, string[]] {
  if (!scope) return [binary, args];
  return [scope.program, [...scopeArgs(scope, sessionId), binary, ...args]];
}

/** Makes the child for a program, its argv and the scope used (its `env` goes into the child's environment). */
export type Build = (program: string, argv: string[], scope: Scope | undefined) => ChildProcess;

/**
 * Starts a session's process with the child `build` makes: through `scope` when there is one, and again without it when
 * systemd-run didn't start `binary` (it couldn't be run, exited, or hadn't exec'd within `timeoutMs`). Returns the
 * child and, after such a fallback, why the scope failed.
 */
export async function spawnScoped(
  scope: Scope | undefined,
  binary: string,
  args: string[],
  sessionId: string,
  build: Build,
  timeoutMs = START_TIMEOUT_MS,
): Promise<{ child: ChildProcess; failed?: string }> {
  let failed: string | undefined;
  if (scope) {
    const [program, argv] = command(binary, args, scope, sessionId);
    if (!existsSync(program)) failed = `systemd-run could not be run: ${program} is gone`;
    else {
      const spawner = readComm("thread-self");
      const child = build(program, argv, scope);
      const why = await execOf(child, binary, spawner, timeoutMs);
      if (why === undefined) return { child };
      child.kill("SIGKILL");
      failed = why;
    }
  }
  const [program, argv] = command(binary, args, undefined, sessionId);
  return { child: build(program, argv, undefined), ...(failed !== undefined ? { failed } : {}) };
}

const readComm = (pid: number | string) => {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8");
  } catch {
    return "";
  }
};

/**
 * Waits until `child`, systemd-run started from a thread named `spawner`, has set up its scope and exec'd `binary`:
 * undefined then, else why not. systemd-run moves itself into the new scope and only then execs, so a child in a scope
 * the node isn't in is handed over; so is one whose `/proc/<pid>/exe` is `binary` already, and a zombie (no exe left)
 * whose last `comm` is binary's, so a command that ran and exited at once still counts as started.
 */
async function execOf(child: ChildProcess, binary: string, spawner: string, timeoutMs: number): Promise<string | undefined> {
  let error: string | undefined;
  let status: string | undefined;
  child.once("error", (e) => (error = e.message));
  child.once("exit", (code, signal) => (status = signal ? `signal: ${signal}` : `exit status: ${code}`));
  // Bun's spawn reports a program it couldn't run on the next tick, with no pid.
  await Bun.sleep(0);
  const pid = child.pid;
  if (error !== undefined || pid === undefined) return `systemd-run could not be run: ${error ?? "no pid"}`;
  let target = binary;
  try {
    target = realpathSync(binary);
  } catch {}
  const own = readCgroup("self");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Whether it exited, then what it runs: a zombie's name is final, but one read first may predate an exec right
    // before the exit.
    const gone = exited(pid);
    if (inScope(readCgroup(pid), own) || handedOver(readExe(pid), readComm(pid), target, spawner)) return undefined;
    if (gone || status !== undefined) return status !== undefined ? `systemd-run ${status}` : "systemd-run exited";
    if (Date.now() >= deadline) return `systemd-run had not started the session after ${timeoutMs / 1000} s`;
    await Bun.sleep(2);
  }
}

/** Whether process `pid` has exited, from `/proc/<pid>/stat`, without reaping it. One that's gone counts. */
function exited(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return true;
  }
  // `pid (comm) state …`, and comm may hold a `)`.
  const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
  return state === "Z" || state === "X";
}

const readCgroup = (pid: number | string) => {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return "";
  }
};

/** Whether a process whose cgroup file reads `cgroup` sits in a scope that the node, reading `own`, isn't in. */
export function inScope(cgroup: string, own: string): boolean {
  const path = (c: string) => c.split("\n").find((l) => l.startsWith("0::"))?.slice(3) ?? "";
  const mine = path(cgroup);
  return mine.endsWith(".scope") && mine !== path(own);
}

const readExe = (pid: number) => {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return "";
  }
};

/**
 * Whether a child whose `/proc` reads `exe` and `comm` has exec'd `target` (a real path): its exe is it, or, once its
 * exe is gone (a zombie), its name is target's (the kernel keeps 15 bytes) and not `spawner`'s, which a child reads as
 * right after a spawn. Before the exec it runs the agent wrapper's shell (oom.ts) or systemd-run.
 */
export function handedOver(exe: string, comm: string, target: string, spawner: string): boolean {
  if (exe !== "") return exe === target;
  const c = comm.trimEnd();
  return c !== "" && c === basename(target).slice(0, 15) && c !== spawner.trimEnd();
}

/**
 * The unit the node runs as in its user manager, from `/proc/self/cgroup`'s cgroup v2 line, e.g.
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node.service`. Undefined outside a user manager's
 * service: a system unit can't be named from a `--user` scope.
 */
export function ownUnit(cgroup: string): string | undefined {
  const path = cgroup
    .split("\n")
    .find((l) => l.startsWith("0::"))
    ?.slice(3);
  if (path === undefined) return undefined;
  const parts = path.split("/");
  const manager = parts.findIndex((p) => p.startsWith("user@") && p.endsWith(".service"));
  if (manager < 0) return undefined;
  const last = parts.at(-1);
  return parts.length - 1 > manager && last?.endsWith(".service") ? last : undefined;
}

/** Whether scopes work here, as of when the node last checked. */
export type Probed = { scope?: Scope; at: number; checking: boolean };

/** Scopes are off and were last checked `RECHECK_MS` ago or more: check again. */
export const due = (p: Probed, now: number) => p.scope === undefined && !p.checking && now - p.at >= RECHECK_MS;

let probed: Probed | undefined;
let first: Promise<Scope | undefined> | undefined;

/**
 * This machine's way to scope sessions: `systemd-run --user --scope` must actually start a command. The first call
 * probes (the node starts one at its start). While scopes are off, a call `RECHECK_MS` after the last check starts a
 * new one in the background.
 */
export async function current(): Promise<Scope | undefined> {
  if (!probed) {
    first ??= probe().then((scope) => {
      log(undefined, scope, "");
      probed = { ...(scope ? { scope } : {}), at: Date.now(), checking: false };
      return scope;
    });
    return first;
  }
  if (due(probed, Date.now())) {
    probed.checking = true;
    void probe().then((scope) => settle(scope, ""));
    return undefined;
  }
  return probed.scope;
}

/** systemd-run didn't start a session (`why`): sessions start without a scope until the next check. */
export function failed(why: string): void {
  settle(undefined, why);
}

function settle(scope: Scope | undefined, why: string): void {
  log(probed?.scope, scope, why);
  probed = { ...(scope ? { scope } : {}), at: Date.now(), checking: false };
}

/** For tests: forgets what the probe found, or sets it. */
export function resetForTest(scope?: Scope): void {
  first = undefined;
  probed = scope ? { scope, at: Date.now(), checking: false } : undefined;
}

/** Says so when scopes come or go, once each time. */
function log(before: Scope | undefined, now: Scope | undefined, why: string): void {
  if (!before && now) {
    console.log(
      `${nowIso()} INFO each session runs in a systemd scope of its own {"nodeUnit":${JSON.stringify(now.nodeUnit ?? null)},"oomContinue":${now.oomContinue}}`,
    );
  } else if (before && !now) {
    console.warn(`${nowIso()} WARN sessions start without a systemd scope until the next check in ${RECHECK_MS / 60_000} min: ${why}`);
  }
}

async function probe(): Promise<Scope | undefined> {
  if (process.platform !== "linux") return undefined;
  const program = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "")
    .map((d) => join(d, "systemd-run"))
    .find((bin) => existsSync(bin));
  if (!program) return undefined;
  const env: Record<string, string> = {};
  for (const k of BUS_VARS) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  let nodeUnit: string | undefined;
  try {
    nodeUnit = ownUnit(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {}
  // An older systemd may refuse a property on a scope: the most it takes wins, and a bare scope still keeps the node
  // alive.
  const tries: Scope[] = [];
  for (const oomContinue of [true, false]) {
    if (nodeUnit !== undefined) tries.push({ program, nodeUnit, oomContinue, env });
    tries.push({ program, oomContinue, env });
  }
  for (const scope of tries) if (await starts(scope)) return scope;
  return undefined;
}

/** Whether `systemd-run` starts `true` in a scope as `scope` would start a session, within `PROBE_TIMEOUT_MS`. */
async function starts(scope: Scope): Promise<boolean> {
  const [program, args] = command("true", [], scope, "probe");
  try {
    const proc = Bun.spawn([program, ...args], {
      env: { ...(process.env.PATH !== undefined ? { PATH: process.env.PATH } : {}), ...scope.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0 && proc.signalCode === null;
  } catch {
    return false;
  }
}
