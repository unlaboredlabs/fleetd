// One paired hub at work: the client, the state the screens read, and the calls behind them. A snapshot (on every
// connection) reads the open requests again, reloads the open chat's latest page and sends again what the link cut
// off; events re-read what they changed (store.ts effectsOf). Screens subscribe and dispatch nothing themselves.
import { loadRun, mergeMessages, resetFlow, toResend, type ApprovalDecision, type ChatSend, type FlowDeps, type HubEvent, type HubState, type ToolInput, type ToolName } from "./desktop";
import { HubClient, type HubFrame, type Transport, type Typed } from "./hub/client";
import { registerDevice, signOut, type PushDeps } from "./push";
import { initial, LATEST, reduce, refOf, effectsOf, type Action, type Key, type State } from "./store";

export const CHAT_PAGE = 50;
const OPEN_REQUESTS = { state: "open", limit: 100 } as const;

export interface SessionOptions {
  readonly hub: string;
  readonly key: string;
  readonly transport: Transport;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Registers this phone for push on each session's first live link, and again with each new token. */
  readonly push?: PushDeps;
}

const randomId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export class Session {
  #state: State;
  readonly #client: HubClient;
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: HubEvent) => void>();
  readonly #now: () => number;
  readonly #newId: () => string;
  /** The chat on screen, which gets streamed text and is reloaded on each connection. */
  #open: Key | null = null;
  #registered = false;
  readonly #key: string;
  readonly #push: PushDeps | undefined;
  #unsubscribeToken: (() => void) | undefined;

  constructor(options: SessionOptions) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomId;
    this.#key = options.key;
    this.#push = options.push;
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
    this.#unsubscribeToken = this.#push?.onToken((token) => {
      if (this.#state.hub.phase === "live") void this.#register(token);
      else this.#registered = false;
    });
  }

  stop(): void {
    this.#unsubscribeToken?.();
    this.#client.stop();
    // The update's run is this hub's: another paired after it starts from nothing.
    resetFlow();
  }

  /**
   * What the Update button's run (the desktop's flow.ts) does its calls with: the hub's, dialling again while it
   * restarts. The phone has no app update in it: it updates over the air.
   */
  readonly updates: FlowDeps = {
    call: (tool, input, options) => this.#client.call(tool, input, options?.timeoutMs),
    retry: () => this.wake(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    app: { state: () => null, check: () => undefined, install: () => undefined },
  };

  /** One hub call of a screen's own (a project's or Navi's, screens/manage): answered, or the hub's or the link's error. */
  call<T extends ToolName>(tool: T, input: ToolInput<T>, timeoutMs?: number): Promise<Typed<T>> {
    return this.#client.call(tool, input, timeoutMs);
  }

  /** Each hub event as it arrives, for a screen that follows one through (a clone's progress). */
  onEvent(listener: (event: HubEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Disconnect, on the hub: this phone's push registration removed and its key revoked. */
  signOut(): ReturnType<typeof signOut> {
    return signOut(this.#client, { loadDevice: this.#push?.loadDevice ?? (async () => null) }, this.#key);
  }

  /** The app came back to the front: its socket may have died while it slept. */
  wake(): void {
    if (this.#state.hub.phase !== "refused") this.#client.reconnectNow();
  }

  /** Pulled to refresh: a fresh snapshot (which reads the requests and the open chat again) while live, else a dial now. */
  refresh(): void {
    if (this.#state.hub.phase === "live") this.#client.resync();
    else this.wake();
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

  /** Each unread chat's newest messages, for the chats list, one chat at a time: what spoke last first. */
  async #readLatest(): Promise<void> {
    const keys = Object.entries(this.#state.projects ?? {})
      .filter(([key]) => this.#state.chats[key] === undefined)
      .sort(([, a], [, b]) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map(([key]) => key);
    for (const key of keys) {
      const r = await this.#client.call("chat_history", { projectRef: refOf(key), limit: LATEST });
      if (!r.ok) return;
      this.#dispatch({ t: "latest", key, messages: r.output.messages });
    }
  }

  /** Who this phone's person is, and whether an admin, who sees Update; then, for one, the hub's update. */
  async #readInfo(): Promise<void> {
    const r = await this.#client.call("hub_info", {});
    if (!r.ok) return;
    this.#dispatch({ t: "admin", admin: r.output.admin === true, me: r.output.me?.personId });
    if (r.output.admin === true) void loadRun(this.updates);
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
      void this.#readLatest();
      // An admin's: the build the hub has ready, and a run going on, followed.
      if (this.#state.admin === true) void loadRun(this.updates);
      if (this.#open !== null) void this.#loadLatest(this.#open);
      for (const [key, rows] of Object.entries(this.#state.sends)) {
        for (const row of toResend(rows)) void this.#send(key, { ...row, state: { t: "sending" } });
      }
    }
    if (frame.t === "event") {
      for (const listener of this.#eventListeners) listener(frame.event);
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
    if (state.phase === "live") void this.#readInfo();
    if (state.phase !== "live" || this.#registered) return;
    this.#registered = true;
    void this.#register();
  }

  async #register(token?: string): Promise<void> {
    if (this.#push === undefined) return;
    const r = await registerDevice(this.#client, this.#push, token);
    // The link went before the hub answered: again on the next.
    if (r.t === "failed" && r.error.code === "offline") this.#registered = false;
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
