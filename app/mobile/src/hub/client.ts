// One hub connection, as the desktop app's (app/desktop/src/main/hub/client.ts) but for a phone: auth on every
// (re)connect with the snapshot and the open chat's stream asked for in the same breath (the hub reads them in order, so
// it costs no round trip), then the event stream: from the snapshot's cursor, or, back from a drop that missed only a
// few, from the last event applied, so what was missed replays rather than everything being read again (the
// desktop's resume too). The screens always resync and never show a dead link as live. The phone
// asks for compressed frames (inflate.ts); a hub that offers them sends them, an older one plain text. Reconnects with backoff until the key is refused (close 4401, or an error before `ready`) or
// the client is stopped. React Native's WebSocket can't ping, so a quiet link is probed with a small call (hub_info)
// and dropped when it goes unanswered: a phone that changed networks must not keep showing as live. Coming back to the
// front, a live link is asked for a sign of life and kept when one comes, rather than dropped and dialled again: what
// the screens show (approvals, older pages, an upload) stays; back from long behind, a fresh link races that ask and
// the first to show life is kept (RACE_AFTER_BEHIND_MS). While the app is in front, a quiet link is probed sooner
// and retries wait less. One screen at a
// time can be watched (browser_watch, sent again on each ready, as the desktop's main does): its frames come as
// `browser_frame`s, and a person's touches on a screen they took over go as `browser_input`.
import { leadLaneId, type BrowserFrame, type BrowserInput, type CallOutcome, type ChatDelta, type FleetStatus, type HubError, type HubEvent, type HubState, type LiveFrame, type ProjectRef, type ToolInput, type ToolName, type ToolOutput } from "../desktop";
import { MAX_FPS, type Navigation } from "../screen";
import { DEFLATE_FEATURE, FrameInflater } from "./inflate";

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** From dialling to `ready`. */
export const READY_TIMEOUT_MS = 15_000;
/** How often a live link's silence is looked at. */
export const PROBE_EVERY_MS = 5_000;
/** Quiet this long, the link is probed: in front (no sooner, so a cellular radio can still idle), and behind. */
export const QUIET_FRONT_MS = 10_000;
const QUIET_BEHIND_MS = 15_000;
/**
 * Nothing heard for this long, the link is dead: in front, and behind. In front that is one probe gone unanswered for
 * a whole tick (PROBE_EVERY_MS), which on a link with any life takes well under a second.
 */
export const SILENT_DEAD_FRONT_MS = QUIET_FRONT_MS + PROBE_EVERY_MS;
export const SILENT_DEAD_MS = 35_000;
/** Back in front, a live link answers a probe within this, or it is dialled again. */
export const WAKE_PROBE_MS = 2_500;
/**
 * Behind longer than this, a link that was live may have died meanwhile (the hub pings a quiet link every 25 s, and a
 * cellular NAT forgets one in 30): back in front, a fresh link is dialled while the old one is asked for a sign of
 * life, and the first to show life is kept, so a dead link costs the dial alone rather than WAKE_PROBE_MS first.
 */
export const RACE_AFTER_BEHIND_MS = 25_000;
/** In front, a retry waits at most this long: someone is looking at "Connecting…". */
export const FRONT_BACKOFF_CAP_MS = 5_000;
/** A link must stay up this long before the backoff starts over. */
const STABLE_MS = 30_000;
/** Back from a drop, the stream replays from the last event applied when the snapshot is at most this many past it. */
export const REPLAY_MAX = 200;
/** The hub's close code for a refused key. */
const CLOSE_UNAUTHORIZED = 4401;
/**
 * The hub's close codes when it stops to restart, back in seconds: 1012 (service restart) from a hub that says so, 1001
 * (going away) from one before it, which closes that way for an update or a restart by hand.
 */
const CLOSE_RESTART = new Set([1012, 1001]);
/**
 * After the hub closed the link to restart, it is dialled every RESTART_RETRY_MS for this long rather than backing
 * off, so the phone is back as soon as the hub is; then the usual backoff.
 */
export const RESTART_FAST_MS = 60_000;
export const RESTART_RETRY_MS = 250;
/** Probe calls' ids: `h1`, `h2`… (calls' are `c1`, `c2`…); their answers are only proof of life. */
const PROBE_ID = "h";

export interface ConnectionEvents {
  onOpen(): void;
  onText(text: string): void;
  /** A Binary message: a compressed frame (inflate.ts). */
  onBinary(data: ArrayBuffer): void;
  /** Exactly once, also after a failed connect (1006). */
  onClose(code: number, reason: string): void;
}

export interface Connection {
  send(text: string): void;
  close(): void;
}

/**
 * Opens one connection to a hub's /app socket URL, `headers` on its upgrade request: React Native's WebSocket in the
 * app (socket.ts), a fake in tests.
 */
export type Transport = (url: string, events: ConnectionEvents, headers?: Readonly<Record<string, string>>) => Connection;

/** What the client hands the app. After a `state` with phase `live`, a `snapshot` always precedes events. */
export type HubFrame =
  | { readonly t: "state"; readonly state: HubState }
  /** `replay`: the events since the last one applied before a drop follow it, so what they touch needn't be read again. */
  | { readonly t: "snapshot"; readonly snapshot: FleetStatus; readonly replay?: true }
  /** `replayed`: one the snapshot before it already covers (seq at or before its cursor), missed while the link was down. */
  | { readonly t: "event"; readonly event: HubEvent; readonly replayed?: true }
  | { readonly t: "chat_delta"; readonly delta: ChatDelta }
  /** The open chat's lead lane: what it does this moment. */
  | { readonly t: "live"; readonly frame: LiveFrame }
  /** The watched screen's newest frame. Ephemeral: the hub skips frames a slow link can't take. */
  | { readonly t: "browser_frame"; readonly frame: BrowserFrame }
  /** The hub refused a touch, a key or a page move just sent (browser_input, which it answers only to refuse). */
  | { readonly t: "browser_error"; readonly error: HubError }
  | { readonly t: "error"; readonly error: HubError }
  /**
   * The hub closed the link to restart (close 1012, or 1001 from an older hub), before the `state` that says the
   * link is down: a planned restart, not an outage. `reason` is the hub's own words for it.
   */
  | { readonly t: "restart"; readonly code: number; readonly reason: string };

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

/** A link dialled beside the live one (RACE_AFTER_BEHIND_MS): its frames wait, unread, until it is kept or closed. */
interface Spare {
  connection: Connection | null;
  readonly frames: string[];
  ready: boolean;
}

type ServerFrame =
  | { t: "ready"; protocol: number; version?: string; features?: string[] }
  | ({ t: "snapshot" } & FleetStatus)
  | ({ t: "event" } & HubEvent)
  | { t: "result"; id: string; output: unknown }
  | { t: "error"; id?: string; code: string; message: string; fix?: string; reason?: string }
  | ({ t: "chat_delta" } & ChatDelta)
  | ({ t: "live" } & LiveFrame)
  | ({ t: "browser_frame" } & BrowserFrame);

const KNOWN = new Set(["ready", "snapshot", "event", "result", "error", "chat_delta", "live", "browser_frame"]);

/** An id-less error this soon after a browser_input refuses it, not the event stream. */
export const INPUT_REFUSAL_MS = 3000;

/** The `ready` feature that says the hub reads browser_watch and browser_input (contracts app.rs APP_FEATURES). */
const SCREENS_FEATURE = "browser_sessions";
/** The `ready` feature that says the hub paces a watch's frames to their acks (contracts app.rs APP_FEATURES). */
const FRAME_ACKS_FEATURE = "frame_acks";

/** A frame this client reads, or null: not JSON, or a `t` it has no use for (a newer hub's). */
const parseFrame = (text: string): ServerFrame | null => {
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
  /** Until when (epoch ms) a lost link is dialled again fast: the hub said it was restarting. */
  #restartUntil = 0;
  #readyAt = 0;
  #heardAt = 0;
  /** When the probe's timer last ran: a tick far later than that means the app slept. */
  #tickAt = 0;
  /** Whether the app is in front, where the link is watched closer. */
  #front = true;
  /** When the app went behind; null in front. */
  #behindAt: number | null = null;
  #spare: Spare | null = null;
  /** The newest event seq applied on this connection; the stream resumes after it. */
  #cursor: number | null = null;
  /** The last event applied before the link dropped: the next snapshot's stream may replay from it. */
  #resumeFrom: number | null = null;
  /** The snapshot's cursor, while the events up to it replay. */
  #replayTo = -1;
  #resumeAttempt = 0;
  #nextId = 0;
  #chat: ProjectRef | null = null;
  /** The screen watched, which goes again on each ready; null: none. */
  #watching: string | null = null;
  #screens = false;
  /** The hub paces frames to their acks: the watch asks for it, sent no more than the phone draws, and each frame is
   * acked as it comes. */
  #frameAcks = false;
  /** When the last browser_input went: an id-less error soon after refuses it. */
  #inputAt = -Infinity;
  /** A compressed frame failed to inflate: later connections ask for plain text, rather than fail the same way again. */
  #plain = false;
  readonly #pending = new Map<string, Pending>();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #probe: ReturnType<typeof setInterval> | null = null;
  /** A sign of life asked for (askAlive), until it is due. */
  #aliveTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.#dropSpare();
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#dropLink("The app disconnected from the hub.");
    // Started again (another hub, or after a Disconnect), it reads everything.
    this.#resumeFrom = null;
  }

  /**
   * The app came back to the front: a live link may have died while it slept, so it is asked for a sign of life and
   * dialled again only if none comes; a link waiting out its backoff dials now.
   */
  wake(): void {
    if (this.#stopped) return;
    const behind = this.#behindAt === null ? 0 : Date.now() - this.#behindAt;
    this.#behindAt = null;
    this.#front = true;
    if (!this.#ready) return this.#dialNow();
    this.#askAlive();
    // Behind long enough that the link may be gone: a fresh one races the probe.
    if (behind > RACE_AFTER_BEHIND_MS && this.#spare === null) this.#dialSpare();
  }

  /**
   * The phone's network changed (Wi-Fi to cellular, a network back): a live link is asked for a sign of life, as one
   * on the network left behind dies without a word, and one waiting out its backoff or still dialling on the old
   * network dials now.
   */
  networkChanged(): void {
    if (this.#stopped) return;
    if (this.#ready) return this.#askAlive();
    if (this.#connection === null) return this.#dialNow();
    this.reconnectNow();
  }

  #dialNow(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#attempt = 0;
    this.#connect();
  }

  /** The app went behind: its link is watched as before, with the longer silences. */
  sleep(): void {
    this.#front = false;
    this.#behindAt = Date.now();
  }

  /** Drops the link and dials again at once. */
  reconnectNow(): void {
    if (this.#stopped) return;
    this.#dropSpare();
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
    this.#connection = this.#open();
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      this.#abandon(`${this.#options.hub} didn't answer within ${String(READY_TIMEOUT_MS / 1000)} s`);
    }, READY_TIMEOUT_MS);
  }

  /** A link beside the live one, whose frames wait until it is kept (adoptSpare) or closed (dropSpare). */
  #dialSpare(): void {
    const spare: Spare = { connection: null, frames: [], ready: false };
    this.#spare = spare;
    spare.connection = this.#open();
  }

  /** The live link or the spare beside it. */
  #mine(connection: Connection): boolean {
    return connection === this.#connection || connection === this.#spare?.connection;
  }

  /** One connection, the live one or a spare: what it sends on open, and where its frames go. */
  #open(): Connection {
    let opened = false;
    // Each connection's compressed frames are one stream, read with an inflater of its own.
    const inflater = new FrameInflater();
    const features = this.#plain ? [] : [DEFLATE_FEATURE];
    // The auth rides the upgrade too: a hub that reads it sends `ready` and the snapshot right after the 101, a round
    // trip sooner, and takes the `auth` and `snapshot` below as answered; an older hub ignores the headers.
    const headers = { authorization: `Bearer ${this.#options.key}`, "x-fleetd-features": features.join(",") };
    const connection: Connection = this.#options.transport(socketUrl(this.#options.hub), {
      onOpen: () => {
        if (!this.#mine(connection)) return;
        opened = true;
        if (connection === this.#connection) this.#heardAt = Date.now();
        const send = (message: Record<string, unknown>) => connection.send(JSON.stringify(message));
        send(features.length === 0 ? { t: "auth", key: this.#options.key } : { t: "auth", key: this.#options.key, features });
        send({ t: "snapshot" });
        if (this.#chat !== null) this.#sendChat(send);
      },
      onText: (text) => this.#take(connection, text),
      onBinary: (data) => {
        if (!this.#mine(connection)) return;
        const text = inflater.text(data);
        if (text !== null) return this.#take(connection, text);
        // What follows a frame that won't inflate can't be read either: dial again, plain.
        this.#plain = true;
        if (connection === this.#connection) this.#abandon("A frame from the hub didn't inflate");
        else this.#dropSpare();
      },
      onClose: (code, reason) => {
        // A spare that failed: the probe still decides the live link.
        if (connection === this.#spare?.connection) {
          this.#spare = null;
          return;
        }
        if (this.#connection !== connection) return;
        this.#connection = null;
        if (code === CLOSE_UNAUTHORIZED) this.#refuse(`The hub refused the key${reason === "" ? "" : ` (${reason})`}.`);
        // The old link ended while a fresh one was on its way: that one is the link now.
        else if (this.#spare !== null) this.#adoptSpare();
        else if (CLOSE_RESTART.has(code) && this.#ready) {
          this.#restartUntil = Date.now() + RESTART_FAST_MS;
          this.#options.emit({ t: "restart", code, reason });
          this.#lost(`${this.#options.hub} is restarting`);
        } else this.#lost(opened ? "The connection to the hub dropped" : `Can't reach ${this.#options.hub}`);
      },
    }, headers);
    return connection;
  }

  /** A frame from `connection`: read when it is the live link's, held when it is the spare's. */
  #take(connection: Connection, text: string): void {
    if (connection === this.#connection) {
      this.#heardAt = Date.now();
      // The live link shows life: the spare racing it isn't needed.
      this.#dropSpare();
      return this.#onFrame(parseFrame(text));
    }
    const spare = this.#spare;
    if (spare === null || connection !== spare.connection) return;
    spare.frames.push(text);
    // The spare is ready before the live link said a word since it was asked: that one is taken as gone.
    if (parseFrame(text)?.t === "ready") {
      spare.ready = true;
      this.#adoptSpare();
    }
  }

  /** The spare becomes the link: the old one is closed, and what the spare already brought is read in order. */
  #adoptSpare(): void {
    const spare = this.#spare;
    if (spare === null || spare.connection === null) return;
    this.#spare = null;
    const old = this.#connection;
    this.#connection = null;
    old?.close();
    this.#clearTimers();
    this.#dropLink("The connection to the hub dropped before it answered.");
    this.#attempt = 0;
    this.#connection = spare.connection;
    this.#heardAt = Date.now();
    if (!spare.ready) {
      this.#setState({ phase: "connecting", hub: this.#options.hub, attempt: 0 });
      this.#readyTimer = setTimeout(() => {
        this.#readyTimer = null;
        this.#abandon(`${this.#options.hub} didn't answer within ${String(READY_TIMEOUT_MS / 1000)} s`);
      }, READY_TIMEOUT_MS);
    }
    for (const text of spare.frames) this.#onFrame(parseFrame(text));
  }

  #dropSpare(): void {
    const spare = this.#spare;
    if (spare === null) return;
    this.#spare = null;
    spare.connection?.close();
  }

  #startProbe(): void {
    this.#tickAt = Date.now();
    this.#probe = setInterval(() => {
      const now = Date.now();
      // A tick this late: the app slept (iOS stops its timers behind), which is no silence of the hub's. Ask.
      const slept = now - this.#tickAt > 2 * PROBE_EVERY_MS;
      this.#tickAt = now;
      if (slept) return this.#askAlive();
      if (this.#aliveTimer !== null) return;
      const quiet = now - this.#heardAt;
      if (quiet >= (this.#front ? SILENT_DEAD_FRONT_MS : SILENT_DEAD_MS)) this.#abandon("The hub stopped answering");
      else if (quiet >= (this.#front ? QUIET_FRONT_MS : QUIET_BEHIND_MS)) this.#sendProbe();
    }, PROBE_EVERY_MS);
  }

  #sendProbe(): void {
    this.#send({ t: "call", id: `${PROBE_ID}${String(++this.#nextId)}`, tool: "hub_info", input: {} });
  }

  /** A probe now: anything heard within WAKE_PROBE_MS keeps the link, silence dials again. */
  #askAlive(): void {
    if (this.#aliveTimer !== null) return;
    const asked = Date.now();
    this.#sendProbe();
    this.#aliveTimer = setTimeout(() => {
      this.#aliveTimer = null;
      if (this.#heardAt >= asked) return;
      // A spare already on its way is the redial.
      if (this.#spare !== null) this.#adoptSpare();
      else this.reconnectNow();
    }, WAKE_PROBE_MS);
  }

  #abandon(reason: string): void {
    if (this.#spare !== null) return this.#adoptSpare();
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
        this.#restartUntil = 0;
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
        this.#frameAcks = frame.features?.includes(FRAME_ACKS_FEATURE) === true;
        if (this.#watching !== null && this.#screens) this.#sendWatch();
        return;
      }
      case "snapshot": {
        const { t: _t, ...snapshot } = frame;
        // A snapshot covers everything up to its cursor, so the stream restarts there; back from a drop that missed
        // only a few, after the last one applied, so the ones missed replay.
        const from = this.#resumeFrom;
        this.#resumeFrom = null;
        const replay = from !== null && snapshot.cursor >= from && snapshot.cursor - from <= REPLAY_MAX;
        this.#cursor = replay ? from : snapshot.cursor;
        this.#replayTo = replay ? snapshot.cursor : -1;
        this.#send({ t: "events", cursor: this.#cursor });
        this.#options.emit(replay ? { t: "snapshot", snapshot, replay: true } : { t: "snapshot", snapshot });
        return;
      }
      case "event": {
        const { t: _t, ...event } = frame;
        // A replaced or resumed stream can repeat what was already applied.
        if (this.#cursor !== null && event.seq <= this.#cursor) return;
        this.#cursor = event.seq;
        this.#resumeAttempt = 0;
        this.#options.emit(event.seq <= this.#replayTo ? { t: "event", event, replayed: true } : { t: "event", event });
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
        if (shown.sessionId !== this.#watching) return;
        // As it comes: the hub sends the next frames as these arrive, so a slow link shows the newest, not a backlog.
        if (this.#frameAcks) this.#send({ t: "browser_frame_ack", seq: shown.seq });
        this.#options.emit({ t: "browser_frame", frame: shown });
        return;
      }
      case "result": {
        this.#settle(frame.id, { ok: true, output: frame.output });
        return;
      }
      case "error": {
        const error: HubError = { code: frame.code, message: frame.message, fix: frame.fix, ...(frame.reason === undefined ? {} : { reason: frame.reason }) };
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
    // A restarting hub is back in seconds: dialled every RESTART_RETRY_MS till it is, the backoff kept for after.
    const fast = Date.now() < this.#restartUntil;
    const wait = fast ? RESTART_RETRY_MS : this.#front ? Math.min(backoff(this.#attempt++), FRONT_BACKOFF_CAP_MS) : backoff(this.#attempt++);
    // Else ±25 %, so many phones behind one restarting hub don't come back in lockstep.
    const retryIn = fast ? wait : Math.round(wait * (0.75 + 0.5 * (this.#options.random ?? Math.random)()));
    this.#setState({ phase: "retrying", hub: this.#options.hub, reason, retryAt: Date.now() + retryIn });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, retryIn);
  }

  #dropLink(message: string): void {
    this.#ready = false;
    // A link that dropped before its snapshot applied nothing: the one before it is still where to resume.
    if (this.#cursor !== null) this.#resumeFrom = this.#cursor;
    this.#cursor = null;
    for (const id of [...this.#pending.keys()]) this.#settle(id, fail("disconnected", message));
  }

  #refuse(message: string): void {
    this.#stopped = true;
    this.#dropSpare();
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
    if (this.#aliveTimer !== null) clearTimeout(this.#aliveTimer);
    this.#aliveTimer = null;
    this.#retryTimer = null;
    this.#readyTimer = null;
    this.#resumeTimer = null;
    this.#probe = null;
  }

  #sendChat(send = (message: Record<string, unknown>) => this.#send(message)): void {
    send(this.#chat === null ? { t: "chat" } : { t: "chat", project: this.#chat });
    // One agent's lane, the lead's: no board, which the phone doesn't show.
    send(this.#chat === null ? { t: "live", board: false } : { t: "live", board: false, agent: leadLaneId(this.#chat) });
  }

  #sendWatch(): void {
    this.#send(this.#watching === null ? { t: "browser_watch" } : { t: "browser_watch", session: this.#watching, ...(this.#frameAcks ? { acks: true, fps: MAX_FPS } : {}) });
  }

  #send(message: Record<string, unknown>): void {
    this.#connection?.send(JSON.stringify(message));
  }

  #setState(state: HubState): void {
    this.#state = state;
    this.#options.emit({ t: "state", state });
  }
}
