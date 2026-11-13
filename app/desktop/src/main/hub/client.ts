// One hub connection: auth on every (re)connect, then a fresh snapshot and the event stream from its cursor, so the
// renderer always resyncs and never shows data from a dead link as live. After a drop, the stream picks up after the
// last event the old link applied, when few enough were missed (RESUME_MAX_EVENTS): the renderer keeps what it read
// and the missed events make stale only what they touch, rather than every read going out again. Reconnects with backoff until the key is
// refused (close 4401, or an error before `ready`) or the client is stopped. The event long-poll is silent when
// nothing happens, so the client pings and drops a link whose ping goes unanswered: a half-open socket (Wi-Fi or
// tailnet gone without a sleep, a NAT that forgot it) must not keep showing as live, nor wait on TCP's own retries.
// A wake (woke(): the computer resumed) drops the link at once and dials again on a short deadline, about once a second
// for WAKE_FAST_MS; the screen unlocking or the network coming back (probe()) ping the link first and do that only if it
// doesn't answer in WAKE_PROBE_MS, as a plain unlock leaves a healthy link: an attempt that went out before the tailnet was
// back would otherwise hold the next one off for all of READY_TIMEOUT_MS, though a fresh dial gets through at once.
import type { BrowserInput } from "../../shared/contracts";
import { WAKE_QUIET_MS, type CallOutcome, type HubError, type HubFrame, type HubState } from "../../shared/hub";
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
  updatingTo,
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
/**
 * The same just after a wake, or three times the last link's own, whichever is longer: a link as slow as before still
 * makes it, and one that went out before the network was usable is dropped for a fresh one within about a second.
 */
export const WAKE_READY_TIMEOUT_MS = 1_000;
/** On an unlock or the network back, a live link that doesn't answer a ping in this long is taken as dead. */
export const WAKE_PROBE_MS = 1_000;
/** Just after a wake, attempts start at least this far apart: one failing at once (no route yet) doesn't spin. */
export const WAKE_REDIAL_EVERY_MS = 500;
/**
 * How long after a wake it dials that way, until a link is ready: Tailscale can take most of a minute to come back after
 * a Mac sleeps. Then the backoff from its start. The screens stay quiet for the first WAKE_QUIET_MS of it.
 */
export const WAKE_FAST_MS = 120_000;
/**
 * A hub this app was connected to this recently has the right address and a fleetd that speaks to it: a failure says
 * so (the network, the hub's machine) rather than send the person to check the address or update the hub.
 */
export const ADVICE_AFTER_MS = WAKE_FAST_MS;
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
  /** The attempts since the link was last up: the screens read 0 as a first connect, and more as one that failed. */
  #attempt = 0;
  /** Of #attempt, those dialled fast after a wake: counted, so the screens say it failed, but no step of the backoff. */
  #fastDials = 0;
  /** When the hub closed the link to restart or stop, epoch ms, until a link is ready again: it redials quickly meanwhile. */
  #restarting: number | null = null;
  /** The build it restarts into, when the close said it updates. */
  #updatingTo: string | null = null;
  /** When the link was last dialled again for a wake (woke()), epoch ms, until a link is ready again. */
  #wakeAt: number | null = null;
  /** The link up now was dialled for a wake. */
  #wokeLink = false;
  /** A link has been ready since start(). */
  #everReady = false;
  /** When the last ready link dropped, epoch ms, until one is ready again. */
  #downSince: number | null = null;
  /** When this attempt dialled, and how long the last link took from dialling to `ready`. */
  #dialAt = 0;
  #handshakeMs = 0;
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
  /** When anything last came from the hub on this connection, and how many times anything has. */
  #heardAt = 0;
  #heardCount = 0;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.#fastDials = 0;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#restarting = null;
    this.#updatingTo = null;
    this.#wakeAt = null;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#failPending("disconnected", "The app disconnected from the hub.");
  }

  /**
   * The computer woke from sleep: the link is most likely half-open, and an attempt running may have gone out before the
   * network was usable. Both are dropped and it dials at once, then fast (see the top). A link dialled for a wake that
   * came up in the last WAKE_QUIET_MS is kept.
   */
  woke(): void {
    if (this.#stopped) return;
    if (this.#ready && this.#wokeLink && Date.now() - this.#readyAt < WAKE_QUIET_MS) return;
    this.#redialForWake();
  }

  /**
   * The screen unlocked or the network came back: the link may be fine (an unlock with no sleep), or dead. A live one
   * is pinged and kept, calls in flight with it, if anything at all comes back within WAKE_PROBE_MS; otherwise it goes
   * as on a wake. One not live dials at once, then fast.
   */
  probe(): void {
    if (this.#stopped) return;
    if (!this.#ready) return this.#redialForWake();
    if (this.#probeTimer !== null) return;
    const heard = this.#heardCount;
    this.#connection?.ping();
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = null;
      if (this.#ready && this.#heardCount === heard) this.#redialForWake();
    }, WAKE_PROBE_MS);
  }

  #heard(): void {
    this.#heardAt = Date.now();
    this.#heardCount++;
  }

  #redialForWake(): void {
    this.#wakeAt = Date.now();
    this.reconnectNow();
  }

  /** Drops the link and dials again at once: Retry now, and a wake. */
  reconnectNow(): void {
    if (this.#stopped) return;
    this.#clearTimers();
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
    this.#dropLink();
    this.#attempt = 0;
    this.#fastDials = 0;
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
    this.#setState({ phase: "connecting", hub: this.#options.hub, attempt: this.#attempt, ...this.#awayFields() });
    this.#dialAt = Date.now();
    let opened = false;
    const connection = this.#options.transport(url.url, {
      onOpen: () => {
        if (this.#connection !== connection) return;
        opened = true;
        this.#deflateUp = false;
        this.#heard();
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
        this.#heard();
        this.#onFrame(parseServerFrame(text));
      },
      onHeard: () => {
        if (this.#connection === connection) this.#heard();
      },
      onClose: (code, reason, error) => {
        if (this.#connection !== connection) return;
        this.#connection = null;
        this.#deflateUp = false;
        this.#onClose(code, reason, error, opened);
      },
    }, upgradeHeaders(this.#options.key));
    this.#connection = connection;
    const deadline = this.#waking(this.#dialAt) ? Math.min(Math.max(WAKE_READY_TIMEOUT_MS, 3 * this.#handshakeMs), READY_TIMEOUT_MS) : READY_TIMEOUT_MS;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      this.#abandon(explainAbandon(this.#options.hub, "not-ready", opened, this.#known()));
    }, deadline);
  }

  /** Within WAKE_FAST_MS of a wake, no link ready since. */
  #waking(now: number): boolean {
    return this.#wakeAt !== null && now - this.#wakeAt < WAKE_FAST_MS;
  }

  /** Connected to this hub a moment ago: its address is right, and it speaks to this app. */
  #known(): boolean {
    return this.#everReady && this.#downSince !== null && Date.now() - this.#downSince < ADVICE_AFTER_MS;
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
        this.#handshakeMs = this.#readyAt - this.#dialAt;
        this.#everReady = true;
        this.#downSince = null;
        this.#wokeLink = this.#wakeAt !== null;
        this.#wakeAt = null;
        this.#restarting = null;
        this.#updatingTo = null;
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
    if (opened && (code === CLOSE_RESTART || code === CLOSE_GOING_AWAY)) {
      this.#restarting ??= Date.now();
      this.#updatingTo ??= updatingTo(reason);
    }
    this.#lost(explainLoss(this.#options.hub, code, reason, error, opened, this.#known()));
  }

  #lost({ reason, fix }: Loss): void {
    const wasReady = this.#dropLink();
    this.#clearTimers();
    if (this.#stopped) return;
    const now = Date.now();
    const quick = this.#restarting !== null && now - this.#restarting < RESTART_REDIAL_MS;
    if ((wasReady && now - this.#readyAt >= STABLE_MS) || quick) {
      this.#attempt = 0;
      this.#fastDials = 0;
    }
    // Just after a wake, again at once, WAKE_REDIAL_EVERY_MS after the last attempt began at the soonest, the backoff
    // left at its start for after. Restarting, every RESTART_REDIAL_EVERY_MS until RESTART_REDIAL_MS, then the backoff
    // from its start. Otherwise ±25 %, so many apps behind one hub that dropped them don't come back in lockstep.
    const waking = this.#waking(now);
    if (waking) {
      this.#attempt++;
      this.#fastDials++;
    }
    const retryIn = waking
      ? Math.max(0, WAKE_REDIAL_EVERY_MS - (now - this.#dialAt))
      : quick
        ? RESTART_REDIAL_EVERY_MS
        : Math.round(backoff(this.#attempt++ - this.#fastDials) * (0.75 + 0.5 * (this.#options.random ?? Math.random)()));
    this.#setState({ phase: "retrying", hub: this.#options.hub, reason, fix, retryAt: now + retryIn, ...this.#awayFields() });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, retryIn);
  }

  /** Whether the link had been ready. */
  #dropLink(): boolean {
    const wasReady = this.#ready;
    this.#ready = false;
    if (wasReady) this.#downSince = Date.now();
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
    if (this.#probeTimer !== null) clearTimeout(this.#probeTimer);
    this.#pongTimer = null;
    this.#probeTimer = null;
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

  /** Why the link is away, for the screens to hold what they show: a restart, or a wake from a link that had been live. */
  #awayFields(): { restarting?: number; updatingTo?: string; waking?: number } {
    return {
      ...(this.#restarting === null ? {} : { restarting: this.#restarting }),
      ...(this.#updatingTo === null ? {} : { updatingTo: this.#updatingTo }),
      ...(this.#wakeAt === null || !this.#everReady ? {} : { waking: this.#wakeAt }),
    };
  }

  #setState(state: HubState): void {
    this.#state = state;
    this.#options.emit({ t: "state", state });
  }
}
