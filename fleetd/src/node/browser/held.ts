// A node's Chrome that outlives the node: an update or a restart (several an hour on a busy day) no longer ends every
// agent's browser session on the machine. It runs as a box's Chrome does (../place/box_chrome.ts), with this machine as
// the box: its pipe on two FIFOs a launcher holds open, socat handing each connection on a port of the loopback to
// them, in a process session and (where systemd answers) a scope of its own that the node's unit doesn't stop
// (../runner/scope.ts). Its folder is under `browser/held/` in the node's home, out of the orphan sweep's reach.
//
// The broker keeps each held session's snapshot there, sealed to the node's box key, whenever what it holds changes
// and as the node stops; the next node takes each one over (BrowserBroker `adopt`) and the agent goes on in the same
// browser, signed in as it was. One no node dials again within GRACE_MS goes by itself, its launcher's whole session
// with it; the next node clears what it left.
//
// The port is on the machine's shared loopback, where another held Chrome's socat may wait for its next node, or
// anything else may listen. So a connection counts only once the Chrome that answers proves it is the folder's own:
// its browser process runs in the process session of that folder's launcher (`proven`). Anything else is dropped before
// a command of the session's goes to it, and a launch that met one tries again on another port.
//
// Linux only, where socat and mkfifo are on the PATH: the proof reads a process's session from /proc, and systemd's
// scope is what keeps the launcher past the node's stop. Elsewhere (a Mac, a bare Linux), the node's Chrome runs on its
// own pipe as before, and its sessions end as the node stops, the agent told why.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { agentSpawn } from "../oom.ts";
import { boxChrome, hex, type KeptBox } from "../place/box_chrome.ts";
import { current as currentScope, hostScope, spawnScoped } from "../runner/scope.ts";
import type { Ended } from "./broker.ts";
import type { Launched } from "./launch_args.ts";

/** How long a held Chrome waits for the next node once the last one let go: a restart takes some 15 s. */
export const GRACE_MS = 120_000;
/** The sealed snapshot in a held Chrome's folder. */
const SNAPSHOT = "snapshot.sealed";

export const heldRoot = (home: string) => join(home, "browser", "held");

/** Whether this machine can hold a Chrome past the node: Linux, with socat and mkfifo on its PATH. */
export const canHold = (platform: string = process.platform) => platform === "linux" && Bun.which("socat") !== null && Bun.which("mkfifo") !== null;

/** This machine as a box (box_chrome.ts's): its commands, files and loopback. */
export const localBox: KeptBox = {
  run: async ({ argv, cwd, env, timeoutSec }) => {
    const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutSec * 1000);
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return { exitCode: code, outputTail: `${out}${err}`.slice(-4000), timedOut: child.signalCode === "SIGKILL" };
  },
  write: async (path, bytes, mode = 0o600) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode });
  },
  read: async (path, max) => new Uint8Array(readFileSync(path).subarray(0, max)),
  dial: (host, port) =>
    new Promise<Duplex>((resolve, reject) => {
      const s = connect(port, host);
      s.once("connect", () => resolve(s)).once("error", reject);
    }),
};

/** Starts a held Chrome's launcher `script` in a process session of its own, at the agents' OOM score, in a scope the
 * node's unit doesn't stop where systemd answers; its pid (its session's id) goes to `pidFile`. */
async function startOutside(script: string, pidFile: string): Promise<ChildProcess> {
  const scope = await currentScope();
  const dir = dirname(script);
  const { child } = await spawnScoped(scope && hostScope(scope), "/bin/sh", [script], `browser ${basename(dir)}`, (program, argv, s) =>
    spawn(...agentSpawn(program, argv), { cwd: "/", env: { ...process.env, ...s?.env, TMPDIR: join(dir, "tmp") }, stdio: "ignore", detached: true }),
  );
  child.unref();
  if (child.pid === undefined) throw new Error("its launcher didn't start");
  writeFileSync(pidFile, `${child.pid}\n`);
  return child;
}

/** A fresh Chrome held past the node, on a throwaway profile in its folder under `home`, with Chrome's sandbox when
 * `sandboxed`, and `extra` flags. */
export async function launchHeld(home: string, chrome: string, sandboxed: boolean, extra: string[] = []): Promise<Launched> {
  for (let tries = 1; ; tries++) {
    try {
      return await launchOnce(home, chrome, sandboxed, extra);
    } catch (e) {
      if (!(e instanceof NotItsOwn) || tries >= 3) throw e;
    }
  }
}

async function launchOnce(home: string, chrome: string, sandboxed: boolean, extra: string[]): Promise<Launched> {
  const dir = join(heldRoot(home), `chrome-${hex(6)}`);
  mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
  // A Chrome that exits at once (its sandbox refused here) takes its launcher with it: said now, not after the dial's
  // wait, so the pool goes on without the sandbox.
  let exited = () => {};
  const gone = new Promise<never>((_, reject) => {
    exited = () => {
      let said = "";
      try {
        said = readFileSync(join(dir, "chrome.log"), "utf8").trim().slice(-600);
      } catch {}
      reject(new Error(`Chrome exited as it started${said ? `: ${said}` : ""}`));
    };
  });
  gone.catch(() => {});
  const start = async (script: string, pidFile: string) => void (await startOutside(script, pidFile)).once("exit", () => exited());
  const launched = boxChrome(localBox, extra, { dir, chrome, sandboxed, graceMs: GRACE_MS, start });
  launched.catch(() => {});
  const up = await Promise.race([launched, gone]);
  try {
    return await proven(up, dir);
  } catch (e) {
    dropHeld(dir);
    throw e;
  }
}

/** A connection that reached a Chrome other than its folder's own. */
export class NotItsOwn extends Error {
  constructor() {
    super("another browser answered on its port");
  }
}

/** The process session of process `pid`, from `/proc`; undefined where it can't be read (nothing holds a Chrome
 * off Linux: `canHold`). */
function sessionOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid pgrp session …`, and comm may hold a `)`.
    return Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[3]);
  } catch {
    return undefined;
  }
}

/**
 * `launched`, once the Chrome that answered on it proves it is the one held at `dir`: its browser process in the process
 * session of `dir`'s launcher. Any other (another agent's held Chrome, signed in, or anything listening on that port)
 * is dropped before a command of the session's goes to it, and `NotItsOwn` thrown.
 */
export async function proven(launched: Launched, dir: string): Promise<Launched> {
  let browser: number | undefined;
  let launcher = 0;
  try {
    const info = (await launched.cdp.call(undefined, "SystemInfo.getProcessInfo")) as { processInfo?: { type: string; id: number }[] };
    browser = info.processInfo?.find((p) => p.type === "browser")?.id;
    launcher = Number(readFileSync(join(dir, "session.pid"), "utf8").trim());
  } catch {}
  if (browser !== undefined && launcher > 1 && sessionOf(browser) === launcher) return launched;
  launched.cdp.shut();
  throw new NotItsOwn();
}

/** Keeps the snapshot of the session whose Chrome is held at `dir`, sealed, for the next node. */
export function keepSnapshot(dir: string, sealed: Uint8Array): void {
  if (!existsSync(dir)) return;
  const next = join(dir, `${SNAPSHOT}.next`);
  writeFileSync(next, sealed, { mode: 0o600 });
  renameSync(next, join(dir, SNAPSHOT));
}

/** What a node before left held: each Chrome's folder and its sealed snapshot (none: a Chrome no session holds). Read
 * as the node starts, before its pool launches one of its own. */
export function leftHeld(home: string): { dir: string; sealed?: Uint8Array }[] {
  let names: string[];
  try {
    names = readdirSync(heldRoot(home));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const dir = join(heldRoot(home), name);
    try {
      return [{ dir, sealed: new Uint8Array(readFileSync(join(dir, SNAPSHOT))) }];
    } catch {
      return [{ dir }];
    }
  });
}

/** Ends a held Chrome no session takes over: its launcher's whole process session, then its folder. */
export function dropHeld(dir: string): void {
  try {
    const pid = Number(readFileSync(join(dir, "session.pid"), "utf8").trim());
    // Only this launcher's own session, never an empty or zero id, nor a pid the kernel has since given another.
    const ours = readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(dir);
    if (Number.isInteger(pid) && pid > 1 && ours) process.kill(-pid, "SIGKILL");
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

/** How long the next node keeps telling an agent why its session ended. */
const ENDED_KEPT_MS = 24 * 60 * 60_000;
const endedPath = (home: string) => join(home, "browser", "ended.json");

/** Why each agent session's last browser session ended under it, as a node before kept it, a day at most. */
export function readEnded(home: string, now = Date.now()): [string, Ended][] {
  try {
    const kept = JSON.parse(readFileSync(endedPath(home), "utf8")) as Record<string, Ended>;
    return Object.entries(kept).filter(([, e]) => typeof e?.why === "string" && now - Date.parse(e.at) < ENDED_KEPT_MS);
  } catch {
    return [];
  }
}

/** Keeps `ended` for the next node. */
export function writeEnded(home: string, ended: Map<string, Ended>): void {
  try {
    const path = endedPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const kept = [...ended].filter(([, e]) => now - Date.parse(e.at) < ENDED_KEPT_MS);
    writeFileSync(`${path}.next`, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    renameSync(`${path}.next`, path);
  } catch (e) {
    console.warn(`${new Date().toISOString()} WARN why browser sessions ended was not kept {"error":${JSON.stringify((e as Error).message)}}`);
  }
}
