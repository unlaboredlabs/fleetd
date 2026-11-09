// The node's browser sessions (crates/fleetd/src/node/browser/mod.rs `Broker`): one per agent session at most, on a
// warm Chrome from the pool (a fresh process with an empty profile, thrown away at the end), reached by the agent only
// through the CDP proxy (proxy.ts). It answers agent-mcp's browser calls (through node/device's router), takes the
// hub's `browser_watch`, `browser_input`, `browser_control` and `session_end` frames, reports each session to the hub
// as a `browser_session` lead call in its agent's name, and gives the heartbeat each live session's latest step. Each
// session is recorded (record.ts): its action log from the agent's `agent-browser` commands (node.area("items")) and
// fleetd's own steps, its video where Playwright's ffmpeg is installed, and its DOM trace (the page after each of the
// agent's commands and each fill, session.ts); once it ends the recording goes to the hub, tried again each minute
// until it does.
//
// What a session may do beyond driving: fill a login from 1Password (credentials.ts), pay at a checkout with an
// approved card (cards.ts), and take a value only the person may type (secure_input.ts). From the first fill on, the
// session is sealed: every answer to the agent is scrubbed of the values, and the proxy lets through a narrower list.
//
// A lead (a project with no repo, as a Navi's did, or one with repos whose browser the hub places here) runs its
// sessions on the profile its project keeps (D221, D310; chrome.ts `Kept`), not a fresh one, and a person's screen for
// a project of this machine's runs on it too. One browser at a time runs on a kept profile.
//
// Where Playwright's Chrome or agent-browser is missing, the node installs the pinned builds in the background as it
// starts, and a session's start waits for that install up to INSTALL_WAIT_MS.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ThreadItem } from "../../shared/sessions.ts";
import type { BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserCallFrame, BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, SessionEndFrame } from "../../shared/screens_wire.ts";
import { findChrome, install as installChrome, installDir, Kept, keptDir, type Launched, launch, Pool } from "./chrome.ts";
import { CAP_BROWSER, CAP_SESSION_END, CAP_SESSION_HOST, CAP_SESSION_SEAL, RECORDING_FILES } from "../../shared/screens_wire.ts";
import {
  env as agentBrowserEnv,
  find as findAgentBrowser,
  install as installAgentBrowser,
  pluginDirs as agentBrowserPlugins,
  VERSION as AGENT_BROWSER_VERSION,
  writePolicy,
} from "./agent_browser.ts";
import { purchaseFill, purchaseRequest, WAIT_ON_PERSON_MS } from "./cards.ts";
import { Credentials, type FillCredentialCall, fillCredential, filledFieldRefusal, outgoing, remoteVault, type SessionVault, unread } from "./credentials.ts";
import type { Credential } from "./onepassword.ts";
import { Proxy } from "./proxy.ts";
import { files as recordedFiles, findFfmpeg, GIVE_UP_MS, giveUp, readMeta, recordingsDir, scrubFile, Steps, upload, VideoSink, waitingIn, writeMeta } from "./record.ts";
import { deliver as deliverSecureInput, fillApproved, request as requestSecureInput, type Waiting } from "./secure_input.ts";
import { HEIGHT, Session, WIDTH } from "./session.ts";
import { hubCall, type Node, onHub, onLocal, toHub } from "./node.ts";
import type { ScreenHooks, SessionsArea } from "../api.ts";
import type { SecretDeliver, SecretResult } from "../wire.ts";

/** What a session's recording says without ffmpeg. */
export const NO_VIDEO = "no video: this machine has no ffmpeg for it";
/** A session no step touched this long ends (node.json `screenIdleMinutes`, else 30). */
const IDLE_MINUTES = 30;
/** How long a session's start waits for the browser's install in progress: with the browser's launch after it,
 * inside the agent's wait for the node's answer (60 s). */
export const INSTALL_WAIT_MS = 30_000;

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

type Open = { session: Session; browser: Launched; purpose: string; note?: string };

/** How a session's browser starts: the node's Chrome through its pool, or a test's, on a fresh profile or `kept`. */
export type Launcher = (kept?: string) => Promise<Launched>;

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
type Navi = {
  name: string;
  /** A person's screen, or a lead with repos: with the kept profile busy, it opens on a fresh one rather than not at all. */
  freshIfBusy: boolean;
  /** Its browser runs on this machine, never one the hub would pick: a lead that does its own work. */
  staysHere: boolean;
};

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

export class Broker {
  readonly sessions = new Map<string, Open>();
  readonly proxy: Proxy;
  private readonly starting = new Set<string>();
  readonly steps_ = new Steps();
  private readonly housekeeping: Timer;
  /** A session of this node's agent hosted on another machine (session_route): its relay and key. */
  remote: ((thread: string) => { url: string; key: Uint8Array } | undefined) | undefined;
  gone: ((thread: string) => void) | undefined;
  /** 1Password: each session's vault and what it resolved, and each agent session's filled values. */
  readonly credentials: Credentials;
  /** The typed secure inputs sessions wait for, by browser session and request (secure_input.ts). */
  readonly waiting = new Map<string, Waiting>();
  /** Payment-provider hosts a card may fill in beyond cards.ts's PAYMENT_FRAMES (tests: a fake provider). */
  readonly extraPaymentFrames: string[] = [];
  /** The project of each agent session whose browser runs on its kept profile, by the agent session. */
  private readonly navis = new Map<string, Navi>();
  readonly kept: Kept;
  private install: Install;
  private readonly installer: Installer;
  /** Told when the install is done, ready or failed: the starts waiting on it. */
  private installDone: (() => void)[] = [];
  /** Reports and calls for the hub, sent in order (a takeover request never reaches the hub before its session). */
  private reports: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly node: Node,
    launcher?: Launcher,
    options: BrokerOptions = {},
  ) {
    this.home = node.home;
    this.credentials = new Credentials(node.home);
    this.kept = new Kept(node.home);
    this.installer = options.installer ?? PINNED;
    this.install = { kind: "wanted" };
    if (launcher) this.install = { kind: "ready", pool: new Pool((_sandboxed, kept) => launcher(kept), options.warm ?? 0) };
    this.warmSize = options.warm ?? 1;
    this.proxy = Proxy.start(node.home, {
      live: (thread) => this.live(thread),
      remote: (thread) => this.remote?.(thread),
      gone: (thread) => this.gone?.(thread),
      writeRefusal: (session, command) => this.writeRefusal(session, command),
    });
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
  }
  readonly home: string;
  private readonly warmSize: number;
  /** Why a sealed session refuses the driver's DOM write (a test's stand-in, or credentials.ts's). */
  writeRefusal: (session: Session, command: Record<string, unknown>) => Promise<string | undefined> = filledFieldRefusal;

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
      (sandboxed, kept) => launch(chrome, profiles, sandboxed && process.getuid?.() !== 0, kept),
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

  live(thread: string): Session | undefined {
    return this.sessions.get(thread)?.session;
  }

  byId(id: string): Session | undefined {
    for (const o of this.sessions.values()) if (o.session.id === id) return o.session;
    return undefined;
  }

  count(): number {
    return this.sessions.size;
  }

  /** A hosted session's secrets for its start (session_route), to scrub its recording with: taken once by `open`. */
  secretsFor(thread: string, secrets: [string, string][]): void {
    this.pendingSecrets.set(thread, secrets);
  }
  private readonly pendingSecrets = new Map<string, [string, string][]>();

  /** The agent session's own secrets, as the node's sessions hold them (none for a session hosted for elsewhere). */
  private ownSecrets(thread: string): [string, string][] {
    return this.sessionsArea()?.secretsFor?.(thread) ?? [];
  }

  /** The node's sessions, where the node core set them up (a test's node may have none). */
  sessionsArea(): SessionsArea | undefined {
    try {
      return this.node.area("sessions");
    } catch {
      return undefined;
    }
  }

  /** The agent's `session_start`: a browser for its session, reported live to the hub. */
  async open(thread: string, purpose: string, given?: [string, string][]): Promise<{ sessionId: string; cdp: string; startMs: number }> {
    const secrets = given ?? this.pendingSecrets.get(thread);
    this.pendingSecrets.delete(thread);
    const started = performance.now();
    const open = this.sessions.get(thread);
    if (open) {
      throw new ToolError(
        "invalid",
        `Your browser session ${open.session.id} is open already.`,
        "use it, or end it with session_end before starting another",
      );
    }
    if (this.starting.has(thread)) throw new ToolError("invalid", "Your browser session is starting already.", "wait for it");
    this.starting.add(thread);
    try {
      const pool = await this.pool();
      const navi = this.navis.get(thread);
      // One browser at a time runs on a kept profile: a person's screen meanwhile opens on a fresh one, signed out.
      let lease: ReturnType<Kept["take"]> | undefined;
      if (navi) {
        try {
          lease = this.kept.take(navi.name);
        } catch (e) {
          if (!navi.freshIfBusy) {
            throw new ToolError(
              "invalid",
              `${(e as Error).message}: it keeps the project's sign-ins, and one browser at a time runs on them.`,
              "end that session first (session_end there), or wait for it to end, then session_start again",
            );
          }
        }
      }
      let browser: Launched;
      try {
        browser = lease ? await pool.takeKept(lease) : await pool.take();
      } catch (e) {
        throw new ToolError(
          "failed",
          `The browser didn't start: ${(e as Error).message}`,
          "do without it and say so in your result; a person can check this machine's browser screens in Settings › Hub › Machines",
        );
      }
      let own: [string, string][];
      try {
        own = secrets ?? this.ownSecrets(thread);
      } catch (e) {
        await browser.close?.().catch(() => {});
        throw new ToolError(
          "failed",
          `The node could not read this session's secrets to scrub its recording (${(e as Error).message}).`,
          "try again; if it keeps failing, check the node's log",
        );
      }
      // The agent's agent-browser may connect to no other browser (agent_browser.rs `write_policy`).
      writePolicy(this.node.home, thread, false);
      const session = new Session(newId(), thread, browser.cdp, own);
      session.onControl = () => {
        session.stepAt("agent_resumed", {}, true, undefined, 0);
        void this.report(session, "live");
      };
      session.outgoingHook = outgoing;
      const dir = join(recordingsDir(this.node.home), session.id);
      writeMeta(dir, { sessionId: session.id, kind: "browser", threadId: thread, cwd: "/", purpose, startedAt: session.startedAt, credentialsFilled: 0 });
      const ffmpeg = findFfmpeg(installDir(this.node.home));
      let video: VideoSink | undefined;
      let note: string | undefined = ffmpeg ? undefined : NO_VIDEO;
      try {
        video = ffmpeg ? new VideoSink(ffmpeg, join(dir, "video.webm"), [WIDTH, HEIGHT]) : undefined;
      } catch (e) {
        note = `no video: ${(e as Error).message}`;
      }
      session.recording = { dir, steps: this.steps_, video };
      this.sessions.set(thread, {
        session,
        browser,
        purpose,
        ...(note ? { note } : {}),
      });
      try {
        await session.start();
      } catch (e) {
        this.sessions.delete(thread);
        await browser.close?.().catch(() => {});
        throw new ToolError("failed", `The browser didn't start: ${(e as Error).message}`);
      }
      await this.report(session, "live");
      return { sessionId: session.id, cdp: this.proxy.url(thread), startMs: Math.round(performance.now() - started) };
    } finally {
      this.starting.delete(thread);
    }
  }

  /** The agent's `session_end`, or the hub's: closes the browser and reports the session ended. */
  async end(thread: string): Promise<{ sessionId: string; kind: "browser"; files: { file: string; bytes: number }[]; note?: string }> {
    const open = this.sessions.get(thread);
    if (!open) throw new ToolError("not_found", "No browser session is open.", "start one with session_start");
    this.sessions.delete(thread);
    const { session } = open;
    // Every step's DOM capture queued so far lands first, while the page is still there.
    await session.flushCaptures();
    session.end();
    this.credentials.forget(session.id);
    for (const key of [...this.waiting.keys()]) if (key.startsWith(`${session.id}/`)) this.waiting.delete(key);
    await open.browser.close?.();
    const r = session.recording;
    // The text files scrubbed once more whole, with every value the session knew.
    if (r) for (const file of [RECORDING_FILES.actions.name, RECORDING_FILES.dom.name]) scrubFile(join(r.dir, file), session.scrub());
    let note = open.note;
    if (r?.video) {
      const why = await r.video.finish(session.offsetMs());
      if (why) note = `no video: ${why}`;
    }
    const endedAt = new Date().toISOString();
    if (!r) {
      await this.report(session, "recorded", { endedAt, ...(note ? { note } : {}) }, open.purpose);
      return { sessionId: session.id, kind: "browser", files: [], ...(note ? { note } : {}) };
    }
    const meta = readMeta(r.dir);
    if (meta) writeMeta(r.dir, { ...meta, endedAt, credentialsFilled: session.credentialsFilled, ...(note ? { note } : {}) });
    const made = recordedFiles(r.dir).map(([file, bytes]) => ({ file, bytes }));
    // Off the agent's call: a large video takes a while to reach the hub, and housekeeping tries again if it doesn't.
    void this.send(r.dir);
    return { sessionId: session.id, kind: "browser", files: made, ...(note ? { note } : {}) };
  }

  /** A session's meta with how many values it filled, after a fill. */
  filledMeta(session: Session): void {
    const dir = session.recording?.dir;
    const meta = dir ? readMeta(dir) : undefined;
    if (dir && meta) writeMeta(dir, { ...meta, credentialsFilled: session.credentialsFilled });
  }

  /** The session's 1Password vault: the one made at its first fill, or a new one with the token from its secrets. */
  vault(session: Session): SessionVault {
    return this.credentials.vaultBy(session.id, () => this.ownSecrets(session.threadId));
  }

  /** A reference read from this machine's 1Password, with the token from agent session `thread`'s secrets, for its
   * session whose browser runs on another machine: only the value goes there (sealed), never the token. */
  async resolveCredential(thread: string, reference: string): Promise<Credential> {
    const vault = this.credentials.vaultBy(remoteVault(thread), () => this.ownSecrets(thread));
    try {
      return await vault.cache.get(vault.vault, reference);
    } catch (e) {
      throw unread(reference, e);
    }
  }

  /** One browser call of an agent's for its session here, other than its start and end (node/device's router). */
  async call(thread: string, frame: BrowserCallFrame, given?: Credential): Promise<{ op: string } & Record<string, unknown>> {
    const call = frame.call as { op: string } & Record<string, unknown>;
    switch (call.op) {
      case "session_start":
        return { op: "session_start", ...(await this.open(thread, String(call.purpose ?? "a browser session"))) };
      case "session_end":
        return { op: "session_end", ...(await this.end(thread)) };
      case "request_takeover":
        return { op: "request_takeover", ...(await this.requestTakeover(thread, String(call.reason ?? ""))) };
      case "fill_credential":
        return { op: "fill_credential", ...(await fillCredential(this, thread, call as FillCredentialCall, given)) };
      case "purchase_request":
        return { op: "purchase_request", ...(await purchaseRequest(this, thread, call)) };
      case "purchase_fill":
        return { op: "purchase_fill", ...(await purchaseFill(this, thread, call)) };
      case "request_secure_input":
        return { op: "request_secure_input", ...(await requestSecureInput(this, thread, call)) };
      case "secure_input_fill":
        return { op: "secure_input_fill", ...(await fillApproved(this, thread, call)) };
      case "desktop":
        throw new ToolError("invalid", "The desktop tool drives desktop sessions, not browsers.", "drive the browser with agent-browser");
      case "device":
        throw new ToolError("not_found", "No iOS session is open.", "start a simulator with mac sim start; agent-device then drives it");
      default:
        throw new ToolError("invalid", `${call.op} is not a browser call.`);
    }
  }

  /** The sealed value of a `fill:` sink from the hub: a person's secure input, typed into its session's field. */
  deliver(frame: SecretDeliver, boxKey: { open(sealed: Uint8Array): Uint8Array | null } | undefined, machine: string): Promise<SecretResult> {
    return deliverSecureInput(this, frame, boxKey, machine);
  }

  /** An agent's `request_takeover`: the hub lists it under "waiting on you". */
  private async requestTakeover(thread: string, reason: string): Promise<{ message: string }> {
    const session = this.live(thread);
    if (!session) throw new ToolError("not_found", "No browser session is open.", "start one with session_start");
    await this.inTurn(session, "browser_takeover", { sessionId: session.id, reason });
    // A person may take a while (a bank's confirmation, a captcha): the session waits for them, and a held fare or room
    // with it.
    session.hold(WAIT_ON_PERSON_MS);
    session.stepAt("request_takeover", { reason }, true, undefined, 0);
    return {
      message:
        "Asked: it shows under waiting on you. Carry on with what you can; while a person has control your browser commands answer so, and after they hand it back your next one sees the page as they left it.",
    };
  }

  /** A call about a session for the hub, after every report before it, and its answer. */
  inTurn(session: Session, op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.inOrder(() => hubCall(this.node, op, args, { threadId: session.threadId }));
  }

  /** Runs `fn` after every report and call queued before it: at once when none is. */
  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn().finally(() => (this.queued -= 1));
    const answer = this.queued === 0 ? run() : this.reports.then(run);
    this.queued += 1;
    this.reports = answer.catch(() => {});
    return answer;
  }
  private queued = 0;

  /** A person's screen `key` for project `project` of this machine's, as the hub's own frame names it (D239): on its
   * kept profile, or a fresh one while that profile is busy. */
  personScreen(key: string, project: string): void {
    this.navis.set(key, { name: project, freshIfBusy: true, staysHere: true });
  }

  /** The agent session's claude launched as a lead of `project` (ScreenHooks `launched`). */
  lead(thread: string, role: string, project: string): void {
    if (role === "assistant") this.navis.set(thread, { name: project, freshIfBusy: false, staysHere: true });
    else if (role === "lead") this.navis.set(thread, { name: project, freshIfBusy: true, staysHere: false });
  }

  /** Whether the agent session's browser runs on this machine whatever the hub would pick: a lead that does its own
   * work, whose kept profile is here. */
  staysHere(thread: string): boolean {
    return this.navis.get(thread)?.staysHere ?? false;
  }

  /** Whether the agent session is a project's lead: its browser runs here, on its project's kept profile. */
  isNavi(thread: string): boolean {
    return this.navis.has(thread);
  }

  /** The agent session ended: it is no project's lead any more. */
  notNavi(thread: string): void {
    this.navis.delete(thread);
  }

  /** The agent session's claude exited (the launch area's `ended`, before session_route ends its screens elsewhere):
   * its browser session here ends now, and what it filled is let go. */
  exited(thread: string): void {
    this.credentials.ended(thread);
    this.credentials.forget(remoteVault(thread));
    this.notNavi(thread);
    const open = this.sessions.get(thread);
    if (!open) return;
    open.session.stepAt("agent_session_ended", {}, true, undefined, 0);
    void this.end(thread).catch(() => {});
  }

  /**
   * Forgets project `project`'s sign-ins: the browser session of any of its agent sessions ends (its recording goes to
   * the hub as at any end), then its kept profile is deleted once that browser has let go of it.
   */
  async forgetSignins(project: string): Promise<void> {
    if (!keptDir(this.home, project)) return;
    for (const [thread, navi] of this.navis) {
      const open = this.sessions.get(thread);
      if (navi.name !== project || !open) continue;
      open.session.stepAt("signins_forgotten", {}, true, undefined, 0);
      void this.end(thread).catch(() => {});
    }
    await this.kept.wipe(project);
  }

  /** A finished session's recording to the hub; kept for the next try when the hub didn't take it. */
  /** Recordings on their way to the hub now: one upload per folder, as the Rust broker keeps one `uploading` task. */
  private readonly uploading = new Set<string>();
  private housekeepingNow = false;

  private async send(dir: string): Promise<boolean> {
    // An upload starts at offset 0, which cuts short one still going: never two of one folder.
    if (this.uploading.has(dir)) return false;
    this.uploading.add(dir);
    try {
      await upload((thread, cwd, op, args) => hubCall(this.node, op, args, { threadId: thread, cwd }), dir);
      return true;
    } catch (e) {
      console.warn(`browser recording ${dir}: not uploaded yet: ${(e as Error).message}`);
      return false;
    } finally {
      this.uploading.delete(dir);
    }
  }

  /**
   * Every minute: ends sessions no step touched for the idle limit (none while they wait on a person), and sends the
   * recordings still waiting for the hub; one that waited GIVE_UP_MS is reported lost.
   */
  async housekeep(now = Date.now()): Promise<void> {
    // A run that outlasts the minute isn't joined by the next.
    if (this.housekeepingNow) return;
    this.housekeepingNow = true;
    try {
      await this.housekeepOnce(now);
    } finally {
      this.housekeepingNow = false;
    }
  }

  private async housekeepOnce(now: number): Promise<void> {
    const idle = (Number(this.node.config.screenIdleMinutes) || IDLE_MINUTES) * 60_000;
    for (const [thread, open] of this.sessions) {
      if (open.session.control() !== "human" && open.session.idleFor(now) >= idle) await this.end(thread).catch(() => {});
    }
    // One a stopped node left unended (this one's or a Rust node's) is ended with a note, and goes too.
    const live = [...this.sessions.values()].map((o) => o.session.id);
    for (const dir of waitingIn(recordingsDir(this.node.home), live, now)) {
      const meta = readMeta(dir);
      if (!meta?.endedAt) continue;
      if (now - Date.parse(meta.endedAt) >= GIVE_UP_MS) {
        await giveUp((thread, cwd, op, args) => hubCall(this.node, op, args, { threadId: thread, cwd }), dir, "its recording never reached the hub").catch(() => {});
        continue;
      }
      await this.send(dir);
    }
  }

  /** A finished thread item of `thread`'s: an `agent-browser` command is a step of its live session. */
  item(thread: string, item: ThreadItem): boolean {
    const open = this.sessions.get(thread);
    const kind = item.kind;
    if (!open || kind.type !== "command" || !drivesBrowser(kind.command)) return false;
    if (item.status !== "completed" && item.status !== "failed") return false;
    const end = item.completedAt ? Date.parse(item.completedAt) : Number.NaN;
    const durationMs = Number.isNaN(end) ? 0 : Math.max(end - Date.parse(item.startedAt), 0);
    const ok = item.status === "completed" && (kind.exitCode === undefined || kind.exitCode === 0);
    open.session.agentStep(kind.command, ok, kind.output, durationMs);
    return true;
  }

  /** Tells the hub how the session is now, in its agent's name, after what was reported before. */
  report(
    session: Session,
    state: BrowserSessionState,
    extra: { endedAt?: string; note?: string; files?: { file: string; bytes: number }[] } = {},
    purpose = [...this.sessions.values()].find((o) => o.session === session)?.purpose,
  ): Promise<void> {
    return this.inOrder(async () => {
      try {
        await hubCall(this.node, "browser_session", {
          threadId: session.threadId,
          sessionId: session.id,
          kind: "browser",
          purpose: purpose ?? "a browser session",
          state,
          control: session.control(),
          startedAt: session.startedAt,
          files: [],
          credentialsFilled: session.credentialsFilled,
          ...extra,
        }, { threadId: session.threadId });
      } catch (e) {
        console.warn(`browser ${session.id}: not reported to the hub: ${(e as Error).message}`);
      }
    });
  }

  watch(frame: BrowserWatchFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    if (!frame.on) return session.setWatcher(undefined);
    if (session.watched()) return session.setBudget(frame.kbps);
    session.setWatcher({
      kbps: frame.kbps,
      send: (f) => toHub(this.node, { t: "browser_frame", ...f }),
    });
  }

  input(frame: BrowserInputFrame): void {
    const session = this.byId(frame.sessionId);
    // Queued behind what came before it: each input lands in order.
    if (session) this.inputs = this.inputs.then(() => session.input(frame.input as BrowserInput).catch(() => {}));
  }
  private inputs: Promise<void> = Promise.resolve();

  /** A person takes a session over, or hands it back; the hub waits for the node to say who drives, changed or not. */
  control(frame: BrowserControlFrame): void {
    const session = this.byId(frame.sessionId);
    if (!session) return;
    const to: BrowserControlTo = frame.control;
    const now = session.control();
    let next: BrowserControl | undefined;
    if (to === "human" && now !== "human") next = "human";
    else if (to === "agent" && now === "human") next = "handing_back";
    if (next) {
      session.setControl(next);
      session.stepAt(next === "human" ? "takeover" : "handback", { by: frame.by }, true, undefined, 0);
    }
    void this.report(session, "live");
  }

  /** The hub ended the task of `threadId`: its screen `sessionId` goes, if it still holds it. Its claude runs on: it is
   * still its project's lead, for its next session_start. */
  sessionEnd(frame: SessionEndFrame): void {
    const open = this.sessions.get(frame.threadId);
    if (open?.session.id === frame.sessionId) void this.end(frame.threadId).catch(() => {});
  }

  /** Each live session's latest step, for the heartbeat. */
  steps(): { sessionId: string; step: unknown }[] {
    return this.steps_.list();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.housekeeping);
    for (const thread of [...this.sessions.keys()]) await this.end(thread).catch(() => {});
    if (this.install.kind === "ready") await this.install.pool.drain();
    this.proxy.stop();
  }
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
        throw new Error(`project ${projectId}'s browser sign-ins were not forgotten: ${(e as Error).message}`);
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
  node.area("caps").contribute(() => [CAP_BROWSER, CAP_SESSION_HOST, CAP_SESSION_SEAL, CAP_SESSION_END]);
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

/** Whether a command the agent ran drove its browser. */
export const drivesBrowser = (command: string) => command.includes("agent-browser");
