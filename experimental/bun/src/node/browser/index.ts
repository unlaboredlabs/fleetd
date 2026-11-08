// The node's browser sessions (crates/fleetd/src/node/browser/mod.rs `Broker`): one per agent session at most, on a
// fresh Chrome, reached by the agent only through the CDP proxy (proxy.ts). It answers agent-mcp's `session_start` and
// `session_end` on the node's local socket, takes the hub's `browser_watch`, `browser_input`, `browser_control` and
// `session_end` frames, reports each session to the hub as a `browser_session` lead call in its agent's name, and
// gives the heartbeat each live session's latest step.
//
// TODO(bun): recordings (record.rs: the action log, DOM trace and video, scrubbed and uploaded with
// `browser_recording_part`), 1Password fills and their sealed sessions (credentials.rs, onepassword.rs), cards and
// secure inputs, kept profiles (Navis), the warm pool and installing Playwright's Chrome. A session here ends
// `recorded` with no files.
import { join } from "node:path";
import type { BrowserControl, BrowserControlTo, BrowserInput, BrowserSessionState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { BrowserControlFrame, BrowserInputFrame, BrowserWatchFrame, SessionEndFrame } from "../../shared/screens_wire.ts";
import { type Browser, findChrome, installDir, launch } from "./chrome.ts";
import { Proxy } from "./proxy.ts";
import { Session } from "./session.ts";
import { hubCall, type Node, onHub, onLocal, toHub } from "./node.ts";

/** What a session's recording says when the Bun node made none. */
export const NO_RECORDING = "no recording: the Bun node records none yet";

const newId = () => `B${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;

type Open = { session: Session; browser: { close?: () => Promise<void> }; purpose: string };

/** How a session's browser starts: the node's Chrome, or a test's. */
export type Launcher = () => Promise<Browser | { cdp: Browser["cdp"]; close?: () => Promise<void> }>;

export class Broker {
  readonly sessions = new Map<string, Open>();
  readonly proxy: Proxy;
  private readonly starting = new Set<string>();
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
  async open(thread: string, purpose: string): Promise<{ sessionId: string; cdp: string; startMs: number }> {
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
      const session = new Session(newId(), thread, browser.cdp);
      session.onControl = () => void this.report(session, "live");
      this.sessions.set(thread, { session, browser, purpose });
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
  async end(thread: string): Promise<{ sessionId: string; kind: "browser"; files: never[]; note: string }> {
    const open = this.sessions.get(thread);
    if (!open) throw new ToolError("not_found", "No browser session is open.", "start one with session_start");
    this.sessions.delete(thread);
    open.session.end();
    await open.browser.close?.();
    await this.report(open.session, "recorded", { endedAt: new Date().toISOString(), note: NO_RECORDING }, open.purpose);
    return { sessionId: open.session.id, kind: "browser", files: [], note: NO_RECORDING };
  }

  /** Tells the hub how the session is now, in its agent's name. */
  async report(
    session: Session,
    state: BrowserSessionState,
    extra: { endedAt?: string; note?: string } = {},
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
    if (next) session.setControl(next);
    void this.report(session, "live");
  }

  /** The hub ended the task of `threadId`: its screen `sessionId` goes, if it still holds it. */
  sessionEnd(frame: SessionEndFrame): void {
    const open = this.sessions.get(frame.threadId);
    if (open?.session.id === frame.sessionId) void this.end(frame.threadId).catch(() => {});
  }

  /** Each live session's latest step, for the heartbeat. */
  steps(): { sessionId: string; step: unknown }[] {
    return [...this.sessions.values()].flatMap((o) => (o.session.step ? [{ sessionId: o.session.id, step: o.session.step }] : []));
  }

  async shutdown(): Promise<void> {
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
  node.area("hb").contribute((hb) => {
    hb.steps.push(...b.steps());
    hb.busy.screens = (hb.busy.screens ?? 0) + b.count();
  });
  return b;
}
