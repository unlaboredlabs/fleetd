// One paired hub at work: the client, the state the screens read, and the calls behind them. A snapshot (on every
// connection) reads the open requests again, reloads the open chat's latest page and sends again what the link cut
// off; events re-read what they changed (store.ts effectsOf). Screens subscribe and dispatch nothing themselves. The
// person's pinned chats and their sections sync with the hub on each snapshot (pins.ts, sections.ts). A project's or
// agent's live screen is watched one at a time: its frames go to the live view's listener alone (onFrame), never
// through the state, which would draw the whole app again with each.
import { loadRun, mergeMessages, PREVIEW_SIDE, readFile, readPreview, resetFlow, toResend, type ApprovalDecision, type AttachmentGetOutput, type AttachmentRef, type BrowserFrame, type BrowserInput, type ChatReplyTo, type ChatSend, type FlowDeps, type HubError, type HubEvent, type HubState, type ProjectRef, type Read, type ToolInput, type ToolName, type TransferCall } from "./desktop";
import type { Navigation } from "./screen";
import { HubClient, type HubFrame, type Transport, type Typed } from "./hub/client";
import { memoryPins, Pins, type PinStore } from "./pins";
import { memorySections, Sections, type Section, type SectionStore } from "./sections";
import { deviceZone } from "./zone";
import { registerDevice, signOut, type PushDeps } from "./push";
import { cachedOf, parseCached, withCached, type Cached, type OpenAt } from "./cache";
import { initial, LATEST, reduce, refOf, effectsOf, type Action, type Key, type State } from "./store";

const CHAT_PAGE = 50;
/** A chat's screens read at once: its live ones are among its newest. */
const SCREENS_PAGE = 20;
const OPEN_REQUESTS = { state: "open", limit: 100 } as const;
/** Chats whose newest messages are read at once after a snapshot. */
const LATEST_AT_ONCE = 4;

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
  /** Where this phone keeps its copy of the person's sections on this hub (prefsStore.ts sectionStoreFor); in memory without one. */
  readonly sections?: SectionStore;
  /** Where the chats as last seen and the messages on their way are kept between launches (cacheStore.ts); none without one. */
  readonly cache?: CacheStore;
  /** Where the pictures' previews are kept between launches (cacheStore.ts); in memory without one. */
  readonly previews?: PreviewStore;
}

export interface PreviewStore {
  load(hub: string, attachmentId: string): AttachmentGetOutput | null;
  save(hub: string, attachmentId: string, preview: AttachmentGetOutput): void;
}

export interface CacheStore {
  /** What was kept, as read back: parseCached says whether it's this hub's. */
  load(): unknown;
  save(cached: Cached): void;
}

/** An open chat at its newest end. */
const NEWEST: OpenAt = { offset: 0, rows: 0, oldestSeq: undefined };

/** How long after a change what the cache keeps is written: a burst of events writes once. */
const CACHE_SAVE_MS = 1000;

/** A transfer's read as the call outcome the screens take: the file, or the hub's or the link's error. */
const typed = (r: Read): Typed<"attachment_get"> => (r.ok ? { ok: true, output: r.file } : { ok: false, error: { code: r.code, message: r.message } });
const randomId = (): string => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export class Session {
  #state: State;
  readonly #client: HubClient;
  readonly #listeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: HubEvent) => void>();
  readonly #frameListeners = new Set<(frame: BrowserFrame) => void>();
  readonly #inputErrorListeners = new Set<(error: HubError) => void>();
  readonly #liveListeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #newId: () => string;
  /** The chat on screen, which gets streamed text and is reloaded on each connection. */
  #open: Key | null = null;
  /** Where the open chat is scrolled to, kept with it when the app goes behind (cache.ts OpenChat). */
  #openAt: OpenAt = NEWEST;
  /** The chat open when the app was last closed, until it opens again: where it was scrolled to. */
  #reopen: { readonly key: Key; readonly at: OpenAt } | undefined;
  #registered = false;
  readonly #key: string;
  readonly #push: PushDeps | undefined;
  #unsubscribeToken: (() => void) | undefined;
  readonly #pins: Pins;
  readonly #sections: Sections;
  readonly #sectionsRefusedListeners = new Set<(words: string) => void>();
  readonly #hub: string;
  readonly #cache: CacheStore | undefined;
  readonly #previewStore: PreviewStore | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The open chat, when the link dropped with its latest page shown: a replay after the drop keeps it going. */
  #resumable: Key | null = null;
  /** An orders_board read on its way, and another one asked for meanwhile. */
  #boarding = false;
  #boardAgain = false;

  constructor(options: SessionOptions) {
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomId;
    this.#key = options.key;
    this.#push = options.push;
    this.#hub = options.hub;
    this.#cache = options.cache;
    this.#previewStore = options.previews;
    const empty = initial({ phase: "connecting", hub: options.hub, attempt: 0 });
    const cached = options.cache === undefined ? null : parseCached(options.cache.load(), options.hub);
    this.#state = cached === null ? empty : withCached(empty, cached);
    const open = cached?.open;
    if (open !== undefined && this.#state.projects?.[open.key] !== undefined) this.#reopen = { key: open.key, at: { offset: open.offset, rows: open.rows, oldestSeq: open.oldestSeq } };
    this.#client = new HubClient({ hub: options.hub, key: options.key, transport: options.transport, emit: (f) => this.#onFrame(f) });
    this.#pins = new Pins((tool, input) => this.#client.call(tool, input), options.pins ?? memoryPins(), (key) => this.#state.projects?.[key] !== undefined);
    this.#sections = new Sections((tool, input) => this.#client.call(tool, input), options.sections ?? memorySections(), (words) => {
      for (const listener of this.#sectionsRefusedListeners) listener(words);
    });
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
    // Stopped for a Disconnect, or another hub: nothing more is kept (going behind kept what there was).
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
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

  /** One hub call of a screen's own (a project's, screens/manage): answered, or the hub's or the link's error. */
  call<T extends ToolName>(tool: T, input: ToolInput<T>, timeoutMs?: number): Promise<Typed<T>> {
    return this.#client.call(tool, input, timeoutMs);
  }

  /** Each hub event as it arrives, for a screen that follows one through (a clone's progress). */
  onEvent(listener: (event: HubEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /**
   * Each time the link is live again after it was down (and the first time): a screen's own read that failed while
   * it was down reads again, rather than keep saying it couldn't (screens/manage/parts.tsx useRead).
   */
  onLive(listener: () => void): () => void {
    this.#liveListeners.add(listener);
    return () => this.#liveListeners.delete(listener);
  }

  /** Disconnect, on the hub: this phone's push registration removed and its key revoked. */
  signOut(): ReturnType<typeof signOut> {
    return signOut(this.#client, { loadDevice: this.#push?.loadDevice ?? (async () => null) }, this.#key);
  }

  /**
   * The app came back to the front from behind: its socket may have died while it slept, so it's asked for a sign of
   * life and dialled again only without one (client.ts wake). A live link keeps what the screens show.
   */
  wake(): void {
    if (this.#state.hub.phase === "refused") return;
    this.#client.wake();
    // The open chat's streamed text and turn line again (a delta past what's held reads its latest page).
    if (this.#open !== null) this.#client.chat(refOf(this.#open));
  }

  /**
   * The app went behind, where iOS may end it: what the cache keeps is written now, and the open chat's streamed text
   * and turn line stop, as nobody sees them; the link and its events stay.
   */
  sleep(): void {
    this.#client.sleep();
    if (this.#open !== null) this.#client.chat(null);
    this.#saveNow();
  }

  /** The phone's network changed: the link is checked, or dialled now (client.ts networkChanged). */
  networkChanged(): void {
    if (this.#state.hub.phase === "refused") return;
    this.#client.networkChanged();
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

  /** The person's sections as they are now (a chat moved, one named, moved or removed here): this phone's copy at once, then the hub. */
  setSections(sections: readonly Section[]): Promise<void> {
    return this.#sections.set(sections);
  }

  /** A change to the sections the hub refused was taken back: its words, for the list to say. */
  onSectionsRefused(listener: (words: string) => void): () => void {
    this.#sectionsRefusedListeners.add(listener);
    return () => this.#sectionsRefusedListeners.delete(listener);
  }

  openChat(key: Key | null): void {
    if (key !== this.#open) this.#openAt = key !== null && key === this.#reopen?.key ? this.#reopen.at : NEWEST;
    this.#reopen = undefined;
    this.#open = key;
    this.#push?.onScreen?.(key);
    this.#client.chat(key === null ? null : refOf(key));
    if (key === null) return;
    this.#dispatch({ t: "chat_open", key });
    void this.#loadLatest(key);
    void this.readScreens(key);
  }

  /** The chat open when the app was last closed, and where: App.tsx opens it again over the list. */
  get reopen(): { readonly key: Key; readonly at: OpenAt } | undefined {
    return this.#reopen;
  }

  /** Where the open chat is scrolled to now (Chat.tsx), for the cache: it opens there again after the app is closed. */
  scrolledTo(key: Key, at: Partial<OpenAt>): void {
    if (key === this.#open) this.#openAt = { ...this.#openAt, ...at };
  }

  async loadOlder(key: Key): Promise<void> {
    const chat = this.#state.chats[key];
    const oldest = chat?.messages[0];
    if (chat === undefined || oldest === undefined || !chat.hasOlder || chat.loadingOlder) return;
    this.#dispatch({ t: "loading_older", key });
    const r = await this.#client.call("chat_history", { projectRef: refOf(key), before: oldest.seq, limit: CHAT_PAGE });
    if (r.ok) this.#dispatch({ t: "history", key, page: r.output, direction: "older" });
    else this.#dispatch({ t: "history_failed", key, error: r.error, direction: "older" });
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

  readonly #files = new Map<string, Promise<Typed<"attachment_get">>>();

  /** The hub's calls a file's transfer makes (desktop.ts readFile, readPreview). */
  readonly #transfer: TransferCall = (tool, input, ms) => this.#client.call(tool, input as never, ms);

  /**
   * A message's file, whole: read once, when it is opened or shared, in pieces that go on from where a drop stopped
   * them (readFile), and kept while the app runs; the hub's or the link's error when it can't be had, which isn't
   * kept: the next ask reads it again.
   */
  attachment(key: Key, attachmentId: string): Promise<Typed<"attachment_get">> {
    const known = this.#files.get(attachmentId);
    if (known !== undefined) return known;
    const read = readFile(this.#transfer, { projectRef: refOf(key), attachmentId }).then(typed);
    this.#files.set(attachmentId, read);
    void read.then((r) => {
      if (!r.ok) this.#files.delete(attachmentId);
    });
    return read;
  }

  readonly #previews = new Map<string, Promise<Typed<"attachment_get">>>();
  /** The previews read so far, for keptPreview. */
  readonly #previewsRead = new Map<string, AttachmentGetOutput>();

  /**
   * A picture's preview at once, when it was read already or is on disk: a bubble draws it in its first frame rather
   * than as a stand-in that preview() replaces a frame later.
   */
  keptPreview(attachmentId: string): AttachmentGetOutput | undefined {
    const known = this.#previewsRead.get(attachmentId);
    if (known !== undefined) return known;
    const kept = this.#previewStore?.load(this.#hub, attachmentId) ?? null;
    if (kept === null) return undefined;
    this.#previewsRead.set(attachmentId, kept);
    return kept;
  }

  /**
   * A picture as its bubble shows it: its preview, at most PREVIEW_SIDE.phone pixels a side, read once and kept on
   * disk between launches; the error when it can't be had, which isn't kept. A hub that sent the picture itself (it
   * was small, or the hub reads no maxSide) gave the file too, which opening it then uses.
   */
  preview(key: Key, attachmentId: string): Promise<Typed<"attachment_get">> {
    const known = this.#previews.get(attachmentId);
    if (known !== undefined) return known;
    const kept = this.keptPreview(attachmentId) ?? null;
    const read: Promise<Typed<"attachment_get">> =
      kept !== null
        ? Promise.resolve({ ok: true, output: kept })
        : readPreview(this.#transfer, { projectRef: refOf(key), attachmentId }, PREVIEW_SIDE.phone).then((r) => {
            if (r.ok) this.#previewStore?.save(this.#hub, attachmentId, r.file);
            return typed(r);
          });
    this.#previews.set(attachmentId, read);
    void read.then((r) => {
      if (!r.ok) return void this.#previews.delete(attachmentId);
      this.#previewsRead.set(attachmentId, r.output);
      if (r.output.preview !== true && !this.#files.has(attachmentId)) this.#files.set(attachmentId, Promise.resolve(r));
    });
    return read;
  }

  readonly #pictures = new Map<string, Promise<string | null>>();

  /**
   * A project's or a person's picture by its id (its summary's or person's `avatar`), base64 JPEG, read once
   * (project_avatar_get, person_avatar_get) and kept while the app runs; null when the hub can't give it.
   */
  picture(of: ProjectRef | { readonly personId: string }, avatar: string): Promise<string | null> {
    const known = this.#pictures.get(avatar);
    if (known !== undefined) return known;
    const call = "personId" in of ? this.#client.call("person_avatar_get", { personId: of.personId }) : this.#client.call("project_avatar_get", { machineId: of.machineId, projectId: of.projectId });
    const read = call.then((r) => (r.ok && r.output.avatar === avatar ? r.output.dataB64 : null));
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

  /** A failed or unanswered row deleted: it never goes (one the hub had anyway comes back as its message). */
  discard(key: Key, clientRequestId: string): void {
    this.#dispatch({ t: "discard", key, clientRequestId });
  }

  /** A chat's screens, read again: as it opens, its live view opens, and one of them changes. */
  async readScreens(key: Key): Promise<void> {
    const r = await this.#client.call("browser_sessions", { projectRef: refOf(key), limit: SCREENS_PAGE });
    if (r.ok) this.#dispatch({ t: "screens", key, sessions: r.output.sessions });
  }

  /** Watch one screen's frames (null stops), which go to each onFrame listener. */
  watch(sessionId: string | null): void {
    this.#client.watch(sessionId);
  }

  /** The watched screen's frames as they come, for its live view alone. */
  onFrame(listener: (frame: BrowserFrame) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  /** The hub's refusal of a touch, typing or page move just sent, for the live view to say. */
  onInputError(listener: (error: HubError) => void): () => void {
    this.#inputErrorListeners.add(listener);
    return () => this.#inputErrorListeners.delete(listener);
  }

  /** A touch or typing on a screen this phone's person took over. */
  input(sessionId: string, input: BrowserInput | Navigation): void {
    this.#client.input(sessionId, input);
  }

  /**
   * Takes a screen over (`human`) or hands it back to its agent (`agent`), once its machine says it acted; the screen
   * as the hub then has it replaces the listed one.
   */
  async control(sessionId: string, to: "human" | "agent"): Promise<Typed<"browser_control">> {
    const r = await this.#client.call("browser_control", { sessionId, control: to });
    if (r.ok) this.#dispatch({ t: "screen", session: r.output.session });
    return r;
  }

  /** Whether the hub took the answer: false when it refused, the link failed, or an answer is already on its way. */
  async answer(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    if (this.#state.answering[requestId] === true) return false;
    this.#dispatch({ t: "answer", requestId });
    const r = await this.#client.call("approval_answer", { requestId, decision });
    this.#dispatch({ t: "answered", requestId, result: r.ok ? { ok: true, request: r.output.request } : { ok: false, error: r.error } });
    return r.ok;
  }

  async #send(key: Key, row: ChatSend): Promise<void> {
    this.#dispatch({ t: "send", key, row });
    const r = await this.#client.call("chat_send", {
      projectRef: refOf(key),
      text: row.text,
      clientRequestId: row.clientRequestId,
      ...(row.attachments.length === 0 ? {} : { attachments: row.attachments.map((a) => a.attachmentId) }),
      ...(row.replyTo === undefined ? {} : { replyTo: row.replyTo }),
      ...deviceZone(),
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
    else if (r.error.code !== "offline") this.#dispatch({ t: "history_failed", key, error: r.error, direction: "latest" });
  }

  /**
   * Each chat's newest messages, for the chats list, a few chats at a time: what spoke last first. The open chat's
   * latest page is read whole (loadLatest); a chat opened earlier is read too, as it's held and may have moved on.
   */
  async #readLatest(): Promise<void> {
    const keys = Object.entries(this.#state.projects ?? {})
      .filter(([key]) => key !== this.#open && this.#stale(key))
      .sort(([, a], [, b]) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map(([key]) => key);
    let failed = false;
    const next = async (): Promise<void> => {
      const key = keys.shift();
      if (key === undefined || failed) return;
      const r = await this.#client.call("chat_history", { projectRef: refOf(key), limit: LATEST });
      if (!r.ok) {
        failed = true;
        return;
      }
      this.#dispatch({ t: "latest", key, messages: r.output.messages });
      return next();
    };
    await Promise.all(Array.from({ length: LATEST_AT_ONCE }, next));
  }

  /**
   * A chat's newest few that the snapshot says moved on: none read yet, a newer seq than the newest kept, or one still
   * streaming. Events keep them current while live, and the cache across launches.
   */
  #stale(key: Key): boolean {
    const latest = this.#state.latest[key];
    if (latest === undefined) return true;
    const lastSeq = this.#state.chatStates[key]?.lastSeq;
    return lastSeq === undefined || lastSeq > (latest.at(-1)?.seq ?? 0) || latest.some((m) => m.state === "streaming");
  }

  /** Who this phone's person is, and whether an admin, who sees Update; then, for one, the hub's update. */
  async #readInfo(): Promise<void> {
    const r = await this.#client.call("hub_info", {});
    if (!r.ok) return;
    const me = r.output.me;
    this.#dispatch({ t: "admin", admin: r.output.admin === true, me: me?.personId, meName: me?.name, meAvatar: me?.avatar, meRole: me?.role });
    if (r.output.admin === true) void loadRun(this.updates);
  }

  /** The open orders, for who works where (store.ts running): one read at a time, and one more if asked meanwhile, as
   * an order's agents come in bursts of events. */
  async #readBoard(): Promise<void> {
    if (this.#boarding) {
      this.#boardAgain = true;
      return;
    }
    this.#boarding = true;
    try {
      do {
        this.#boardAgain = false;
        const r = await this.#client.call("orders_board", {});
        if (r.ok) this.#dispatch({ t: "board", orders: r.output.orders });
      } while (this.#boardAgain);
    } finally {
      this.#boarding = false;
    }
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

  #setChat(key: Key, update: (chat: NonNullable<State["chats"][Key]>) => NonNullable<State["chats"][Key]>): void {
    const chat = this.#state.chats[key];
    if (chat === undefined) return;
    this.#state = { ...this.#state, chats: { ...this.#state.chats, [key]: update(chat) } };
    this.#notify();
  }

  #onFrame(frame: HubFrame): void {
    if (frame.t === "browser_frame") {
      for (const listener of this.#frameListeners) listener(frame.frame);
      return;
    }
    if (frame.t === "browser_error") {
      for (const listener of this.#inputErrorListeners) listener(frame.error);
      return;
    }
    const before = this.#state.chats[this.#open ?? ""];
    if (frame.t === "state" && frame.state.phase !== "live" && this.#state.hub.phase === "live") this.#resumable = before?.loaded === true ? this.#open : null;
    const wasLive = this.#state.hub.phase === "live";
    this.#dispatch({ t: "frame", frame, nowMs: this.#now() });
    if (frame.t === "state") this.#onState(frame.state, wasLive);
    if (frame.t === "snapshot") {
      void this.#readRequests();
      void this.#readBoard();
      // After the snapshot: an older build's pins go up only for this hub's own chats.
      void this.#pins.read();
      void this.#sections.read();
      void this.#readLatest();
      // An admin's: the build the hub has ready, and a run going on, followed.
      if (this.#state.admin === true) void loadRun(this.updates);
      // Back from a drop whose events replay, the open chat goes on with them; else its latest page starts it over.
      if (this.#open !== null && frame.replay === true && this.#resumable === this.#open) this.#dispatch({ t: "resume", key: this.#open });
      else if (this.#open !== null) void this.#loadLatest(this.#open);
      this.#resumable = null;
      // The screens of the chats looked at may have changed while the link was down.
      for (const key of Object.keys(this.#state.screens)) void this.readScreens(key);
      for (const [key, rows] of Object.entries(this.#state.sends)) {
        for (const row of toResend(rows)) void this.#send(key, { ...row, state: { t: "sending" } });
      }
    }
    // What a missed event changed, the snapshot before it already read again (requests, pins, sections, screens, projects).
    if (frame.t === "event" && frame.replayed === true) for (const listener of this.#eventListeners) listener(frame.event);
    else if (frame.t === "event") {
      for (const listener of this.#eventListeners) listener(frame.event);
      const effects = effectsOf(frame.event);
      if (effects.requests) void this.#readRequests();
      if (effects.board) void this.#readBoard();
      if (effects.snapshot) this.#client.resync();
      if (effects.pins) void this.#pins.read();
      if (effects.sections) void this.#sections.read();
      if (effects.info) void this.#readInfo();
      if (effects.screens !== undefined && (effects.screens === this.#open || this.#state.screens[effects.screens] !== undefined)) void this.readScreens(effects.screens);
    }
    const open = this.#open === null ? undefined : this.#state.chats[this.#open];
    if (this.#open !== null && open !== undefined && open !== before) {
      // A delta skipped a frame: the latest page has the text. A message too big for its event: read by seq.
      if (open.gap === true && before?.gap !== true) void this.#loadLatest(this.#open);
      if (open.missing.length > (before?.missing.length ?? 0)) void this.#readMissing(this.#open);
    }
  }

  #onState(state: HubState, wasLive: boolean): void {
    if (state.phase === "live") void this.#readInfo();
    if (state.phase === "live" && !wasLive) for (const listener of this.#liveListeners) listener();
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
    const was = this.#state;
    const next = reduce(was, action);
    if (next === was) return;
    this.#state = next;
    if (next.projects !== was.projects || next.chatStates !== was.chatStates || next.latest !== was.latest || next.sends !== was.sends || next.requests !== was.requests || next.meName !== was.meName) this.#saveSoon();
    this.#notify();
  }

  #saveSoon(): void {
    if (this.#cache === undefined || this.#saveTimer !== null) return;
    this.#saveTimer = setTimeout(() => this.#saveNow(), CACHE_SAVE_MS);
  }

  #saveNow(): void {
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    this.#cache?.save(cachedOf(this.#hub, this.#state, this.#open === null ? undefined : { key: this.#open, at: this.#openAt }));
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
