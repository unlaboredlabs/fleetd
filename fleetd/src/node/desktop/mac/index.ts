// The agents' Mac's own screen (crates/fleetd/src/node/desktop/mac/mod.rs, D298): the GUI session the Mac's node runs
// in, as a screen kind (`session_start` kind mac). There is one such screen, so it is leased: the first session to start
// holds it, and every other only observes (its screenshots, the pointer's place and agent-desktop's reading commands
// work; its other actions are refused while another holds it, and its first one after the holder ends takes it). A
// session no action touched for IDLE_MINUTES ends, and the lease with it. A person who takes a Mac screen over takes
// the lease too: an agent holding it only observes from then on. The lease itself is node/desktop's (index.ts).
//
// The node reads and drives the screen (screen.ts) under its own grants, and runs a pinned agent-desktop for the agent
// (agent_desktop.ts) as its child under those same grants. macOS gives a session frames and input only while it is the
// one on the screen, unlocked (console.ts), so every start and every take of the lease checks that first.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RESTART_NODE } from "../../agents_mac/index.ts";
import { tcc } from "../../agents_mac/tcc.ts";
import { tail } from "../display.ts";
import type { Launched, Lent } from "../screen.ts";
import type { DesktopCall } from "../session.ts";
import { answer, command, launchedPid, run } from "./agent_desktop.ts";
import { type Console, consoleBlocked, read as readConsole, state } from "./console.ts";

/** A Mac screen session no action touched for this long ends, and gives the lease back. */
export const IDLE_MINUTES = 5;

/** node.json's `mac`: the agents' Mac's screen. Off unless `enabled` is true. */
export type MacConfig = { enabled?: boolean; simulators?: number };

export const macSupported = () => process.platform === "darwin";

/** On where node.json turns it on, on a Mac. */
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

/** Whether a `desktop` action only reads the screen, so a session that doesn't hold the lease may take it. */
export function observes(call: DesktopCall): boolean {
  switch (call.action) {
    case "screenshot":
    case "cursor_position":
    case "wait":
      return true;
    case "agent_desktop":
      // One the node won't run is refused as it runs, with why.
      if (!call.text) return true;
      try {
        return command(call.text).observing;
      } catch {
        return true;
      }
    default:
      return false;
  }
}

/** When process `pid` started, as `ps` says it; undefined where there's no such process. */
function startedAt(pid: number): string | undefined {
  const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  const at = (out.stdout ?? "").trim();
  return out.status === 0 && at ? at : undefined;
}

/** What a Mac screen session is lent: its own folder (apps it launches start there, and agent-desktop keeps its
 * snapshots there), the apps it started and those agent-desktop launched with a DevTools port. Dropped when the session
 * ends: those apps are closed and the folder goes; what the agent opened otherwise stays on the Mac's screen. */
export class MacLent implements Lent {
  /** Apps launched with `--cdp`: each pid with its start time, so a pid reused since is never signalled. */
  private readonly cdp: [number, string][] = [];
  private readonly apps: { proc: ChildProcess; exited?: number | null }[] = [];
  private launched = 0;

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
    if (this.agentDesktopBin instanceof Error) throw new Error(`agent-desktop isn't installed on this Mac: ${this.agentDesktopBin.message}`);
    const ran = await run(this.agentDesktopBin, join(this.dir, "agent-desktop"), cmd.args);
    if (cmd.cdp) {
      const pid = launchedPid(ran.stdout);
      const at = pid === undefined ? undefined : startedAt(pid);
      if (pid !== undefined && at) this.cdp.push([pid, at]);
    }
    return answer(ran.stdout, ran.stderr, ran.code);
  }

  async drop(): Promise<void> {
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
