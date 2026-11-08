// One hub connection: auth on every (re)connect, then a fresh snapshot and the event stream from its cursor, so the
// renderer always resyncs and never shows data from a dead link as live. After a drop, the stream picks up after the
// last event the old link applied, when few enough were missed (RESUME_MAX_EVENTS): the renderer keeps what it read
// and the missed events make stale only what they touch, rather than every read going out again. Reconnects with backoff until the key is
// refused (close 4401, or an error before `ready`) or the client is stopped. The event long-poll is silent when
// nothing happens, so the client pings and drops a link whose ping goes unanswered: a half-open socket (Wi-Fi or
// tailnet gone without a sleep, a NAT that forgot it) must not keep showing as live, nor wait on TCP's own retries.
import type { BrowserInput } from "../../shared/contracts";
import type { CallOutcome, HubError, HubFrame, HubState } from "../../shared/hub";
import { MAX_CALL_INPUT_BYTES, type CallRequest, type ChatScope, type OrderFocus } from "../../shared/ipc";
import {
  appUrl,
  backoff,
  CLOSE_GOING_AWAY,
  CLOSE_RESTART,
  CLOSE_UNAUTHORIZED,
  parseServerFrame,
  RESTART_REDIAL_EVERY_MS,
  RESTART_REDIAL_MS,
  type ClientMessage,
  type ServerFrame,
} from "./protocol";
import type { PresenceFrame } from "../presence";
import type { HubSource } from "./source";
import type { Connection, Transport } from "./transport";
import { explainAbandon, explainLoss, type Loss, type SocketError } from "./explain";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** From dialling to `ready`: covers a TCP connect into a black hole, a stalled upgrade and an unanswered auth. */
export const READY_TIMEOUT_MS = 15_000;
export const PING_EVERY_MS = 15_000;
/** A ping with nothing heard since (no byte, no pong) for this long: the link is dead. */
export const PONG_WAIT_MS = 10_000;
/** A link must stay up this long before the backoff starts over, so a hub that accepts and drops isn't hammered. */
export const STABLE_MS = 30_000;
/** A reconnect that missed more events than this reads everything again: replaying them would cost more. */
export const RESUME_MAX_EVENTS = 200;
/** What this client reads compressed: the hub then sends frames as permessage-deflate Binary (transport.ts). */
export const CLIENT_FEATURES = ["deflate"] as const;
/**
 * The auth on the upgrade request too: a hub that reads it sends `ready` and the snapshot right after the 101, a round
 * trip sooner, and takes the `auth` and `snapshot` frames that follow as answered; an older hub ignores the headers.
 */
export const upgradeHeaders = (key: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  "x-fleetd-features": CLIENT_FEATURES.join(","),
});
/** A frame this long or longer goes compressed to a hub that reads `deflate`: an upload's piece, not the chatter. */
export const DEFLATE_UP_BYTES = 16 * 1024;
/** A call frame over this is refused before it's sent. */
export const MAX_FRAME_BYTES = MAX_CALL_INPUT_BYTES + 4096;
/** Presence frames' ids: `p1`, `p2`… (calls' are `c1`, `c2`…). */
const PRESENCE_ID = "p";

export interface HubClientOptions {
  /** As the user typed it; shown in the state. */
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
  readonly emit: (frame: HubFrame) => void;
  /** Jitter source, 0 ≤ r < 1; tests pin it. */
  readonly random?: () => number;
}

interface Pending {
  readonly resolve: (outcome: CallOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const fail = (code: string, message: string, fix?: string): CallOutcome => ({ ok: false, error: { code, message, fix } });

export class HubClient implements HubSource {
  readonly #options: HubClientOptions;
  #state: HubState;
  #connection: Connection | null = null;
  #ready = false;
  #attempt = 0;
  /** When the hub closed the link to restart, epoch ms, until a link is ready again: it redials quickly meanwhile. */
  #restarting: number | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  /** The newest event seq applied on this connection; the stream resumes after it. */
  #cursor: number | null = null;
  /** The newest seq the last link applied, kept through the drop: the next link's first snapshot may resume after it. */
  #resumeFrom: number | null = null;
  /** This link's first snapshot (the one sent with auth) hasn't come yet. */
  #firstSnapshot = false;
  #resumeAttempt = 0;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #nextCallId = 0;
  readonly #pending = new Map<string, Pending>();
  #chat: ChatScope | null = null;
  #focus: OrderFocus | null = null;
  /** Whether any window shows (shown()); the live feed is asked for only then. */
  #shown = true;
  #readyAt = 0;
  /** When anything last came from the hub on this connection. */
  #heardAt = 0;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** This connection's hub reads presence: its `ready` named it, and it hasn't refused a presence frame since. */
  #presence = false;
  /** The hub serves browser sessions (ready's `browser_sessions`): only then go browser_watch and browser_input. */
  #browser = false;
  /** The browser session whose frames to forward; sent again on each connection. */
  #watch: string | null = null;
  /** The hub paces frames to their acks (ready's `frame_acks`): the watch asks for it, and each frame is acked. */
  #frameAcks = false;
  /** The hub sends the Screens page's pictures (ready's `screen_thumbs`). */
  #thumbsServed = false;
  /** This connection's hub reads compressed frames from the app: its `ready` listed `deflate`. */
  #deflateUp = false;
  /** A window shows the Screens page; sent again on each connection. */
  #thumbs = false;
  #nextPresenceId = 0;

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
    this.#restarting = null;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#failPending("disconnected", "The app disconnected from the hub.");
  }

  /** Drops the link and dials again at once, e.g. after the machine wakes, when the socket may be half-open. */
  reconnectNow(): void {
    if (this.#stopped) return;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#dropLink();
    this.#attempt = 0;
    this.#connect();
  }

  call(request: CallRequest): Promise<CallOutcome> {
    if (!this.#ready) {
      return Promise.resolve(fail("offline", "Not connected to the hub.", "Wait for the connection to come back."));
    }
    const id = `c${++this.#nextCallId}`;
    const { tool, input } = request;
    const text = JSON.stringify({ t: "call", id, tool, input } satisfies ClientMessage);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) {
      return Promise.resolve(fail("invalid", `The ${tool} request is too large to send.`));
    }
    return new Promise<CallOutcome>((resolve) => {
      const timeoutMs = request.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#settle(id, fail("timeout", `The hub didn't answer ${tool} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#connection?.send(text, this.#deflateUp && text.length >= DEFLATE_UP_BYTES);
    });
  }

  /** The hub forgets the chat subscription with the socket, so it's sent again on every ready. */
  chat(project: ChatScope | null): void {
    this.#chat = project;
    if (this.#ready) this.#sendChat();
  }

  /** Kept across reconnects, like the chat. */
  focus(workstreamId: OrderFocus | null): void {
    this.#focus = workstreamId;
    if (this.#ready) this.#sendLive();
  }

  /** The hub sends a full live frame after each subscribe, so a window coming back to front asks again. */
  refreshLive(): void {
    if (this.#ready) this.#sendLive();
  }

  /**
   * Whether any window shows. While none does (each hidden or minimized, or none open on macOS) nothing reads the
   * live feed, so it stops; a window showing again asks again, and the hub's first frame after that is full.
   */
  shown(on: boolean): void {
    if (on === this.#shown) return;
    this.#shown = on;
    if (!this.#ready) return;
    if (on) this.#sendLive();
    else this.#send({ t: "live", board: false });
  }

  resync(): void {
    if (this.#ready) this.#send({ t: "snapshot" });
  }

  /**
   * Sent only to a hub whose `ready` names presence, so an older hub never sees it. Dropped while the link is down:
   * a minute missed is a minute not counted, never one sent late.
   */
  watch(session: string | null): void {
    if (this.#watch === session) return;
    this.#watch = session;
    if (this.#ready && this.#browser) this.#sendWatch();
  }

  thumbs(on: boolean): void {
    if (this.#thumbs === on) return;
    this.#thumbs = on;
    if (this.#ready && this.#thumbsServed) this.#send({ t: "screen_thumbs", on });
  }

  input(session: string, input: BrowserInput): void {
    if (this.#ready && this.#browser) this.#send({ t: "browser_input", session, input });
  }

  presence(frame: PresenceFrame): void {
    if (!this.#ready || !this.#presence) return;
    // Its own id, which the hub echoes only on an error for a frame it can't read; calls' ids start with "c".
    this.#send({ t: "presence", id: `${PRESENCE_ID}${++this.#nextPresenceId}`, ...frame });
  }

  #connect(): void {
    const url = appUrl(this.#options.hub);
    if (!url.ok) {
      this.#setState({ phase: "refused", hub: this.#options.hub, message: url.message });
      return;
    }
    this.#setState({ phase: "connecting", hub: this.#options.hub, attempt: this.#attempt, ...this.#restartingField() });
    let opened = false;
    const connection = this.#options.transport(url.url, {
      onOpen: () => {
        if (this.#connection !== connection) return;
        opened = true;
        this.#deflateUp = false;
        this.#heardAt = Date.now();
        // The hub reads frames in order, so the snapshot and the subscriptions every hub reads go with the auth rather
        // than a round trip after `ready`; refused, the hub closes before it reads them. A hub that took the auth on
        // the upgrade has sent `ready` and the snapshot already, and takes these two as answered.
        this.#send({ t: "auth", key: this.#options.key, features: [...CLIENT_FEATURES] });
        this.#firstSnapshot = true;
        this.#send({ t: "snapshot" });
        this.#sendLive();
        if (this.#chat !== null) this.#sendChat();
      },
      onText: (text) => {
        if (this.#connection !== connection) return;
        this.#heardAt = Date.now();
        this.#onFrame(parseServerFrame(text));
      },
      onHeard: () => {
        if (this.#connection === connection) this.#heardAt = Date.now();
      },
      onClose: (code, reason, error) => {
        if (this.#connection !== connection) return;
        this.#connection = null;
        this.#deflateUp = false;
        this.#onClose(code, reason, error, opened);
      },
    }, upgradeHeaders(this.#options.key));
    this.#connection = connection;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      this.#abandon(explainAbandon(this.#options.hub, "not-ready"));
    }, READY_TIMEOUT_MS);
  }

  /** Every PING_EVERY_MS a ping; when nothing at all is heard in the PONG_WAIT_MS after it, the link is given up. */
  #startHeartbeat(): void {
    this.#heartbeat = setInterval(() => {
      const pingAt = Date.now();
      this.#connection?.ping();
      if (this.#pongTimer !== null) clearTimeout(this.#pongTimer);
      this.#pongTimer = setTimeout(() => {
        this.#pongTimer = null;
        if (this.#heardAt < pingAt) this.#abandon(explainAbandon(this.#options.hub, "silent"));
      }, PONG_WAIT_MS);
    }, PING_EVERY_MS);
  }

  /** Drops a link that can't be trusted any more, and retries. */
  #abandon(loss: Loss): void {
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#lost(loss);
  }

  #onFrame(frame: ServerFrame | null): void {
    if (frame === null) return;
    switch (frame.t) {
      case "ready": {
        this.#ready = true;
        this.#readyAt = Date.now();
        this.#restarting = null;
        this.#cursor = null;
        this.#presence = frame.features?.includes("presence") ?? false;
        this.#browser = frame.features?.includes("browser_sessions") ?? false;
        this.#frameAcks = frame.features?.includes("frame_acks") ?? false;
        this.#thumbsServed = frame.features?.includes("screen_thumbs") ?? false;
        this.#deflateUp = frame.features?.includes("deflate") ?? false;
        if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
        this.#readyTimer = null;
        this.#startHeartbeat();
        this.#setState({
          phase: "live",
          hub: this.#options.hub,
          protocol: frame.protocol,
          ...(frame.version === undefined ? {} : { version: frame.version }),
          ...(frame.features === undefined ? {} : { features: frame.features }),
        });
        if (this.#browser && this.#watch !== null) this.#sendWatch();
        if (this.#thumbsServed && this.#thumbs) this.#send({ t: "screen_thumbs", on: true });
        return;
      }
      case "snapshot": {
        const { t: _t, ...snapshot } = frame;
        // A snapshot covers everything up to its cursor, so the stream restarts there; the reconnect's own, after the
        // last event the old link applied, when the gap is small: those events then say what changed meanwhile.
        const from = this.#firstSnapshot ? this.#resumeFrom : null;
        this.#firstSnapshot = false;
        this.#resumeFrom = null;
        const resume = from !== null && snapshot.cursor >= from && snapshot.cursor - from <= RESUME_MAX_EVENTS;
        this.#cursor = resume ? from : snapshot.cursor;
        this.#send({ t: "events", cursor: this.#cursor });
        this.#options.emit(resume ? { t: "snapshot", snapshot, resumed: true } : { t: "snapshot", snapshot });
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
      case "live": {
        const { t: _t, ...live } = frame;
        this.#options.emit({ t: "live", frame: live });
        return;
      }
      case "chat_delta": {
        const { t: _t, ...delta } = frame;
        this.#options.emit({ t: "chat_delta", delta });
        return;
      }
      case "browser_frame": {
        const { t: _t, ...browser } = frame;
        // Only the watched session's: one that was watched before a change can still be on its way.
        if (browser.sessionId !== this.#watch) return;
        // As it comes: the hub sends the next frames as these arrive, so a slow link shows the newest, not a backlog.
        if (this.#frameAcks) this.#send({ t: "browser_frame_ack", seq: browser.seq });
        this.#options.emit({ t: "browser_frame", frame: browser });
        return;
      }
      case "screen_thumb": {
        const { t: _t, ...thumb } = frame;
        // One that was on its way as the page closed is dropped.
        if (this.#thumbs) this.#options.emit({ t: "screen_thumb", thumb });
        return;
      }
      case "result": {
        this.#settle(frame.id, { ok: true, output: frame.output });
        return;
      }
      case "error": {
        const error: HubError = { code: frame.code, message: frame.message, fix: frame.fix, ...(frame.reason === undefined ? {} : { reason: frame.reason }) };
        if (frame.id?.startsWith(PRESENCE_ID) === true) {
          // The hub couldn't read a presence frame: none more on this connection, and the stream is fine as it is.
          this.#presence = false;
        } else if (frame.id !== undefined) {
          this.#settle(frame.id, { ok: false, error });
        } else if (!this.#ready) {
          // Before ready, an error can only be about the key.
          this.#refuse(frame.message);
        } else {
          this.#options.emit({ t: "error", error });
          this.#scheduleResume();
        }
        return;
      }
    }
  }

  /**
   * A session error after ready (the event stream's long-poll failing, say) ends the hub's stream; ask for it again
   * after the last applied event, backing off so a hub that keeps failing isn't hammered.
   */
  #scheduleResume(): void {
    if (this.#cursor === null || this.#resumeTimer !== null) return;
    this.#resumeTimer = setTimeout(() => {
      this.#resumeTimer = null;
      if (this.#ready && this.#cursor !== null) this.#send({ t: "events", cursor: this.#cursor });
    }, backoff(this.#resumeAttempt++));
  }

  #onClose(code: number, reason: string, error: SocketError | undefined, opened: boolean): void {
    if (code === CLOSE_UNAUTHORIZED) {
      this.#refuse(`The hub refused the key${reason === "" ? "" : ` (${reason})`}.`);
      return;
    }
    if (opened && (code === CLOSE_RESTART || code === CLOSE_GOING_AWAY)) this.#restarting ??= Date.now();
    this.#lost(explainLoss(this.#options.hub, code, reason, error, opened));
  }

  #lost({ reason, fix }: Loss): void {
    const wasReady = this.#dropLink();
    this.#clearTimers();
    if (this.#stopped) return;
    if (wasReady && Date.now() - this.#readyAt >= STABLE_MS) this.#attempt = 0;
    // Restarting, every RESTART_REDIAL_EVERY_MS until RESTART_REDIAL_MS, then the backoff from its start. Otherwise ±25 %,
    // so many apps behind one hub that dropped them don't come back in lockstep.
    const quick = this.#restarting !== null && Date.now() - this.#restarting < RESTART_REDIAL_MS;
    if (quick) this.#attempt = 0;
    const retryIn = quick ? RESTART_REDIAL_EVERY_MS : Math.round(backoff(this.#attempt++) * (0.75 + 0.5 * (this.#options.random ?? Math.random)()));
    this.#setState({ phase: "retrying", hub: this.#options.hub, reason, fix, retryAt: Date.now() + retryIn, ...this.#restartingField() });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, retryIn);
  }

  /** Whether the link had been ready. */
  #dropLink(): boolean {
    const wasReady = this.#ready;
    this.#ready = false;
    if (this.#cursor !== null) this.#resumeFrom = this.#cursor;
    this.#cursor = null;
    this.#firstSnapshot = false;
    this.#failPending("disconnected", "The connection to the hub dropped before it answered.");
    return wasReady;
  }

  #refuse(message: string): void {
    this.#ready = false;
    this.#stopped = true;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#failPending("forbidden", message);
    this.#setState({ phase: "refused", hub: this.#options.hub, message });
  }

  #settle(id: string, outcome: CallOutcome): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  }

  #failPending(code: string, message: string): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, fail(code, message));
  }

  #clearTimers(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    if (this.#resumeTimer !== null) clearTimeout(this.#resumeTimer);
    if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    if (this.#pongTimer !== null) clearTimeout(this.#pongTimer);
    this.#pongTimer = null;
    this.#retryTimer = null;
    this.#resumeTimer = null;
    this.#readyTimer = null;
    this.#heartbeat = null;
  }

  #sendWatch(): void {
    this.#send(this.#watch === null ? { t: "browser_watch" } : { t: "browser_watch", session: this.#watch, ...(this.#frameAcks ? { acks: true as const } : {}) });
  }

  #sendChat(): void {
    this.#send(this.#chat === null ? { t: "chat" } : { t: "chat", project: this.#chat });
  }

  /** Every open order's lanes, which the agents strip reads, so the app wants them whenever it shows; plus the focus's text. */
  #sendLive(): void {
    if (!this.#shown) return;
    this.#send(this.#focus === null ? { t: "live", board: true } : { t: "live", board: true, focus: this.#focus });
  }

  #send(message: ClientMessage): void {
    const text = JSON.stringify(message);
    this.#connection?.send(text, this.#deflateUp && text.length >= DEFLATE_UP_BYTES);
  }

  #restartingField(): { restarting?: number } {
    return this.#restarting === null ? {} : { restarting: this.#restarting };
  }

  #setState(state: HubState): void {
    this.#state = state;
    this.#options.emit({ t: "state", state });
  }
}
