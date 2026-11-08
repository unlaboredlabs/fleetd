// A session's display, and the warm pool of them (crates/fleetd/src/node/desktop/display.rs). Each is an X server of
// its own with a random MIT cookie, so only the node and the session's apps can reach it:
//
// - container: a fresh container of the pinned image (container.ts) runs Xvfb and a window manager; its X socket comes
//   out through a bind-mounted directory, and apps launched in it see nothing of the host but the session's worktree,
//   read-only. `docker rm -f` throws it away.
// - xvfb: an Xvfb on the host on a free display number (`-nolisten tcp -nolisten local`, so only its socket file), and
//   apps launched as the node's user with a fresh home directory in the display's own folder, which goes with them.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Runtime } from "./container.ts";
import { NAME_PREFIX } from "./container.ts";
import { onPath, SIZE } from "./paths.ts";
import type { Launched, Lent } from "./screen.ts";
import { CONNECT_TIMEOUT, X } from "./x11.ts";

/** Window managers the xvfb backend starts when the host has one, first found first. */
const WINDOW_MANAGERS = ["openbox", "xfwm4", "fluxbox", "twm"];

export type Backend = "container" | "xvfb";

/** How the pool makes displays. */
export type Settings = {
  backend: Backend;
  /** The container runtime, for `container`. */
  runtime?: Runtime;
  image: string;
  /** The Xvfb, for `xvfb`. */
  xvfb?: string;
  /** Where each display keeps its folder: cookie, sockets, home, logs. */
  root: string;
  /** Where X servers on the host put their sockets (`/tmp/.X11-unix`), and their lock files (`/tmp`): a test's own. */
  x11Dir?: string;
  lockDir?: string;
  /** The window managers to look for, by name on the PATH or by path: a test's own. */
  windowManagers?: string[];
};

const x11Dir = (s: Settings) => s.x11Dir ?? "/tmp/.X11-unix";
const lockDir = (s: Settings) => s.lockDir ?? "/tmp";

/** An X authority file naming `cookie` for any display on any host (FamilyWild). */
export function xauth(cookie: Uint8Array): Uint8Array {
  const parts: number[] = [0xff, 0xff];
  for (const field of [new Uint8Array(0), new Uint8Array(0), new TextEncoder().encode("MIT-MAGIC-COOKIE-1"), cookie]) {
    parts.push(field.length >> 8, field.length & 0xff, ...field);
  }
  return new Uint8Array(parts);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The end of a log, for a refusal. */
export function tail(path: string, max: number): string {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {}
  return (text.length > max ? text.slice(text.length - max) : text).trim();
}

/** Waits for the X server behind `socket` to answer, while `alive` says it still runs (throws why it doesn't). */
async function waitX(socket: string, cookie: Uint8Array, alive: () => Promise<void> | void): Promise<void> {
  const deadline = Date.now() + CONNECT_TIMEOUT;
  for (;;) {
    await alive();
    if (existsSync(socket)) {
      try {
        (await X.connect(socket, cookie)).close();
        return;
      } catch {}
    }
    if (Date.now() > deadline) throw new Error(`its X server did not answer within ${CONNECT_TIMEOUT / 1000} s`);
    await Bun.sleep(25);
  }
}

const lockFile = (s: Settings, n: number) => join(lockDir(s), `.X${n}-lock`);

/** The pid an X server's lock file names; undefined when there is no lock or it can't be read. */
function lockPid(s: Settings, n: number): number | undefined {
  try {
    const pid = Number(readFileSync(lockFile(s, n), "utf8").trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** An Xvfb killed leaves its lock and socket, which kept its number taken for good. Once it is reaped they go, while
 * the lock is still its own. */
function forgetKilled(s: Settings, n: number, pid: number): void {
  if (lockPid(s, n) !== pid) return;
  for (const f of [join(x11Dir(s), `X${n}`), lockFile(s, n)]) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as { code?: string }).code === "ESRCH";
  }
};

/** Whether display number `n` is free on the host: no lock file and no socket, or a lock left by an X server that is
 * gone (one killed leaves both behind, and Xvfb takes such a number over). */
function isFree(s: Settings, n: number): boolean {
  if (!existsSync(lockFile(s, n))) return !existsSync(join(x11Dir(s), `X${n}`));
  const pid = lockPid(s, n);
  return pid !== undefined && pid > 0 && gone(pid);
}

/** The numbers this process is starting an Xvfb on: Xvfb's lock doesn't stop servers started together. */
const STARTING = new Set<number>();

/** A free display number no other start of this process holds, from a random one on, so another process's start rarely
 * picks the same. Given back with `STARTING.delete`. */
function claimNumber(s: Settings): number | undefined {
  const from = 100 + (randomBytes(4).readUInt32LE(0) % 500);
  for (const n of [...range(from, 600), ...range(100, from)]) {
    if (!STARTING.has(n) && isFree(s, n)) {
      STARTING.add(n);
      return n;
    }
  }
  return undefined;
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

const killGroup = (pid: number | undefined) => {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};

/** A child the node started, with its end once it comes. */
type Child = { proc: ChildProcess; exited: { code: number | null; signal: string | null } | undefined; done: Promise<void> };

function track(proc: ChildProcess): Child {
  const child: Child = { proc, exited: undefined, done: Promise.resolve() };
  child.done = new Promise((resolve) => {
    proc.once("exit", (code, signal) => {
      child.exited = { code, signal };
      resolve();
    });
    proc.once("error", () => {
      child.exited ??= { code: null, signal: null };
      resolve();
    });
  });
  return child;
}

export class Display implements Lent {
  private readonly apps: Child[] = [];
  private launched = 0;
  private dropped = false;

  private constructor(
    readonly backend: Backend,
    readonly dir: string,
    /** The X socket the node connects to. */
    readonly socket: string,
    readonly cookie: Uint8Array,
    /** The display's name as its apps see it (`:0` in a container, `:<n>` on the host). */
    readonly name: string,
    private readonly settings: Settings,
    private xvfb: Child | undefined,
    private readonly container: { runtime: Runtime; name: string } | undefined,
  ) {}

  /** Starts a display now (a second or so for a container, less for Xvfb). A container sees `mount`, a folder of the
   * host, read-only at the same path. */
  static async start(settings: Settings, mount?: string): Promise<Display> {
    const cookie = new Uint8Array(randomBytes(16));
    const tag = hex(new Uint8Array(randomBytes(6)));
    const dir = join(settings.root, tag);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new Error(`cannot make ${dir}: ${(e as Error).message}`);
    }
    try {
      return settings.backend === "xvfb" ? await Display.startXvfb(settings, dir, cookie) : await Display.startContainer(settings, dir, cookie, tag, mount);
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  private static async startXvfb(settings: Settings, dir: string, cookie: Uint8Array): Promise<Display> {
    const xvfb = settings.xvfb;
    if (!xvfb) throw new Error("this machine has no Xvfb");
    const auth = join(dir, "xauth");
    try {
      writeFileSync(auth, xauth(cookie), { mode: 0o600 });
    } catch (e) {
      throw new Error(`cannot write the X cookie: ${(e as Error).message}`);
    }
    for (const sub of ["home", "run"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    let last = "";
    // A number another X server takes meanwhile is tried again with the next.
    for (let attempt = 0; attempt < 3; attempt++) {
      const number = claimNumber(settings);
      if (number === undefined) throw new Error("every X display number from 100 to 599 is taken");
      try {
        const log = join(dir, "xvfb.log");
        const out = openSync(log, "w");
        let child: Child;
        try {
          const args = [`:${number}`, "-screen", "0", `${SIZE[0]}x${SIZE[1]}x24`, "-nolisten", "tcp", "-nolisten", "local", "-noreset", "-auth", auth];
          child = track(spawn(xvfb, args, { stdio: ["ignore", out, out], detached: true }));
        } finally {
          closeSync(out);
        }
        const pid = child.proc.pid;
        if (pid === undefined) {
          await child.done;
          throw new Error(`cannot run ${xvfb}`);
        }
        // With its start time: a cleanup after a reboot kills only this process, never one that took its pid.
        try {
          writeFileSync(join(dir, "xvfb.pid"), `${pid} ${startTime(pid) ?? ""}`);
        } catch {}
        const socket = join(x11Dir(settings), `X${number}`);
        try {
          await waitX(socket, cookie, () => {
            if (child.exited) {
              const status = child.exited.code !== null ? `exit status: ${child.exited.code}` : `signal: ${child.exited.signal}`;
              throw new Error(`Xvfb exited (${status}): ${tail(log, 600)}`);
            }
          });
        } catch (e) {
          killGroup(pid);
          await child.done;
          forgetKilled(settings, number, pid);
          last = (e as Error).message;
          continue;
        }
        const display = new Display("xvfb", dir, socket, cookie, `:${number}`, settings, child, undefined);
        const wm = (settings.windowManagers ?? WINDOW_MANAGERS).map((w) => (w.startsWith("/") ? w : onPath(w))).find((p) => p !== undefined);
        if (wm) {
          try {
            display.spawnHost(wm, undefined, "wm.log");
          } catch {}
        }
        return display;
      } finally {
        STARTING.delete(number);
      }
    }
    throw new Error(last);
  }

  private static async startContainer(settings: Settings, dir: string, cookie: Uint8Array, tag: string, mount: string | undefined): Promise<Display> {
    const runtime = settings.runtime;
    if (!runtime) throw new Error("this machine has no container runtime");
    const sockets = join(dir, "x11");
    mkdirSync(sockets, { recursive: true });
    // Xvfb in the container makes its socket here, as whichever user the runtime maps it to.
    chmodSync(sockets, 0o1777);
    const auth = join(dir, "xauth");
    try {
      writeFileSync(auth, xauth(cookie));
    } catch (e) {
      throw new Error(`cannot write the X cookie: ${(e as Error).message}`);
    }
    chmodSync(auth, 0o644);
    // The display's folder is the node's own; the container's user must reach the two above through it.
    chmodSync(dir, 0o711);
    const name = `${NAME_PREFIX}${tag}`;
    await runtime.run(name, settings.image, sockets, auth, mount);
    const socket = join(sockets, "X0");
    try {
      await waitX(socket, cookie, async () => {
        const why = await runtime.running(name);
        if (why) throw new Error(why);
      });
    } catch (e) {
      const logs = await runtime.logs(name);
      await runtime.remove(name);
      throw new Error(logs ? `${(e as Error).message}: ${logs}` : (e as Error).message);
    }
    return new Display("container", dir, socket, cookie, ":0", settings, undefined, { runtime, name });
  }

  /** Whether its X server still runs (a container checked with its runtime). */
  async alive(): Promise<boolean> {
    if (this.container) return (await this.container.runtime.running(this.container.name)) === undefined;
    return this.xvfb !== undefined && this.xvfb.exited === undefined;
  }

  connect(): Promise<X> {
    return X.connect(this.socket, this.cookie);
  }

  /** The environment of an app on the host: its display, its fresh home, and nothing of the node's but PATH. */
  hostEnv(): Record<string, string> {
    const home = join(this.dir, "home");
    const env: Record<string, string> = {
      DISPLAY: this.name,
      XAUTHORITY: join(this.dir, "xauth"),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_RUNTIME_DIR: join(this.dir, "run"),
      LANG: "C.UTF-8",
      // A terminal opens a plain shell, not the node user's own with its first-run wizard in a fresh home.
      SHELL: ["/bin/bash", "/bin/sh"].find((s) => existsSync(s)) ?? "/bin/sh",
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    return env;
  }

  private spawnHost(command: string, cwd: string | undefined, log: string): number {
    const out = openSync(join(this.dir, log), "w");
    let child: Child;
    try {
      const at = cwd && isDir(cwd) ? cwd : join(this.dir, "home");
      child = track(spawn("/bin/sh", ["-c", command], { cwd: at, env: this.hostEnv(), stdio: ["ignore", out, out], detached: true }));
    } catch (e) {
      throw new Error(`cannot start it: ${(e as Error).message}`);
    } finally {
      closeSync(out);
    }
    if (child.proc.pid === undefined) throw new Error("cannot start it");
    this.apps.push(child);
    return child.proc.pid;
  }

  /** Starts `command` with `sh -c` on the display, in `cwd` where the app can see it, and looks at it a moment later. */
  async launch(command: string, cwd: string): Promise<Launched> {
    const n = ++this.launched;
    const settle = 500;
    if (this.container) return this.container.runtime.launch(this.container.name, command, cwd, n, settle);
    const log = `launch-${n}.log`;
    const pid = this.spawnHost(command, cwd, log);
    await Bun.sleep(settle);
    const app = this.apps.find((c) => c.proc.pid === pid);
    return app?.exited ? { pid, exited: { code: app.exited.code, output: tail(join(this.dir, log), 1500) } } : { pid };
  }

  /** Everything on the display goes: its apps, its X server or container, and its folder. */
  async drop(): Promise<void> {
    if (this.dropped) return;
    this.dropped = true;
    for (const app of this.apps.splice(0)) {
      killGroup(app.proc.pid);
      await app.done;
    }
    const xvfb = this.xvfb;
    this.xvfb = undefined;
    if (xvfb?.proc.pid) {
      killGroup(xvfb.proc.pid);
      await xvfb.done;
      const n = Number(this.name.slice(1));
      if (Number.isInteger(n)) forgetKilled(this.settings, n, xvfb.proc.pid);
    }
    if (this.container) await this.container.runtime.remove(this.container.name);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** When a process started, in clock ticks since boot (`/proc/<pid>/stat`'s 22nd field); undefined where there's no
 * such process. */
export function startTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // After the command's name in parentheses, which may hold spaces: state is field 3, start time field 22.
    const rest = stat.slice(stat.lastIndexOf(")") + 1);
    const field = rest.trim().split(/\s+/)[19];
    return field && /^\d+$/.test(field) ? field : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is still the Xvfb a node started at `started`: the same start time, and an Xvfb by its command line.
 * A pid reused after a reboot, by anything, fails one or the other. */
export function isOurXvfb(pid: number, started: string): boolean {
  if (pid <= 1 || startTime(pid) !== started) return false;
  try {
    const program = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0")[0] ?? "";
    return basename(program).includes("Xvfb");
  } catch {
    return false;
  }
}

/** Kills what a node that died left behind: Xvfbs by the pid files in their folders, the folders, and containers by
 * their label. How many it cleared. */
export async function clearLeftovers(root: string, runtime: Runtime | undefined): Promise<number> {
  let cleared = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {}
  for (const entry of entries) {
    const dir = join(root, entry);
    let recorded = "";
    try {
      recorded = readFileSync(join(dir, "xvfb.pid"), "utf8");
    } catch {}
    const [pid, started] = recorded.trim().split(/\s+/);
    if (pid && started && /^\d+$/.test(pid) && isOurXvfb(Number(pid), started)) {
      try {
        process.kill(-Number(pid), "SIGKILL");
        cleared++;
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
  if (runtime) cleared += await runtime.removeLeftovers();
  return cleared;
}

/** Displays started ahead for the next sessions. */
export class Pool {
  private readonly warmList: Display[] = [];
  private filling = false;
  /** Drained (the node stops): a start under way throws its display away instead of keeping it. */
  private closed = false;

  constructor(
    readonly settings: Settings,
    private readonly size: number,
  ) {}

  backend(): Backend {
    return this.settings.backend;
  }

  /** A display for a session. A container that must see `mount` (the session's worktree) is started now, since a
   * running container takes no new folder; any other comes started from the pool, which refills behind it. */
  async take(mount: string | undefined): Promise<Display> {
    if (this.settings.backend === "container" && mount) return Display.start(this.settings, mount);
    let display: Display | undefined;
    for (let next = this.warmList.shift(); next; next = this.warmList.shift()) {
      if (await next.alive()) {
        display = next;
        break;
      }
      void next.drop();
    }
    display ??= await Display.start(this.settings);
    this.refill();
    return display;
  }

  /** Starts displays in the background until the pool holds its size. */
  refill(): void {
    if (this.filling) return;
    this.filling = true;
    void (async () => {
      try {
        while (this.warmList.length < this.size && !this.closed) {
          let display: Display;
          try {
            display = await Display.start(this.settings);
          } catch (e) {
            console.warn(`desktop pool not refilled: ${(e as Error).message}`);
            return;
          }
          if (this.closed) await display.drop();
          else this.warmList.push(display);
        }
      } finally {
        this.filling = false;
      }
    })();
  }

  warm(): number {
    return this.warmList.length;
  }

  /** Takes every waiting display out, for the caller to throw away. */
  drain(): Display[] {
    this.closed = true;
    return this.warmList.splice(0);
  }
}
