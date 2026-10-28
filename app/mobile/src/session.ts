// One paired hub at work: the client, the state the screens read, and the calls behind them. A snapshot (on every
// connection) reads the open requests again, reloads the open chat's latest page and sends again what the link cut
// off; events re-read what they changed (store.ts effectsOf). Screens subscribe and dispatch nothing themselves.
import { mergeMessages, toResend, type ApprovalDecision, type ChatSend, type HubState } from "./desktop";
import { HubClient, type HubFrame, type Transport } from "./hub/client";
import { registerDevice } from "./push";
import { initial, reduce, refOf, effectsOf, type Action, type Key, type State } from "./store";

export const CHAT_PAGE = 50;
const OPEN_REQUESTS = { state: "open", limit: 100 } as const;

export interface SessionOptions {
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
  readonly now?: () => number;
  readonly newId?: () => string;
}

const randomId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export class Session {
  #state: State;
  readonly #client: HubClient;
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #newId: () => string;
  /** The chat on screen, which gets streamed text and is reloaded on each connection. */
  #open: Key | null = null;
  #registered = false;

  constructor(options: SessionOptions) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomId;
    this.#state = initial({ phase: "connecting", hub: options.hub, attempt: 0 });
    this.#client = new HubClient({ hub: options.hub, key: options.key, transport: options.transport, emit: (f) => this.#onFrame(f) });
  }

  get state(): State {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): State => this.#state;

  start(): void {
    this.#client.start();
  }

  stop(): void {
    this.#client.stop();
  }

  /** The app came back to the front: its socket may have died while it slept. */
  wake(): void {
    if (this.#state.hub.phase !== "refused") this.#client.reconnectNow();
  }

  openChat(key: Key | null): void {
    this.#open = key;
    this.#client.chat(key === null ? null : refOf(key));
    if (key === null) return;
    this.#dispatch({ t: "chat_open", key });
    void this.#loadLatest(key);
  }

  async loadOlder(key: Key): Promise<void> {
    const chat = this.#state.chats[key];
    const oldest = chat?.messages[0];
    if (chat === undefined || oldest === undefined || !chat.hasOlder || chat.loadingOlder) return;
    this.#dispatch({ t: "history", key, page: { messages: [], moreAfter: false, moreBefore: true, state: this.#chatState(key) }, direction: "older" });
    const r = await this.#client.call("chat_history", { projectRef: refOf(key), before: oldest.seq, limit: CHAT_PAGE });
    if (r.ok) this.#dispatch({ t: "history", key, page: r.output, direction: "older" });
    else this.#dispatch({ t: "history_failed", key, error: r.error });
  }

  /** A new message; queued under its own id while there is no link, and sent when it comes back. */
  send(key: Key, text: string): void {
    const row: ChatSend = { clientRequestId: this.#newId(), text, attachments: [], at: new Date(this.#now()).toISOString(), state: { t: "sending" } };
    void this.#send(key, row);
  }

  /** A failed or unanswered row, again under its own id: the hub keeps one message per id. */
  resend(key: Key, clientRequestId: string): void {
    const row = this.#state.sends[key]?.find((r) => r.clientRequestId === clientRequestId);
    if (row !== undefined) void this.#send(key, { ...row, state: { t: "sending" } });
  }

  async answer(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (this.#state.answering[requestId] === true) return;
    this.#dispatch({ t: "answer", requestId });
    const r = await this.#client.call("approval_answer", { requestId, decision });
    this.#dispatch({ t: "answered", requestId, result: r.ok ? { ok: true, request: r.output.request } : { ok: false, error: r.error } });
  }

  async #send(key: Key, row: ChatSend): Promise<void> {
    this.#dispatch({ t: "send", key, row });
    const r = await this.#client.call("chat_send", { projectRef: refOf(key), text: row.text, clientRequestId: row.clientRequestId });
    this.#dispatch(
      r.ok
        ? { t: "sent", key, clientRequestId: row.clientRequestId, result: { ok: true, message: r.output.message }, leadWaiting: r.output.leadWaiting }
        : { t: "sent", key, clientRequestId: row.clientRequestId, result: r },
    );
  }

  async #loadLatest(key: Key): Promise<void> {
    const r = await this.#client.call("chat_history", { projectRef: refOf(key), limit: CHAT_PAGE });
    if (r.ok) this.#dispatch({ t: "history", key, page: r.output, direction: "latest" });
    else if (r.error.code !== "offline") this.#dispatch({ t: "history_failed", key, error: r.error });
  }

  async #readRequests(): Promise<void> {
    const r = await this.#client.call("requests_list", OPEN_REQUESTS);
    if (r.ok) this.#dispatch({ t: "requests", requests: r.output.requests });
  }

  /** Messages an event named but didn't carry, read one by one. */
  async #readMissing(key: Key): Promise<void> {
    for (const seq of this.#state.chats[key]?.missing ?? []) {
      const r = await this.#client.call("chat_history", { projectRef: refOf(key), after: seq - 1, limit: 1 });
      if (!r.ok) return;
      this.#setChat(key, (chat) => mergeMessages(chat, r.output.messages));
    }
  }

  #chatState(key: Key) {
    return this.#state.chatStates[key] ?? { projectRef: refOf(key), lastSeq: 0, leadWorking: false, needsYou: false };
  }

  #setChat(key: Key, update: (chat: NonNullable<State["chats"][Key]>) => NonNullable<State["chats"][Key]>): void {
    const chat = this.#state.chats[key];
    if (chat === undefined) return;
    this.#state = { ...this.#state, chats: { ...this.#state.chats, [key]: update(chat) } };
    this.#notify();
  }

  #onFrame(frame: HubFrame): void {
    const before = this.#state.chats[this.#open ?? ""];
    this.#dispatch({ t: "frame", frame, nowMs: this.#now() });
    if (frame.t === "state") this.#onState(frame.state);
    if (frame.t === "snapshot") {
      void this.#readRequests();
      if (this.#open !== null) void this.#loadLatest(this.#open);
      for (const [key, rows] of Object.entries(this.#state.sends)) {
        for (const row of toResend(rows)) void this.#send(key, { ...row, state: { t: "sending" } });
      }
    }
    if (frame.t === "event") {
      const effects = effectsOf(frame.event);
      if (effects.requests) void this.#readRequests();
      if (effects.snapshot) this.#client.resync();
    }
    const open = this.#open === null ? undefined : this.#state.chats[this.#open];
    if (this.#open !== null && open !== undefined && open !== before) {
      // A delta skipped a frame: the latest page has the text. A message too big for its event: read by seq.
      if (open.gap === true && before?.gap !== true) void this.#loadLatest(this.#open);
      if (open.missing.length > (before?.missing.length ?? 0)) void this.#readMissing(this.#open);
    }
  }

  #onState(state: HubState): void {
    if (state.phase !== "live" || this.#registered) return;
    this.#registered = true;
    void registerDevice(this.#client);
  }

  #dispatch(action: Action): void {
    const next = reduce(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
