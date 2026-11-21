// The agents' Mac's own screen (D298): the GUI session the Mac's node runs
// in, as a screen kind (`session_start` kind mac). There is one such screen, but several agents work on it at once:
//
// - agent-desktop's headless commands (accessibility actions on a ref, `press --app`, `launch <app>`, which move no
//   pointer and take no focus) need only a claim on the app they name: one agent per app (by bundle id), taken by its
//   first such command and kept until its session ends. Another agent naming that app is refused, with who holds it.
// - Real pointer and key input needs the Mac's lease, one holder at a time: the desktop tool's clicks, keys, scrolls
//   and drags, `launch`, agent-desktop with `--headed`, and any agent-desktop command not known to be headless
//   (agent_desktop.ts lists the known ones). It is taken by the first such action and given back after IDLE_MINUTES
//   without one, or when its session ends.
// - Reading (screenshots, the pointer's place, agent-desktop's reading commands) is open to every session.
//
// A session no action touched for IDLE_MINUTES ends, with its lease and claims. A person who takes a Mac screen
// over takes the whole screen: the lease is theirs, and every agent only reads until they hand it back. A session
// that ends gives its lease and claims back only once its last agent-desktop command has stopped. The lease and the
// claims themselves are node/desktop's (index.ts); a session that holds neither only observes, and records no video.
//
// The node reads and drives the screen (screen.ts) under its own grants, and runs a pinned agent-desktop for the agent
// (agent_desktop.ts) as its child under those same grants. macOS gives a session frames and input only while it is the
// one on the screen, unlocked (console.ts), so every start, every take of the lease and every new claim checks that
// first.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RESTART_NODE } from "../../agents_mac/index.ts";
import { tcc } from "../../agents_mac/tcc.ts";
import { tail } from "../display.ts";
import type { App, Launched, Lent } from "../screen.ts";
import type { DesktopCall } from "../session.ts";
import { answer, command, launchedPid, listedApp, type Needs, run, snapshotApp, type Target } from "./agent_desktop.ts";
import { type Console, consoleBlocked, read as readConsole, state } from "./console.ts";

/** A Mac screen session no action touched for this long ends, and gives its lease and claims back; the lease alone
 * goes back after this long without an action that needs it. */
export const IDLE_MINUTES = 5;

/** node.json's `mac`: the agents' Mac's screen. `enabled` is the node's own word: true on the agents' Mac only. */
export type MacConfig = { enabled?: boolean; simulators?: number };

export const macSupported = () => process.platform === "darwin";

/** On on the agents' Mac, on a Mac. */
export const macEnabled = (config: MacConfig | undefined) => config?.enabled === true && macSupported();

/** What stands in the way of a Mac screen now, in plain words, and the command that clears it where one does. */
export type Blocked = { message: string; fix?: string };

/** Why the node's user can't lend its screen, from what macOS says about it: its session must be on the screen,
 * unlocked, and the node needs Screen Recording and Accessibility. Any account may lend it (D309). */
export function blockedBy(user: string, console: Console, screenRecording: boolean, accessibility: boolean): Blocked | undefined {
  const why = consoleBlocked(console, user);
  if (why) return { message: why };
  const grant = (what: string, pane: string): Blocked => ({
    message: `fleetd needs ${what} in ${user}'s session: at the Mac, in System Settings › Privacy & Security › ${what}, turn fleetd on; the node restarts itself within a minute to take it up`,
    fix: `open 'x-apple.systempreferences:com.apple.preference.security?${pane}' && ${RESTART_NODE}`,
  });
  if (!screenRecording) return grant("Screen Recording", "Privacy_ScreenCapture");
  if (!accessibility) return grant("Accessibility", "Privacy_Accessibility");
  return undefined;
}

/** What stands in the way of a Mac screen on this machine now. */
export function blocked(): Blocked | undefined {
  if (!macSupported()) return { message: "the Mac screen is a Mac's own" };
  const uid = process.getuid?.() ?? -1;
  let user = String(uid);
  try {
    user = userInfo().username;
  } catch {}
  let console: Console;
  try {
    console = state(uid, readConsole());
  } catch (e) {
    return { message: `the node can't tell whether ${user}'s session is on the Mac's screen: ${(e as Error).message}` };
  }
  const screenRecording = tcc.screenRecording();
  const accessibility = tcc.accessibility();
  if (screenRecording === undefined || accessibility === undefined) {
    return { message: "this Mac lacks what its screen needs: macOS can't be asked about its grants" };
  }
  return blockedBy(user, console, screenRecording, accessibility);
}

/** What a `desktop` action needs on the Mac's screen (agent_desktop.ts `Needs`), and the app it names. */
export function needs(call: DesktopCall): { needs: Needs; target?: Target } {
  switch (call.action) {
    case "screenshot":
    case "cursor_position":
    case "wait":
      return { needs: "read" };
    case "agent_desktop": {
      // One the node won't run is refused as it runs, with why.
      if (!call.text) return { needs: "read" };
      try {
        const cmd = command(call.text);
        return { needs: cmd.needs, ...(cmd.target ? { target: cmd.target } : {}) };
      } catch {
        return { needs: "read" };
      }
    }
    default:
      // Clicks, keys, scrolls, drags, and `launch`, whose shell command may bring anything to the front.
      return { needs: "lease" };
  }
}

/** Whether a `desktop` action only reads the screen, so any session may take it. */
export const observes = (call: DesktopCall) => needs(call).needs === "read";

/** An app as claims know it: every name it goes by, in lower case (the one the agent gave, and where agent-desktop
 * lists it running, its display name and bundle id), so a claim made by name before the app ran still matches it by
 * bundle id once it runs; and the name the agent gave, for messages. */
export type { App } from "../screen.ts";

/** When process `pid` started, as `ps` says it; undefined where there's no such process. */
function startedAt(pid: number): string | undefined {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  const at = (out.stdout ?? "").trim();
  return out.status === 0 && at ? at : undefined;
}

/** What a Mac screen session is lent: its own folder (apps it launches start there, and agent-desktop keeps its
 * snapshots there), the apps it started and those agent-desktop launched with a DevTools port. Dropped when the session
 * ends: an agent-desktop command still running is stopped first, those apps are closed and the folder goes; what the
 * agent opened otherwise stays on the Mac's screen. */
export class MacLent implements Lent {
  /** Apps launched with `--cdp`: each pid with its start time, so a pid reused since is never signalled. */
  private readonly cdp: [number, string][] = [];
  private readonly apps: { proc: ChildProcess; exited?: number | null }[] = [];
  private launched = 0;
  /** The app each of the session's snapshots read, so a ref's command knows its app. */
  private readonly snapshots = new Map<string, string>();
  /** The names an app goes by, once agent-desktop listed it running, by the name the agent gave in lower case. */
  private readonly listed = new Map<string, string[]>();
  /** Stops the session's agent-desktop commands when it is dropped. */
  private readonly stop = new AbortController();
  /** The agent-desktop commands running now. */
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    readonly dir: string,
    /** The pinned agent-desktop, or why it isn't there. */
    private readonly agentDesktopBin: string | Error,
  ) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new Error(`cannot make ${dir}: ${(e as Error).message}`);
    }
  }

  async launch(commandLine: string): Promise<Launched> {
    const n = ++this.launched;
    const log = join(this.dir, `launch-${n}.log`);
    const out = openSync(log, "w");
    let app: { proc: ChildProcess; exited?: number | null };
    try {
      app = { proc: spawn("/bin/sh", ["-c", commandLine], { cwd: this.dir, stdio: ["ignore", out, out], detached: true }) };
    } catch (e) {
      throw new Error(`cannot start it: ${(e as Error).message}`);
    } finally {
      closeSync(out);
    }
    app.proc.once("exit", (code) => (app.exited = code));
    const pid = app.proc.pid;
    if (pid === undefined) throw new Error("cannot start it");
    this.apps.push(app);
    await Bun.sleep(500);
    return app.exited !== undefined ? { pid, exited: { code: app.exited, output: tail(log, 1500) } } : { pid };
  }

  async agentDesktop(args: string): Promise<string> {
    const cmd = command(args);
    const ran = await this.run(cmd.args);
    const read = snapshotApp(ran.stdout);
    if (read) this.snapshots.set(read[0], read[1]);
    if (cmd.cdp) {
      const pid = launchedPid(ran.stdout);
      const at = pid === undefined ? undefined : startedAt(pid);
      if (pid !== undefined && at) this.cdp.push([pid, at]);
    }
    return answer(ran.stdout, ran.stderr, ran.code);
  }

  /** Runs agent-desktop in the session's own home, counted among the running commands until its process exits. */
  private run(args: string[]): Promise<{ code?: number; stdout: string; stderr: string }> {
    if (this.agentDesktopBin instanceof Error) throw new Error(`agent-desktop isn't installed on this Mac: ${this.agentDesktopBin.message}`);
    const running = run(this.agentDesktopBin, join(this.dir, "agent-desktop"), args, undefined, this.stop.signal);
    this.running.add(running);
    void running.catch(() => {}).finally(() => this.running.delete(running));
    return running;
  }

  /** The app `target` names, as claims know it: a ref's is the app its snapshot read, whatever `--app` says, since the
   * ref is what the command acts on; undefined when the session can't tell (a ref from a snapshot it never saw). Its
   * display name and bundle id are asked of agent-desktop's `list-apps` until it lists the app running. */
  async appOf(target: Target): Promise<App | undefined> {
    const name = target.snapshot === undefined ? target.app : this.snapshots.get(target.snapshot);
    if (name === undefined) return undefined;
    const lower = name.toLowerCase();
    let keys = this.listed.get(lower);
    if (keys === undefined && !(this.agentDesktopBin instanceof Error)) {
      const ran = await this.run(["list-apps"]).catch(() => undefined);
      const app = ran ? listedApp(ran.stdout, name) : undefined;
      // An app not running yet goes by its name alone: asked again next time, as it may have started since.
      if (app) {
        keys = [...new Set([lower, app.name.toLowerCase(), app.bundle.toLowerCase()])];
        this.listed.set(lower, keys);
      }
    }
    return { keys: keys ?? [lower], name };
  }

  async drop(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.running]);
    for (const [pid, at] of this.cdp.splice(0)) {
      if (startedAt(pid) === at) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    for (const app of this.apps.splice(0)) {
      if (app.exited === undefined && app.proc.pid) {
        try {
          process.kill(-app.proc.pid, "SIGTERM");
        } catch {}
      }
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
