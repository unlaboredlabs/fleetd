// One hub connection: auth on every (re)connect, then a fresh snapshot and the event stream from its cursor, so the
// renderer always resyncs and never shows data from a dead link as live. Reconnects with backoff until the key is
// refused (close 4401, or an error before `ready`) or the client is stopped.
import type { CallOutcome, HubError, HubFrame, HubState } from "../../shared/hub";
import type { CallRequest, LiveScope } from "../../shared/ipc";
import { appUrl, backoff, CLOSE_UNAUTHORIZED, parseServerFrame, type ClientMessage, type ServerFrame } from "./protocol";
import type { HubSource } from "./source";
import type { Connection, Transport } from "./transport";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export interface HubClientOptions {
  /** As the user typed it; shown in the state. */
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
  readonly emit: (frame: HubFrame) => void;
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
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  /** The newest event seq applied on this connection; the stream resumes after it. */
  #cursor: number | null = null;
  #resumeAttempt = 0;
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #nextCallId = 0;
  readonly #pending = new Map<string, Pending>();
  #live: LiveScope | null = null;

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
    return new Promise<CallOutcome>((resolve) => {
      const timeoutMs = request.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#settle(id, fail("timeout", `The hub didn't answer ${tool} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      this.#send({ t: "call", id, tool, input });
    });
  }

  /** Kept across reconnects; null stops the subscription. */
  live(scope: LiveScope | null): void {
    this.#live = scope;
    if (this.#ready) this.#sendLive();
  }

  /** The hub sends a full live frame after each subscribe, so a window coming back to front asks again. */
  refreshLive(): void {
    if (this.#ready && this.#live !== null) this.#sendLive();
  }

  resync(): void {
    if (this.#ready) this.#send({ t: "snapshot" });
  }

  #connect(): void {
    const url = appUrl(this.#options.hub);
    if (!url.ok) {
      this.#setState({ phase: "refused", hub: this.#options.hub, message: url.message });
      return;
    }
    this.#setState({ phase: "connecting", hub: this.#options.hub, attempt: this.#attempt });
    const connection = this.#options.transport(url.url, {
      onOpen: () => {
        if (this.#connection === connection) this.#send({ t: "auth", key: this.#options.key });
      },
      onText: (text) => {
        if (this.#connection === connection) this.#onFrame(parseServerFrame(text));
      },
      onClose: (code, reason) => {
        if (this.#connection !== connection) return;
        this.#connection = null;
        this.#onClose(code, reason);
      },
    });
    this.#connection = connection;
  }

  #onFrame(frame: ServerFrame | null): void {
    if (frame === null) return;
    switch (frame.t) {
      case "ready": {
        this.#ready = true;
        this.#attempt = 0;
        this.#cursor = null;
        this.#setState({ phase: "live", hub: this.#options.hub, protocol: frame.protocol });
        this.#send({ t: "snapshot" });
        if (this.#live !== null) this.#sendLive();
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
      case "live": {
        const { t: _t, ...live } = frame;
        this.#options.emit({ t: "live", frame: live });
        return;
      }
      case "result": {
        this.#settle(frame.id, { ok: true, output: frame.output });
        return;
      }
      case "error": {
        const error: HubError = { code: frame.code, message: frame.message, fix: frame.fix };
        if (frame.id !== undefined) {
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

  #onClose(code: number, reason: string): void {
    if (code === CLOSE_UNAUTHORIZED) {
      this.#refuse(`The hub refused the key${reason === "" ? "" : ` (${reason})`}.`);
      return;
    }
    const wasReady = this.#dropLink();
    if (this.#stopped) return;
    if (wasReady) this.#attempt = 0;
    const retryIn = backoff(this.#attempt++);
    const reasonText = reason === "" ? `The connection ended (${code}).` : `The hub closed the connection: ${reason}.`;
    this.#setState({ phase: "retrying", hub: this.#options.hub, reason: reasonText, retryAt: Date.now() + retryIn });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, retryIn);
  }

  /** Whether the link had been ready. */
  #dropLink(): boolean {
    const wasReady = this.#ready;
    this.#ready = false;
    this.#cursor = null;
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
    this.#retryTimer = null;
    this.#resumeTimer = null;
  }

  #sendLive(): void {
    const scope = this.#live ?? { board: false };
    this.#send(scope.focus === undefined ? { t: "live", board: scope.board } : { t: "live", board: scope.board, focus: scope.focus });
  }

  #send(message: ClientMessage): void {
    this.#connection?.send(JSON.stringify(message));
  }

  #setState(state: HubState): void {
    this.#state = state;
    this.#options.emit({ t: "state", state });
  }
}
