// One paired hub at work: the client, the state the screens read, and the calls behind them. A snapshot (on every
// connection) reads the open requests again, reloads the open chat's latest page and sends again what the link cut
// off; events re-read what they changed (store.ts effectsOf). Screens subscribe and dispatch nothing themselves. The
// person's pinned chats sync with the hub on each snapshot (pins.ts).
import { loadRun, mergeMessages, resetFlow, toResend, type ApprovalDecision, type AttachmentGetOutput, type AttachmentRef, type ChatReplyTo, type ChatSend, type FlowDeps, type HubEvent, type HubState, type ProjectRef, type ToolInput, type ToolName } from "./desktop";
import { HubClient, type HubFrame, type Transport, type Typed } from "./hub/client";
import { memoryPins, Pins, type PinStore } from "./pins";
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
  /** Where this phone keeps its copy of this hub's pinned chats (prefsStore.ts pinStoreFor); in memory without one. */
  readonly pins?: PinStore;
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
  readonly #pins: Pins;

  constructor(options: SessionOptions) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomId;
    this.#key = options.key;
    this.#push = options.push;
    this.#state = initial({ phase: "connecting", hub: options.hub, attempt: 0 });
    this.#client = new HubClient({ hub: options.hub, key: options.key, transport: options.transport, emit: (f) => this.#onFrame(f) });
    this.#pins = new Pins((tool, input) => this.#client.call(tool, input), options.pins ?? memoryPins(), (key) => this.#state.projects?.[key] !== undefined);
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

  /** The pinned chats as they are now (pinned, unpinned or moved here): this phone's copy at once, then the hub. */
  setPins(keys: readonly Key[]): Promise<void> {
    return this.#pins.set(keys);
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

  /**
   * A new message, with the files already uploaded (upload.ts) and the bubble it replies to; queued under its own id
   * while there is no link, and sent when it comes back.
   */
  send(key: Key, text: string, extra: { readonly attachments?: readonly AttachmentRef[]; readonly replyTo?: ChatReplyTo | undefined } = {}): void {
    const row: ChatSend = {
      clientRequestId: this.#newId(),
      text,
      attachments: extra.attachments ?? [],
      at: new Date(this.#now()).toISOString(),
      state: { t: "sending" },
      ...(extra.replyTo === undefined ? {} : { replyTo: extra.replyTo }),
    };
    void this.#send(key, row);
  }

  readonly #files = new Map<string, Promise<AttachmentGetOutput | null>>();

  /** A message's file, read once (attachment_get) and kept while the app runs; null when the hub can't give it. */
  attachment(key: Key, attachmentId: string): Promise<AttachmentGetOutput | null> {
    const known = this.#files.get(attachmentId);
    if (known !== undefined) return known;
    const read = this.#client.call("attachment_get", { projectRef: refOf(key), attachmentId }, 60_000).then((r) => (r.ok ? r.output : null));
    this.#files.set(attachmentId, read);
    // A failed read is tried again next time.
    void read.then((out) => {
      if (out === null) this.#files.delete(attachmentId);
    });
    return read;
  }

  readonly #pictures = new Map<string, Promise<string | null>>();

  /**
   * A project's or Navi's picture by its id (its summary's `avatar`), base64 JPEG, read once (project_avatar_get) and
   * kept while the app runs; null when the hub can't give it.
   */
  picture(ref: ProjectRef, avatar: string): Promise<string | null> {
    const known = this.#pictures.get(avatar);
    if (known !== undefined) return known;
    const read = this.#client.call("project_avatar_get", { machineId: ref.machineId, projectId: ref.projectId }).then((r) => (r.ok && r.output.avatar === avatar ? r.output.dataB64 : null));
    this.#pictures.set(avatar, read);
    void read.then((out) => {
      if (out === null) this.#pictures.delete(avatar);
    });
    return read;
  }

  /** Search opened: each chat's newest page, read once per connection, for search to look through. */
  async readCorpus(): Promise<void> {
    for (const key of Object.keys(this.#state.projects ?? {})) {
      if (this.#state.corpus[key] !== undefined) continue;
      const r = await this.#client.call("chat_history", { projectRef: refOf(key), limit: CHAT_PAGE });
      if (!r.ok) return;
      this.#dispatch({ t: "corpus", key, messages: r.output.messages });
    }
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
    const r = await this.#client.call("chat_send", {
      projectRef: refOf(key),
      text: row.text,
      clientRequestId: row.clientRequestId,
      ...(row.attachments.length === 0 ? {} : { attachments: row.attachments.map((a) => a.attachmentId) }),
      ...(row.replyTo === undefined ? {} : { replyTo: row.replyTo }),
    });
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
    this.#dispatch({ t: "admin", admin: r.output.admin === true, me: r.output.me?.personId, meName: r.output.me?.name });
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
      // After the snapshot: an older build's pins go up only for this hub's own chats.
      void this.#pins.read();
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
      if (effects.pins) void this.#pins.read();
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
