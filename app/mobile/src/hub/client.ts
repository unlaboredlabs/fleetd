// One hub connection, as the desktop app's (app/desktop/src/main/hub/client.ts) but for a phone: auth on every
// (re)connect, then a fresh snapshot and the event stream from its cursor, so the screens always resync and never show
// a dead link as live. Reconnects with backoff until the key is refused (close 4401, or an error before `ready`) or
// the client is stopped. React Native's WebSocket can't ping, so a quiet link is probed with a small call (hub_info)
// and dropped when nothing comes back: a phone that changed networks must not keep showing as live. One screen at a
// time can be watched (browser_watch, sent again on each ready, as the desktop's main does): its frames come as
// `browser_frame`s, and a person's touches on a screen they took over go as `browser_input`.
import { leadLaneId, type BrowserFrame, type BrowserInput, type CallOutcome, type ChatDelta, type FleetStatus, type HubError, type HubEvent, type HubState, type LiveFrame, type ProjectRef, type ToolInput, type ToolName, type ToolOutput } from "../desktop";
import type { Navigation } from "../screen";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** From dialling to `ready`. */
export const READY_TIMEOUT_MS = 15_000;
export const PROBE_EVERY_MS = 15_000;
/** Nothing heard for this long: the link is dead. */
export const SILENT_DEAD_MS = 35_000;
/** A link must stay up this long before the backoff starts over. */
export const STABLE_MS = 30_000;
/** The hub's close code for a refused key. */
export const CLOSE_UNAUTHORIZED = 4401;
/** Probe calls' ids: `h1`, `h2`… (calls' are `c1`, `c2`…); their answers are only proof of life. */
const PROBE_ID = "h";

export interface ConnectionEvents {
  onOpen(): void;
  onText(text: string): void;
  /** Exactly once, also after a failed connect (1006). */
  onClose(code: number, reason: string): void;
}

export interface Connection {
  send(text: string): void;
  close(): void;
}

/** Opens one connection to a hub's /app socket URL: React Native's WebSocket in the app (socket.ts), a fake in tests. */
export type Transport = (url: string, events: ConnectionEvents) => Connection;

/** What the client hands the app. After a `state` with phase `live`, a `snapshot` always precedes events. */
export type HubFrame =
  | { readonly t: "state"; readonly state: HubState }
  | { readonly t: "snapshot"; readonly snapshot: FleetStatus }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "chat_delta"; readonly delta: ChatDelta }
  /** The open chat's lead lane: what it does this moment. */
  | { readonly t: "live"; readonly frame: LiveFrame }
  /** The watched screen's newest frame. Ephemeral: the hub skips frames a slow link can't take. */
  | { readonly t: "browser_frame"; readonly frame: BrowserFrame }
  /** The hub refused a touch, a key or a page move just sent (browser_input, which it answers only to refuse). */
  | { readonly t: "browser_error"; readonly error: HubError }
  | { readonly t: "error"; readonly error: HubError };

export interface HubClientOptions {
  /** The hub's HTTP origin, as paired: `http://devbox:4790`. */
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
  readonly emit: (frame: HubFrame) => void;
  /** Jitter source, 0 ≤ r < 1; tests pin it. */
  readonly random?: () => number;
}

export type Typed<T extends ToolName> = { readonly ok: true; readonly output: ToolOutput<T> } | { readonly ok: false; readonly error: HubError };

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 30 s cap. */
export const backoff = (attempt: number): number => Math.min(500 * 2 ** Math.min(attempt, 6), 30_000);

/** `http(s)://host[:port]` → the hub's `ws(s)://host[:port]/app` socket URL. */
export const socketUrl = (origin: string): string => `${origin.replace(/^http/u, "ws").replace(/\/+$/u, "")}/app`;

const fail = (code: string, message: string, fix?: string): CallOutcome => ({ ok: false, error: { code, message, fix } });

interface Pending {
  readonly resolve: (outcome: CallOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type ServerFrame =
  | { t: "ready"; protocol: number; version?: string; features?: string[] }
  | ({ t: "snapshot" } & FleetStatus)
  | ({ t: "event" } & HubEvent)
  | { t: "result"; id: string; output: unknown }
  | { t: "error"; id?: string; code: string; message: string; fix?: string }
  | ({ t: "chat_delta" } & ChatDelta)
  | ({ t: "live" } & LiveFrame)
  | ({ t: "browser_frame" } & BrowserFrame);

const KNOWN = new Set(["ready", "snapshot", "event", "result", "error", "chat_delta", "live", "browser_frame"]);

/** An id-less error this soon after a browser_input refuses it, not the event stream. */
export const INPUT_REFUSAL_MS = 3000;

/** The `ready` feature that says the hub reads browser_watch and browser_input (contracts app.rs APP_FEATURES). */
export const SCREENS_FEATURE = "browser_sessions";

/** A frame this client reads, or null: not JSON, or a `t` it has no use for (a newer hub's). */
export const parseFrame = (text: string): ServerFrame | null => {
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json !== "object" || json === null) return null;
    const t = (json as { t?: unknown }).t;
    return typeof t === "string" && KNOWN.has(t) ? (json as ServerFrame) : null;
  } catch {
    return null;
  }
};

export class HubClient {
  readonly #options: HubClientOptions;
  #state: HubState;
  #connection: Connection | null = null;
  #ready = false;
  #stopped = true;
  #attempt = 0;
  #readyAt = 0;
  #heardAt = 0;
  /** The newest event seq applied on this connection; the stream resumes after it. */
  #cursor: number | null = null;
  #resumeAttempt = 0;
  #nextId = 0;
  #chat: ProjectRef | null = null;
  /** The screen watched, which goes again on each ready; null: none. */
  #watching: string | null = null;
  #screens = false;
  /** When the last browser_input went: an id-less error soon after refuses it. */
  #inputAt = -Infinity;
  readonly #pending = new Map<string, Pending>();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #probe: ReturnType<typeof setInterval> | null = null;

  constructor(options: HubClientOptions) {
    this.#options = options;
    this.#state = { phase: "connecting", hub: options.hub, attempt: 0 };
  }

  get state(): HubState {
    return this.#state;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#dropLink("The app disconnected from the hub.");
  }

  /** Drops the link and dials again at once: the app came back to the front, or the network changed. */
  reconnectNow(): void {
    if (this.#stopped) return;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#dropLink("The connection to the hub dropped before it answered.");
    this.#attempt = 0;
    this.#connect();
  }

  call<T extends ToolName>(tool: T, input: ToolInput<T>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<Typed<T>> {
    if (!this.#ready) {
      return Promise.resolve(fail("offline", "Not connected to the hub.", "Wait for the connection to come back.") as Typed<T>);
    }
    const id = `c${String(++this.#nextId)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(id, fail("timeout", `The hub didn't answer ${tool} within ${String(Math.round(timeoutMs / 1000))} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (o) => resolve(o as Typed<T>), timer });
      this.#send({ t: "call", id, tool, input });
    });
  }

  /**
   * Streamed text for one project's chat, and its lead's live lane (what it does this moment, for the turn line); null
   * stops both. The hub forgets them with the socket, so they go on each ready.
   */
  chat(project: ProjectRef | null): void {
    this.#chat = project;
    if (this.#ready) this.#sendChat();
  }

  /**
   * Watch one screen's live frames (null stops): replaces any earlier watch, and goes again on each ready, as the hub
   * forgets it with the socket. Sent only to a hub that reads it.
   */
  watch(sessionId: string | null): void {
    if (this.#watching === sessionId) return;
    this.#watching = sessionId;
    if (this.#ready && this.#screens) this.#sendWatch();
  }

  /** A person's touch or typing on a screen they took over; dropped while there's no link, as a stale tap must not land later. */
  input(sessionId: string, input: BrowserInput | Navigation): void {
    if (!this.#ready || !this.#screens) return;
    this.#inputAt = Date.now();
    this.#send({ t: "browser_input", session: sessionId, input });
  }

  /** A fresh snapshot, from which the event stream restarts. */
  resync(): void {
    if (this.#ready) this.#send({ t: "snapshot" });
  }

  #connect(): void {
    this.#setState({ phase: "connecting", hub: this.#options.hub, attempt: this.#attempt });
    let opened = false;
    const connection = this.#options.transport(socketUrl(this.#options.hub), {
      onOpen: () => {
        if (this.#connection !== connection) return;
        opened = true;
        this.#heardAt = Date.now();
        this.#send({ t: "auth", key: this.#options.key });
      },
      onText: (text) => {
        if (this.#connection !== connection) return;
        this.#heardAt = Date.now();
        this.#onFrame(parseFrame(text));
      },
      onClose: (code, reason) => {
        if (this.#connection !== connection) return;
        this.#connection = null;
        if (code === CLOSE_UNAUTHORIZED) this.#refuse(`The hub refused the key${reason === "" ? "" : ` (${reason})`}.`);
        else this.#lost(opened ? "The connection to the hub dropped" : `Can't reach ${this.#options.hub}`);
      },
    });
    this.#connection = connection;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      this.#abandon(`${this.#options.hub} didn't answer within ${String(READY_TIMEOUT_MS / 1000)} s`);
    }, READY_TIMEOUT_MS);
  }

  #startProbe(): void {
    this.#probe = setInterval(() => {
      const quiet = Date.now() - this.#heardAt;
      if (quiet >= SILENT_DEAD_MS) this.#abandon("The hub stopped answering");
      else if (quiet >= PROBE_EVERY_MS) this.#send({ t: "call", id: `${PROBE_ID}${String(++this.#nextId)}`, tool: "hub_info", input: {} });
    }, PROBE_EVERY_MS);
  }

  #abandon(reason: string): void {
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#lost(reason);
  }

  #onFrame(frame: ServerFrame | null): void {
    if (frame === null) return;
    switch (frame.t) {
      case "ready": {
        this.#ready = true;
        this.#readyAt = Date.now();
        this.#cursor = null;
        if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
        this.#readyTimer = null;
        this.#startProbe();
        this.#setState({
          phase: "live",
          hub: this.#options.hub,
          protocol: frame.protocol,
          ...(frame.version === undefined ? {} : { version: frame.version }),
          ...(frame.features === undefined ? {} : { features: frame.features }),
        });
        this.#screens = frame.features?.includes(SCREENS_FEATURE) === true;
        this.#send({ t: "snapshot" });
        if (this.#chat !== null) this.#sendChat();
        if (this.#watching !== null && this.#screens) this.#sendWatch();
        return;
      }
      case "snapshot": {
        const { t: _t, ...snapshot } = frame;
        // A snapshot covers everything up to its cursor, so the stream restarts there.
        this.#cursor = snapshot.cursor;
        this.#send({ t: "events", cursor: snapshot.cursor });
        this.#options.emit({ t: "snapshot", snapshot });
        return;
      }
      case "event": {
        const { t: _t, ...event } = frame;
        // A replaced or resumed stream can repeat what was already applied.
        if (this.#cursor !== null && event.seq <= this.#cursor) return;
        this.#cursor = event.seq;
        this.#resumeAttempt = 0;
        this.#options.emit({ t: "event", event });
        return;
      }
      case "chat_delta": {
        const { t: _t, ...delta } = frame;
        this.#options.emit({ t: "chat_delta", delta });
        return;
      }
      case "live": {
        const { t: _t, ...live } = frame;
        this.#options.emit({ t: "live", frame: live });
        return;
      }
      case "browser_frame": {
        const { t: _t, ...shown } = frame;
        // Only the screen watched now: one from the watch it replaced may still be on its way.
        if (shown.sessionId === this.#watching) this.#options.emit({ t: "browser_frame", frame: shown });
        return;
      }
      case "result": {
        this.#settle(frame.id, { ok: true, output: frame.output });
        return;
      }
      case "error": {
        const error: HubError = { code: frame.code, message: frame.message, fix: frame.fix };
        if (frame.id?.startsWith(PROBE_ID) === true) return;
        if (frame.id !== undefined) this.#settle(frame.id, { ok: false, error });
        else if (!this.#ready) this.#refuse(frame.message);
        else {
          // The hub answers a browser_input only to refuse it: one soon after is likely that, the live view's to say.
          // Ask for the events again all the same, in case it was the event stream's: asking again costs nothing.
          this.#options.emit(Date.now() - this.#inputAt < INPUT_REFUSAL_MS ? { t: "browser_error", error } : { t: "error", error });
          this.#scheduleResume();
        }
        return;
      }
    }
  }

  /** A session error after ready ends the hub's event stream: ask again after the last applied event, backing off. */
  #scheduleResume(): void {
    if (this.#cursor === null || this.#resumeTimer !== null) return;
    this.#resumeTimer = setTimeout(() => {
      this.#resumeTimer = null;
      if (this.#ready && this.#cursor !== null) this.#send({ t: "events", cursor: this.#cursor });
    }, backoff(this.#resumeAttempt++));
  }

  #lost(reason: string): void {
    const wasReady = this.#ready;
    this.#dropLink("The connection to the hub dropped before it answered.");
    this.#clearTimers();
    if (this.#stopped) return;
    if (wasReady && Date.now() - this.#readyAt >= STABLE_MS) this.#attempt = 0;
    // ±25 %, so many phones behind one restarting hub don't come back in lockstep.
    const retryIn = Math.round(backoff(this.#attempt++) * (0.75 + 0.5 * (this.#options.random ?? Math.random)()));
    this.#setState({ phase: "retrying", hub: this.#options.hub, reason, retryAt: Date.now() + retryIn });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, retryIn);
  }

  #dropLink(message: string): void {
    this.#ready = false;
    this.#cursor = null;
    for (const id of [...this.#pending.keys()]) this.#settle(id, fail("disconnected", message));
  }

  #refuse(message: string): void {
    this.#stopped = true;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#ready = false;
    for (const id of [...this.#pending.keys()]) this.#settle(id, fail("forbidden", message));
    this.#setState({ phase: "refused", hub: this.#options.hub, message });
  }

  #settle(id: string, outcome: CallOutcome): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
    if (this.#resumeTimer !== null) clearTimeout(this.#resumeTimer);
    if (this.#probe !== null) clearInterval(this.#probe);
    this.#retryTimer = null;
    this.#readyTimer = null;
    this.#resumeTimer = null;
    this.#probe = null;
  }

  #sendChat(): void {
    this.#send(this.#chat === null ? { t: "chat" } : { t: "chat", project: this.#chat });
    // One agent's lane, the lead's: no board, which the phone doesn't show.
    this.#send(this.#chat === null ? { t: "live", board: false } : { t: "live", board: false, agent: leadLaneId(this.#chat) });
  }

  #sendWatch(): void {
    this.#send(this.#watching === null ? { t: "browser_watch" } : { t: "browser_watch", session: this.#watching });
  }

  #send(message: Record<string, unknown>): void {
    this.#connection?.send(JSON.stringify(message));
  }

  #setState(state: HubState): void {
    this.#state = state;
    this.#options.emit({ t: "state", state });
  }
}
