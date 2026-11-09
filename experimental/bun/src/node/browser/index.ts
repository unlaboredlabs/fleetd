// The node's browser sessions (crates/fleetd/src/node/browser/mod.rs `Broker`): one per agent session at most, on a
// fresh Chrome, reached by the agent only through the CDP proxy (proxy.ts). It answers agent-mcp's `session_start` and
// `session_end` on the node's local socket, takes the hub's `browser_watch`, `browser_input`, `browser_control` and
// `session_end` frames, reports each session to the hub as a `browser_session` lead call in its agent's name, and
// gives the heartbeat each live session's latest step. Each session is recorded (record.ts): its action log from the
// agent's `agent-browser` commands (node.area("items")) and fleetd's own steps, and its video where Playwright's ffmpeg
// is installed, and its DOM trace (the page after each of the agent's commands, session.ts); once it ends the recording
// goes to the hub, tried again each minute until it does.
//
// TODO(bun): 1Password fills and their sealed sessions (credentials.rs, onepassword.rs), cards and secure inputs, kept profiles (Navis), the warm pool and installing Playwright's Chrome.
import { join } from "node:path";
import type { ThreadItem } from "../../shared/sessions.ts";
import type { BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, SessionEndFrame } from "../../shared/screens_wire.ts";
import { type Browser, findChrome, installDir, launch } from "./chrome.ts";
import { CAP_BROWSER, CAP_SESSION_END, CAP_SESSION_HOST, CAP_SESSION_SEAL, RECORDING_FILES } from "../../shared/screens_wire.ts";
import { env as agentBrowserEnv, pluginDirs as agentBrowserPlugins, writePolicy } from "./agent_browser.ts";
import { Proxy } from "./proxy.ts";
import { files as recordedFiles, findFfmpeg, GIVE_UP_MS, giveUp, readMeta, recordingsDir, Scrub, scrubFile, Steps, upload, VideoSink, waitingIn, writeMeta } from "./record.ts";
import { HEIGHT, Session, WIDTH } from "./session.ts";
import { hubCall, type Node, onHub, onLocal, toHub } from "./node.ts";

/** What a session's recording says without ffmpeg. */
export const NO_VIDEO = "no video: this machine has no ffmpeg for it";
/** A session no step touched this long ends (node.json `screenIdleMinutes`, else 30). */
const IDLE_MINUTES = 30;

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

type Open = { session: Session; browser: { close?: () => Promise<void> }; purpose: string; note?: string };

/** How a session's browser starts: the node's Chrome, or a test's. */
export type Launcher = () => Promise<Browser | { cdp: Browser["cdp"]; close?: () => Promise<void> }>;

export class Broker {
  readonly sessions = new Map<string, Open>();
  readonly proxy: Proxy;
  private readonly starting = new Set<string>();
  readonly steps_ = new Steps();
  private readonly housekeeping: Timer;
  /** A session of this node's agent hosted on another machine (session_route): its relay and key. */
  remote: ((thread: string) => { url: string; key: Uint8Array } | undefined) | undefined;
  gone: ((thread: string) => void) | undefined;

  constructor(
    private readonly node: Node,
    private readonly launcher: Launcher = defaultLauncher(node),
  ) {
    this.proxy = Proxy.start(node.home, {
      live: (thread) => this.live(thread),
      remote: (thread) => this.remote?.(thread),
      gone: (thread) => this.gone?.(thread),
    });
    this.housekeeping = setInterval(() => void this.housekeep(), 60_000);
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

  /** The agent's `session_start`: a fresh browser for its session, reported live to the hub. */
  /** A hosted session's secrets for its start (session_route), to scrub its recording with: taken once by `open`. */
  secretsFor(thread: string, secrets: [string, string][]): void {
    this.pendingSecrets.set(thread, secrets);
  }
  private readonly pendingSecrets = new Map<string, [string, string][]>();

  async open(thread: string, purpose: string, given?: [string, string][]): Promise<{ sessionId: string; cdp: string; startMs: number }> {
    const secrets = given ?? this.pendingSecrets.get(thread) ?? [];
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
      let browser: Awaited<ReturnType<Launcher>>;
      try {
        browser = await this.launcher();
      } catch (e) {
        throw new ToolError(
          "failed",
          `The browser didn't start: ${(e as Error).message}`,
          "do without it and say so in your result; a person can check this machine's browser screens in Settings › Hub › Machines",
        );
      }
      // The agent's agent-browser may connect to no other browser (agent_browser.rs `write_policy`).
      writePolicy(this.node.home, thread, false);
      const session = new Session(newId(), thread, browser.cdp);
      session.onControl = () => void this.report(session, "live");
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
      session.recording = { dir, scrub: new Scrub(secrets), steps: this.steps_, video };
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
        await ("child" in browser ? browser.close() : browser.close?.());
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
    await open.browser.close?.();
    const r = session.recording;
    // The text files scrubbed once more whole, with every value the session knew.
    if (r) for (const file of [RECORDING_FILES.actions.name, RECORDING_FILES.dom.name]) scrubFile(join(r.dir, file), r.scrub);
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
   * Every minute: ends sessions no step touched for the idle limit, and sends the recordings still waiting for the
   * hub; one that waited GIVE_UP_MS is reported lost.
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
      if (open.session.control() !== "human" && now - open.session.touched >= idle) await this.end(thread).catch(() => {});
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

  /** Tells the hub how the session is now, in its agent's name. */
  async report(
    session: Session,
    state: BrowserSessionState,
    extra: { endedAt?: string; note?: string; files?: { file: string; bytes: number }[] } = {},
    purpose = [...this.sessions.values()].find((o) => o.session === session)?.purpose,
  ): Promise<void> {
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

  /** The hub ended the task of `threadId`: its screen `sessionId` goes, if it still holds it. */
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
    this.proxy.stop();
  }
}

function defaultLauncher(node: Node): Launcher {
  return async () => {
    const configured = node.config.browser?.chrome;
    const chrome = typeof configured === "string" ? configured : findChrome(installDir(node.home));
    if (!chrome) throw new Error("this machine has no browser installed for sessions");
    return launch(chrome, join(node.home, "browser", "profiles"), process.getuid?.() !== 0);
  };
}

/** The node's broker: `given` (a test's) when it is the first to ask, else the node's own. */
export const broker = (node: Node, given?: Broker) => node.area("browser.broker", (n) => given ?? new Broker(n));

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
  node.area("hb").contribute((hb) => {
    hb.steps.push(...b.steps());
    hb.busy.screens = (hb.busy.screens ?? 0) + b.count();
  });
  return b;
}

/** Whether a command the agent ran drove its browser. */
export const drivesBrowser = (command: string) => command.includes("agent-browser");
