// The node's browser sessions (the broker, ./broker.ts, with the node's own parts): one per agent session at most, on a
// warm Chrome from the pool (a fresh process with an empty profile, thrown away at the end), reached by the agent only
// through the CDP proxy (proxy.ts). It answers agent-mcp's browser calls (through node/device's router), takes the
// hub's `browser_watch`, `browser_input`, `browser_control` and `session_end` frames, reports each session to the hub
// as a `browser_session` lead call in its agent's name, and gives the heartbeat each live session's latest step. Each
// session is recorded (record.ts): its action log from the agent's `agent-browser` commands (node.area("items")) and
// fleetd's own steps, its video where Playwright's ffmpeg is installed, and its DOM trace (the page after each of the
// agent's commands and each fill, session.ts); once it ends the recording goes to the hub, tried again each minute
// until it does.
//
// What a session may do beyond driving: fill a login from the vault or 1Password (credentials.ts, vault.ts), an address
// from the vault (address.ts), pay at a checkout with its card (cards.ts), and take a value only the person may type
// (secure_input.ts). From the first fill on, the
// session is sealed: every answer to the agent is scrubbed of the values, and the proxy lets through a narrower list.
//
// A lead (a project with no repo, or one with repos whose browser the hub places here) runs its
// sessions on the profile its project keeps (D221, D310; chrome.ts `Kept`), not a fresh one, and a person's screen for
// a project of this machine's runs on it too. One browser at a time runs on a kept profile.
//
// Where Playwright's Chrome or agent-browser is missing, the node installs the pinned builds in the background as it
// starts, and a session's start waits for that install up to INSTALL_WAIT_MS.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../../shared/errors.ts";
import { findChrome, install as installChrome, installDir, Kept, keptDir, type Launched, launch, Pool } from "./chrome.ts";
import type { BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame } from "../../shared/screens_wire.ts";
import { CAP_BROWSER, CAP_SESSION_END, CAP_SESSION_HOST, CAP_SESSION_SEAL } from "../../shared/screens_wire.ts";
import {
  env as agentBrowserEnv,
  find as findAgentBrowser,
  install as installAgentBrowser,
  pluginDirs as agentBrowserPlugins,
  policyPath,
  VERSION as AGENT_BROWSER_VERSION,
  writePolicyText,
} from "./agent_browser.ts";
import { type BrokerHost, BrowserBroker } from "./broker.ts";
import { vaultFor } from "./onepassword.ts";
import { loadOrCreateBoxKey, type NodeBoxKey } from "../identity.ts";
import { Proxy } from "./proxy.ts";
import { DiskRecordings, findFfmpeg, recordingsDir } from "./record.ts";
import { HEIGHT, WIDTH } from "./session.ts";
import { hubCall, type Node, onHub, onLocal, toHub } from "./node.ts";
import type { ScreenHooks, SessionsArea } from "../api.ts";
import { CAP_VAULT_FILL } from "../../shared/node_link.ts";

export { type BoxedFor, drivesBrowser, type KeptInBox } from "./broker.ts";
export { NO_VIDEO } from "./record.ts";

/** How a session's browser starts: the node's Chrome through its pool, or a test's, on a fresh profile or `kept`, with
 * `extra` flags. */
export type Launcher = (kept?: string, extra?: string[]) => Promise<Launched>;

/** How long a session's start waits for the browser's install in progress: with the browser's launch after it,
 * inside the agent's wait for the node's answer (60 s). */
export const INSTALL_WAIT_MS = 30_000;

/** What installs the browser's parts: the pinned installs, or a test's stand-ins. */
export type Installer = { agentBrowser: (home: string) => Promise<unknown>; chrome: (home: string) => Promise<unknown> };
const PINNED: Installer = { agentBrowser: installAgentBrowser, chrome: installChrome };

/** Where the broker's browser comes from. */
type Install =
  | { kind: "ready"; pool: Pool }
  /** Not installed, and the install not started yet. */
  | { kind: "wanted" }
  | { kind: "installing"; step: string; since: number }
  /** The install failed, for this reason. `owed`: a session's start began it, and no start has answered with this
   * error yet (it failed after the start stopped waiting), so the next one does; otherwise the next start installs
   * again. */
  | { kind: "missing"; why: string; owed: boolean };

/** A session's project, whose kept profile its browser runs on: a lead's, or a person's screen. */
const noBrowser = (why: string) =>
  new ToolError(
    "failed",
    `This machine has no browser for sessions: ${why}.`,
    "session_start again tries the install again; if that fails too, say so in your result: a person must set up the browser on this machine (fleetd docs: Browser sessions)",
  );

/** `ms` in words, to the second. */
const durationWords = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

export type BrokerOptions = {
  /** Browsers kept launched for the next sessions: 1 for the node's Chrome, none for a test's launcher. */
  warm?: number;
  installer?: Installer;
};

export class Broker extends BrowserBroker {
  readonly kept: Kept;
  readonly home: string;
  private readonly node: Node;
  private install: Install;
  private readonly installer: Installer;
  /** Told when the install is done, ready or failed: the starts waiting on it. */
  private installDone: (() => void)[] = [];
  private readonly warmSize: number;

  constructor(node: Node, launcher?: Launcher, options: BrokerOptions = {}) {
    const self: { broker?: Broker } = {};
    super(nodeHost(node, () => self.broker!));
    self.broker = this;
    this.node = node;
    this.home = node.home;
    this.kept = new Kept(node.home);
    this.installer = options.installer ?? PINNED;
    this.install = { kind: "wanted" };
    if (launcher) this.install = { kind: "ready", pool: new Pool((_sandboxed, kept, extra) => launcher(kept, extra), options.warm ?? 0) };
    // The hub's runner launches no Chrome of its own: its agents' browsers run in their boxes.
    this.warmSize = options.warm ?? (node.config.runner === true ? 0 : 1);
  }

  /** The Chrome node.json names (`browser.chrome`, `FLEETD_CHROME`), else the node's pinned install's. */
  private chrome(): string | undefined {
    const configured = this.node.config.browser?.chrome;
    return typeof configured === "string" ? configured : findChrome(installDir(this.node.home));
  }

  /**
   * As the node starts (Rust `Broker::start`): the pool, where the browser is installed, else its install from now in
   * the background, so the first session finds it done, or nearly.
   */
  prepare(): void {
    if (this.install.kind !== "wanted") return;
    const chrome = this.chrome();
    if (chrome && findAgentBrowser(this.home)) this.ready(chrome);
    else this.beginInstall(false);
  }

  /** Makes the pool of `chrome` and starts filling it. */
  ready(chrome: string): void {
    const profiles = join(this.home, "browser", "profiles");
    // Profiles a node left behind when it stopped.
    rmSync(profiles, { recursive: true, force: true });
    const sandbox = this.node.config.browser?.sandbox;
    const pool = new Pool(
      (sandboxed, kept, extra) => launch(chrome, profiles, sandboxed && process.getuid?.() !== 0, kept, extra),
      this.warmSize,
      typeof sandbox === "boolean" ? sandbox : undefined,
    );
    pool.refill();
    this.setInstall({ kind: "ready", pool });
  }

  private setInstall(install: Install): void {
    this.install = install;
    for (const fn of this.installDone.splice(0)) fn();
  }

  /** Starts installing what is missing, unless an install runs or is done. One that failed (at boot, before the network
   * is up) is tried again. */
  private beginInstall(forSession: boolean): void {
    if (this.install.kind !== "wanted" && this.install.kind !== "missing") return;
    this.setInstall({ kind: "installing", step: "starting", since: Date.now() });
    void this.installNow(forSession);
  }

  /** Installs what is missing, step by step, then makes the pool. */
  private async installNow(forSession: boolean): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [];
    if (!findAgentBrowser(this.home)) steps.push([`agent-browser ${AGENT_BROWSER_VERSION}`, () => this.installer.agentBrowser(this.home)]);
    if (!this.chrome()) steps.push(["Chrome's headless shell and ffmpeg", () => this.installer.chrome(this.home)]);
    let failed: string | undefined;
    for (const [n, [what, step]] of steps.entries()) {
      if (this.install.kind === "installing") this.install.step = `step ${n + 1} of ${steps.length}, ${what}`;
      try {
        await step();
      } catch (e) {
        failed = (e as Error).message;
        break;
      }
    }
    const chrome = failed ? undefined : this.chrome();
    if (chrome) return this.ready(chrome);
    const why = failed ?? "the install left no browser";
    console.warn(`${new Date().toISOString()} WARN browser not installed {"error":${JSON.stringify(why)}}`);
    this.setInstall({ kind: "missing", why, owed: forSession });
  }

  /** The pool, once the browser is installed: a start during the install waits for it, up to INSTALL_WAIT_MS. A failed
   * install's error goes to one start, the next after it failed, and the start after that installs again. */
  private async pool(): Promise<Pool> {
    if (this.install.kind === "missing" && this.install.owed) {
      this.install.owed = false;
      throw noBrowser(this.install.why);
    }
    this.beginInstall(true);
    const deadline = Date.now() + INSTALL_WAIT_MS;
    for (;;) {
      const install: Install = this.install;
      if (install.kind === "ready") return install.pool;
      if (install.kind === "missing") {
        install.owed = false;
        throw noBrowser(install.why);
      }
      const left = deadline - Date.now();
      const done = left > 0 && (await Promise.race([new Promise<boolean>((r) => this.installDone.push(() => r(true))), Bun.sleep(left).then(() => false)]));
      if (!done) {
        const now: Install = this.install;
        const doing = now.kind === "installing" ? ` (${now.step}, ${durationWords(Date.now() - now.since)} so far)` : "";
        throw new ToolError(
          "failed",
          `This machine is still installing its browser${doing}.`,
          "try session_start again in a minute: the install carries on meanwhile, and a start after it opens the session",
        );
      }
    }
  }

  /** Browsers ready for the next sessions. */
  warm(): number {
    return this.install.kind === "ready" ? this.install.pool.warm() : 0;
  }

  /** A browser on this machine from the pool, on the project's kept profile for a lead (one browser at a time runs on
   * it: a person's screen meanwhile opens on a fresh one, signed out). A boxed agent's browser runs in its box instead,
   * on a fresh profile: a project's kept one is a lead's, and a lead never runs in a box. */
  protected override async launchHere(thread: string): Promise<Launched> {
    const pool = await this.pool();
    const owner = this.owners.get(thread);
    let lease: ReturnType<Kept["take"]> | undefined;
    if (owner) {
      try {
        lease = this.kept.take(owner.name);
      } catch (e) {
        if (!owner.freshIfBusy) {
          throw new ToolError(
            "invalid",
            `${(e as Error).message}: it keeps the bot's sign-ins, and one browser at a time runs on them.`,
            "end that session first (session_end there), or wait for it to end, then session_start again",
          );
        }
      }
    }
    return lease ? pool.takeKept(lease) : pool.take();
  }

  /** The node's sessions, where the node core set them up (a test's node may have none). */
  sessionsArea(): SessionsArea | undefined {
    try {
      return this.node.area("sessions");
    } catch {
      return undefined;
    }
  }

  /** This node's box key, which the hub seals vault values to (loaded at its first use). */
  override boxKey(): NodeBoxKey {
    return (this.#boxKey ??= loadOrCreateBoxKey(this.home));
  }
  #boxKey: NodeBoxKey | undefined;

  /**
   * Forgets project `project`'s sign-ins: the browser session of any of its agent sessions ends (its recording goes to
   * the hub as at any end), then its kept profile is deleted once that browser has let go of it.
   */
  async forgetSignins(project: string): Promise<void> {
    if (!keptDir(this.home, project)) return;
    for (const [thread, owner] of this.owners) {
      const open = this.sessions.get(thread);
      if (owner.name !== project || !open) continue;
      open.session.stepAt("signins_forgotten", {}, true, undefined, 0);
      void this.end(thread).catch(() => {});
    }
    await this.kept.wipe(project);
  }

  override async shutdown(): Promise<void> {
    await super.shutdown();
    if (this.install.kind === "ready") await this.install.pool.drain();
  }
}

/** What the node's broker has of the node: its link to the hub, its sessions' secrets, its box key, its recordings in
 * a folder under its home sent to the hub, agent-browser's policy file there (and in a hosted box, where its
 * agent-browser reads it), the proxy's port and key kept there, and 1Password through the SDK helper. */
function nodeHost(node: Node, broker: () => Broker): BrokerHost {
  const home = node.home;
  return {
    call: (op, args, opts) => hubCall(node, op, args, opts),
    send: (frame) => toHub(node, frame),
    secrets: (thread) => broker().sessionsArea()?.secretsFor?.(thread) ?? [],
    boxKey: () => broker().boxKey(),
    recordings: new DiskRecordings(
      recordingsDir(home),
      (thread, cwd, op, args) => hubCall(node, op, args, { threadId: thread, cwd }),
      () => findFfmpeg(installDir(home)),
      [WIDTH, HEIGHT],
    ),
    // The box got the node's files as they were at its launch, before this.
    policy: async (thread, text) => {
      writePolicyText(home, thread, text);
      const boxed = broker().boxed?.(thread);
      if (boxed && boxed !== "starting") await boxed.box.write(policyPath(home, thread), new TextEncoder().encode(text), 0o600);
    },
    proxy: (sessions) => Proxy.start(home, sessions),
    vaultFor: vaultFor(home),
  };
}

/** The node's broker: `given` (a test's) when it is the first to ask, else the node's own. */
export const broker = (node: Node, given?: Broker) => node.area("browser.broker", (n) => given ?? new Broker(n));

/** What the node's sessions ask of the screens (ScreenHooks), from this node's broker and router. */
export function screenHooks(node: Node, holdsScreen: (thread: string) => boolean): ScreenHooks {
  const b = broker(node);
  return {
    launched: (thread, role, projectId) => b.lead(thread, role, projectId),
    filledSince: (thread, known) => b.credentials.filledSince(thread, known),
    holdsScreen,
    forgetSignins: async (projectId) => {
      try {
        await b.forgetSignins(projectId);
      } catch (e) {
        throw new Error(`bot ${projectId}'s browser sign-ins were not forgotten: ${(e as Error).message}`);
      }
    },
  };
}

/** Wires the broker into the node (Rust `Broker::start`): its local calls, the hub's frames and the heartbeat. */
export function start(node: Node, given?: Broker): Broker {
  const b = broker(node, given);
  const agentOnly = () => new ToolError("forbidden", "A browser session belongs to an agent's session, and this call comes from none.");
  onLocal(node, "session_start", async (thread, call) => {
    if (!thread) throw agentOnly();
    return { op: "session_start", ...(await b.open(thread, String(call.purpose ?? "a browser session"))) };
  });
  onLocal(node, "session_end", async (thread) => {
    if (!thread) throw agentOnly();
    return { op: "session_end", ...(await b.end(thread)) };
  });
  onHub(node, "browser_watch", (f) => b.watch(f as unknown as BrowserWatchFrame));
  onHub(node, "browser_input", (f) => b.input(f as unknown as BrowserInputFrame));
  onHub(node, "browser_control", (f) => b.control(f as unknown as BrowserControlFrame));
  node.area("items").on((thread, item) => void b.item(thread, item));
  // As the Rust node lists them for its sessions (node/link.rs `hello`): live view and takeover, hosting a session for
  // an agent elsewhere (sealed to this node), and ending a screen whose task ended. The agents' Mac lists them too
  // (agents_mac `toolOnly` keeps them): its own screen is a session it hosts for agents on other machines.
  // The hub's runner hosts no session for an agent elsewhere: its screens are its own agents', in their boxes.
  node.area("caps").contribute(() =>
    node.config.runner === true ? [CAP_BROWSER, CAP_SESSION_END, CAP_VAULT_FILL] : [CAP_BROWSER, CAP_SESSION_HOST, CAP_SESSION_SEAL, CAP_SESSION_END, CAP_VAULT_FILL],
  );
  // An agent's claude drives its browser through agent-browser, at this node's proxy (Rust's `SessionHooks::env`
  // and `plugin_dirs`), through the node core's launch area.
  if ((node.config as { agentsMac?: boolean }).agentsMac !== true) {
    node.area("launch").contribute({
      env: (thread, path) => agentBrowserEnv(node.home, thread, b.proxy.url(thread), path),
      pluginDirs: () => agentBrowserPlugins(node.home),
    });
  }
  // Its claude exited: its browser ends with it, before session_route's part ends its screens of other kinds.
  node.area("launch").contribute({ ended: (thread) => b.exited(thread) });
  node.area("hb").contribute((hb) => {
    hb.steps.push(...b.steps());
    hb.busy.screens = (hb.busy.screens ?? 0) + b.count();
  });
  return b;
}
