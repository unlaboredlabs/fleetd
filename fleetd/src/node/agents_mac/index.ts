// The agents' Mac (D298, docs: agents-mac.md): a Mac whose node runs in the
// account logged in at its screen, joined with the installer's `--mac`, which sets node.json's `agentsMac`. It is a
// tool every project's agents use from their own machines, never a runner:
//
// - it runs no claude, no lead and no task: `sessionCallAllowed` refuses every session call but the few a hub
//   sends any machine;
// - it takes no sealed secret and runs no gated command: TOOL_ONLY;
// - its hello lists only the calls a tool needs (`toolOnly`), with `agents_mac` whatever its checks say.
//
// The node checks the Mac's setup as its own user (checks.ts), takes up a new privacy grant by restarting (grants.ts),
// holds a keep-awake assertion for as long as it runs, and installs the pinned Node.js (tools.ts). Where Xcode is, and
// the one command that selects it, is xcode.ts.
//
// What other areas use: `toolOnly` (the hello's filter: the caps seam only adds, so dropping the calls the Mac doesn't
// take from the node core's own list is the node core's), `sessionCallAllowed` and TOOL_ONLY (the link's refusals),
// `grantsCommand` (`fleetd node grants`), `blocksSimulators` (mac sim), `readHealth`, `lastFullCheck`, `request`,
// `askNode` and `openPane` (setup's grant step).
import { mkdirSync, writeFileSync } from "node:fs";
import {
  CAP_AGENTS_MAC,
  CAP_BROWSER,
  CAP_BUILD_BUN,
  CAP_BUILD_RUST,
  CAP_LINK_DEFLATE,
  CAP_MAC_TOOL,
  CAP_PROJECT_SETTINGS,
  CAP_SELF_UPDATE,
  CAP_SESSION_END,
  CAP_SESSION_HOST,
  CAP_SESSION_IOS,
  CAP_SESSION_SEAL,
  CAP_UPDATE_FETCH,
  CAP_UPDATE_HOLD,
} from "../../shared/node_link.ts";
import type { Node } from "../api.ts";
import type { NodeConfig } from "../config.ts";
import { grant, readMac, run as runChecks, screenCapture } from "./checks.ts";
import { checkedFile, health, type MacHealth, type MacLink, user, writeHealth, writeLink } from "./common.ts";
import { tcc } from "./tcc.ts";
import { spawnOutside } from "../../update/service.ts";
import { answer, CHECK_EVERY, every, type Fresh, overlay, takeUp } from "./grants.ts";
import { Installing } from "./tools.ts";

export { blocksSimulators, HOMEBREW_BINS } from "./checks.ts";
export { checkedFile, GRANTS, healthFile, lastFullCheck, linkFile, readHealth, readLink, toolsDir, user } from "./common.ts";
export { ASK_WAIT, askFile, askNode, asked, CHECK_EVERY, grantsCommand, line, notAsked, openPane, own, parse, request } from "./grants.ts";

/** What the agents' Mac answers the hub for everything it doesn't do: it is a tool, never a runner. */
export const TOOL_ONLY =
  "the agents' Mac is a tool for agents on other machines: it runs no session, claude or secret itself";

/** Whether this node is the agents' Mac: a node.json that says so keeps the node a tool on any OS. */
export const isAgentsMac = (config: Pick<NodeConfig, "agentsMac">) => config.agentsMac === true;

/** Whether this user may join as the agents' Mac: on macOS, in any account (an admin's too, D309). Why not. */
export const mayJoin = (): string | undefined =>
  process.platform === "darwin" ? undefined : "--mac is for the agents' Mac: run it on a Mac, logged in at its screen";

/** node.json's `ios` as the node runs it: with its tool on, the Mac makes its golden simulator whatever `enabled` says
 * (a Mac that once turned iOS screens off would otherwise keep `mac sim` off with no switch to turn it on). */
export function iosConfig(config: Record<string, unknown> | undefined, tool: boolean): Record<string, unknown> {
  return tool ? { ...(config ?? {}), enabled: true } : { ...(config ?? {}) };
}

const KEPT = new Set([
  CAP_MAC_TOOL,
  CAP_BUILD_RUST,
  CAP_BUILD_BUN,
  CAP_SELF_UPDATE,
  CAP_UPDATE_FETCH,
  CAP_UPDATE_HOLD,
  CAP_PROJECT_SETTINGS,
  CAP_SESSION_END,
  CAP_SESSION_HOST,
  CAP_SESSION_SEAL,
  CAP_BROWSER,
  CAP_SESSION_IOS,
  CAP_LINK_DEFLATE,
]);

/** The calls the agents' Mac lists at its hello (mod.rs `capabilities`): `agents_mac` first, then of `caps` only
 * updates, screens it hosts for agents elsewhere, a project's removal and compressed link frames; nothing that carries
 * a secret, a claude or a project. `tool`: the Mac's tool is on (macOS), so `mac_tool` too, once. */
export function toolOnly(caps: Iterable<string>, tool: boolean): string[] {
  const out = [CAP_AGENTS_MAC, ...[...caps].filter((c) => KEPT.has(c) && c !== CAP_MAC_TOOL)];
  if (tool) out.push(CAP_MAC_TOOL);
  return out;
}

/** The session calls the agents' Mac answers: the runner's figures (the doctor asks every machine) and a project's
 * removal. An allowlist: a call a newer hub adds is refused until it is named here. */
export const sessionCallAllowed = (call: { op?: unknown }) => call.op === "runner_info" || call.op === "project_remove";

/** What a person runs in the node's account to restart it, which grants.ts runs itself for a new grant. */
export const RESTART_NODE = "launchctl kickstart -k gui/$(id -u)/sh.fleetd.node";

/** The keep-awake hold: `caffeinate -i -s` on macOS (PreventUserIdleSystemSleep and PreventSystemSleep, the latter on
 * power, which a Mac mini always is), a logind idle:sleep block elsewhere, both for as long as this process lives, a
 * child the node owns. Released by `release`; `ended` resolves if it ends by itself; why not, when it can't be had. */
export async function keepAwake(why: string): Promise<{ release: () => void; ended: Promise<unknown> } | string> {
  const argv =
    process.platform === "darwin"
      ? ["caffeinate", "-i", "-s", "-w", String(process.pid)]
      : ["systemd-inhibit", "--what=idle:sleep", "--who=fleetd", `--why=${why}`, "--mode=block", "sleep", "infinity"];
  let proc: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  } catch (e) {
    return `${argv[0]} can't run: ${(e as Error).message}`;
  }
  // A hold that ends at once was refused.
  const ended = await Promise.race([proc.exited.then(() => true), Bun.sleep(300).then(() => false)]);
  if (ended) {
    const said = (await new Response(proc.stderr).text()).trim();
    return `${argv[0]} exited at once${said ? `: ${said.slice(0, 200)}` : ""}`;
  }
  return { release: () => proc.kill(), ended: proc.exited };
}

/** How soon a hold that ended by itself is taken again. */
export const REHOLD_MS = 2_000;

/** How long the hold across a restart lasts: the next node takes its own within seconds, an update's in about one. */
export const BRIDGE_SECS = 120;

/** A keep-awake hold outside the node's process group, so its service's stop doesn't end it; it ends by itself. */
function bridgeRestart(): void {
  if (process.platform === "darwin") spawnOutside("caffeinate", ["-i", "-s", "-t", String(BRIDGE_SECS)], "awake");
}

/** The Mac's setup as last checked, for the heartbeat, and what the node holds for it while it runs. */
export class AgentsMac {
  private last: MacHealth | undefined;
  /** What a fresh process of the node was granted last: the grant checks say this, not the running process's own. */
  private fresh: Fresh | undefined;
  private readonly tools = new Installing();
  private awake: { release: () => void } | undefined;
  private readonly timers: Timer[] = [];
  private stopped = false;
  private linkState: MacLink | undefined;
  /** The last try at capturing the screen (checks.ts screenCapture): true, its error, or undefined before one. */
  private captured: true | string | undefined;
  private capturedAt = 0;

  constructor(
    readonly home: string,
    /** Its tool is on, as the node found at its start: its hello lists `mac_tool`. */
    readonly tool: boolean,
    /** One small capture of the screen: undefined when it came back, else why not. Tests pass their own. */
    private readonly capture: () => Promise<string | undefined> = captureOnce,
  ) {}

  health(): MacHealth | undefined {
    return this.last;
  }

  /** Holds `h`, with the grants a fresh process found, for the heartbeat and in the health file for setup. */
  publish(h: MacHealth): void {
    const granted = this.fresh ? overlay(h, this.fresh) : h;
    const shown = process.platform === "darwin" || this.captured !== undefined ? withCapture(granted, this.captured) : granted;
    writeHealth(this.home, shown);
    this.last = shown;
  }

  /**
   * Tries one capture once Screen Recording is on: on macOS 15 and later the first one puts up macOS's prompt whether
   * fleetd may capture the screen directly, and until the person allows it each try fails, so this says when they did.
   * Tried again every CAPTURE_RETRY while it fails, else every CHECK_EVERY, or at once when setup asks (`now`).
   */
  async probeCapture(recording: boolean | undefined, now = false, at = Date.now()): Promise<void> {
    const due = now || (this.captured === true ? at - this.capturedAt >= CHECK_EVERY : at - this.capturedAt >= CAPTURE_RETRY);
    const before = this.captured;
    if (recording !== true) this.captured = undefined;
    else if (due) {
      this.capturedAt = at;
      this.captured = (await this.capture()) ?? true;
    }
    if (this.captured !== before && this.last) this.publish(this.last);
  }

  /** How the link to the hub stands, written for setup as it changes: `why` is the hub's refusal, or why it's lost. */
  link(state: MacLink["state"], why?: string, now = Date.now()): void {
    if (this.linkState?.state === state && this.linkState.why === why) return;
    this.linkState = { state, ...(why === undefined ? {} : { why }), since: now };
    writeLink(this.home, this.linkState);
  }

  /** Holds the keep-awake assertion, installs the pinned tools, and checks the setup every CHECK_EVERY until stopped.
   * Asks macOS for a grant only when setup asks it to, and restarts the node once a fresh process has a grant it
   * lacks. */
  async start(): Promise<void> {
    mkdirSync(this.home, { recursive: true });
    this.link("linking");
    // The grants first, read in a moment: setup shows them while the slower checks (Xcode's) still run.
    if (process.platform === "darwin" && this.last === undefined) {
      this.publish(health(user(), [grant("accessibility", tcc.accessibility()), grant("screen_recording", tcc.screenRecording())]));
    }
    const held = await this.hold();
    if (process.platform === "darwin") {
      const grants = async () => {
        if (this.stopped) return;
        let askedCapture = false;
        answer(this.home, (id) => (id === "screen_capture" ? (askedCapture = true) : tcc.ask(id)));
        const found = await takeUp(this.home);
        if (found) {
          this.fresh = found;
          if (this.last) this.publish(this.last);
        }
        await this.probeCapture(this.fresh?.grants.screenRecording ?? tcc.screenRecording(), askedCapture);
        if (!this.stopped) this.timers.push(setTimeout(() => void grants(), every(found?.grants)));
      };
      void grants();
    }
    void this.tools.run(this.home);
    const check = async () => {
      if (this.stopped) return;
      this.publish(runChecks(await readMac(typeof held === "string" ? held : undefined, this.tools.state)));
      // A run of every check, not the grants alone republished: setup counts only these.
      try {
        writeFileSync(checkedFile(this.home), "");
      } catch {}
      if (!this.stopped) this.timers.push(setTimeout(() => void check(), CHECK_EVERY));
    };
    void check();
  }

  /** Takes the keep-awake hold, and takes it again whenever it ends by itself while the node runs (a killed caffeinate
   * would otherwise let the Mac sleep and drop off its hub). Why not, when it can't be had. */
  async hold(take: typeof keepAwake = keepAwake): Promise<{ release: () => void } | string> {
    const held = await take("fleetd: the agents' Mac stays awake");
    if (typeof held === "string") {
      console.warn(`the agents' Mac can't hold its keep-awake assertion: ${held}`);
      return held;
    }
    this.awake = held;
    void held.ended.then(() => {
      if (this.stopped || this.awake !== held) return;
      console.warn("the agents' Mac's keep-awake assertion ended by itself; it takes it again");
      this.awake = undefined;
      this.timers.push(setTimeout(() => void this.hold(take), REHOLD_MS));
    });
    return held;
  }

  stop(bridge: () => void = bridgeRestart): void {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearTimeout(t);
    // The hold goes with this node: until the next one takes its own, one outside it keeps the Mac up (Nov 22, an
    // update's restart let a Mac set to sleep after 1 min idle sleep 5 s later and drop off its hub).
    if (this.awake !== undefined) {
      try {
        bridge();
      } catch (e) {
        console.warn(`the agents' Mac couldn't hold itself awake across the node's restart: ${(e as Error).message}`);
      }
    }
    this.awake?.release();
  }
}

/** How soon a failed capture is tried again: often enough to see the person's Allow within seconds, seldom enough not
 * to stack macOS's prompts. */
export const CAPTURE_RETRY = 5_000;

/** `h` with the screen capture check as last tried, after Screen Recording's. */
export function withCapture(h: MacHealth, captured: true | string | undefined): MacHealth {
  const row = screenCapture(captured);
  const checks = h.checks.filter((c) => c.id !== "screen_capture");
  const at = checks.findIndex((c) => c.id === "screen_recording");
  checks.splice(at < 0 ? checks.length : at + 1, 0, row);
  return { ...h, checks };
}

/** One capture of a corner of the main display, through the screen kind's own ScreenCaptureKit path. Its filter and
 * configuration are let go after, as the next try makes its own. */
async function captureOnce(): Promise<string | undefined> {
  let capture: { close(): void } | undefined;
  try {
    const { Capture } = await import("../desktop/mac/capture.ts");
    const made = new Capture();
    capture = made;
    await made.grab([64, 40]);
    return undefined;
  } catch (error) {
    return (error as Error).message.slice(0, 200);
  } finally {
    capture?.close();
  }
}

/** The node's agents' Mac, where node.json says it is one: `given` (a test's) when it is the first to ask. */
export const agentsMac = (node: Node, given?: AgentsMac) =>
  node.area("agents_mac", (n) => given ?? (isAgentsMac(n.config) ? new AgentsMac(n.home, process.platform === "darwin") : undefined));

/** Starts the Mac's checks where this node is the agents' Mac, and puts them in each heartbeat's `load.mac`. */
export function start(node: Node, given?: AgentsMac): AgentsMac | undefined {
  const mac = agentsMac(node, given);
  if (!mac) return undefined;
  void mac.start();
  heartbeat(node, mac);
  // Its hello says it is the agents' Mac whatever its checks say, and lists its tool while that is on.
  node.area("caps").contribute(() => toolOnly([], mac.tool));
  return mac;
}

/** Puts the Mac's last checks in each heartbeat's `load.mac`. */
export function heartbeat(node: Node, mac: AgentsMac): void {
  node.area("hb").contribute((hb) => {
    const h = mac.health();
    if (h && hb.load) hb.load.mac = h;
  });
}

export function stop(node: Node): void {
  agentsMac(node)?.stop();
}
