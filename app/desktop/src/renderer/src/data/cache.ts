// The last hub data the app saw, on disk: a launch with no hub still shows the project list and the recent chats,
// marked offline as of when they were current, and messages queued with no hub survive a quit. Main keeps the text
// in <userData>/hub-cache.json, for the hub it came from only (main/hub/cache.ts); Forget deletes it.
//
// Never secrets or file contents: chat messages carry attachment references (name, type, size), a secret's value
// never reaches the renderer, and the person's own messages are kept only while they wait to go.
import type { ChatMessage, ProjectChatState, ProjectSummary } from "../../../shared/contracts";
import { HUB_CACHE_MAX_BYTES, HUB_CACHE_VERSION } from "../../../shared/cache";
import { CHAT_PAGE, emptyChat, type Chat, type ChatSend } from "./chat";
import { projectKey, type DataState, type DataStore, type OpenRequest, type ProjectKey } from "./store";

export interface CachedChat {
  readonly key: ProjectKey;
  /** The newest messages, oldest first. */
  readonly messages: readonly ChatMessage[];
  readonly hasOlder: boolean;
}

export interface HubCache {
  readonly version: typeof HUB_CACHE_VERSION;
  /** The hub address as saved; main hands the cache back only while that hub is the one paired. */
  readonly hub: string;
  /** When the data was last current (ISO). */
  readonly asOf: string;
  readonly projects: readonly ProjectSummary[];
  readonly chatStates: readonly ProjectChatState[];
  /** The chat on screen first, then the most recently active. */
  readonly chats: readonly CachedChat[];
  /** The person's messages not yet on the hub, by project. */
  readonly sends: Readonly<Record<ProjectKey, readonly ChatSend[]>>;
  /** What the sidebar's marks count (DataState.openRequests); absent in a cache written before it was kept. */
  readonly openRequests?: readonly OpenRequest[];
}

/** How many chats, and how much of each, the cache keeps. */
export const CACHE_CHATS = 6;
const CHAT_CHARS = 200_000;

const newestAt = (chat: Chat): string => chat.messages.at(-1)?.createdAt ?? "";

/** A chat's newest messages within the cache's bounds; at least the newest one, cut to fit. */
const cachedChat = (key: ProjectKey, chat: Chat): CachedChat => {
  const out: ChatMessage[] = [];
  let chars = 0;
  for (let i = chat.messages.length - 1; i >= 0 && out.length < CHAT_PAGE; i--) {
    const m = chat.messages[i];
    if (m === undefined) break;
    chars += m.text.length;
    if (chars > CHAT_CHARS && out.length > 0) break;
    out.push(chars > CHAT_CHARS ? { ...m, text: m.text.slice(0, CHAT_CHARS) } : m);
  }
  out.reverse();
  return { key, messages: out, hasOlder: chat.hasOlder || out.length < chat.messages.length };
};

/** The rows worth keeping across a quit: everything still on its way, never one mid-call (it is queued instead). */
const keptSends = (rows: readonly ChatSend[]): readonly ChatSend[] =>
  rows.map((r) => (r.state.t === "sending" ? { ...r, state: { t: "queued" as const } } : r));

/**
 * What goes on disk now. `asOf` is now while the data is current, else when it last was. Undefined when there is
 * nothing worth keeping (no projects yet).
 */
export const toCache = (s: DataState, hub: string, nowMs: number, focus: ProjectKey | null): HubCache | undefined => {
  const projects = Object.values(s.projects);
  if (projects.length === 0 || hub === "") return undefined;
  const chats = Object.entries(s.chats)
    .filter(([key, c]) => c.messages.length > 0 && key in s.projects)
    .sort(([a, x], [b, y]) => Number(b === focus) - Number(a === focus) || newestAt(y).localeCompare(newestAt(x)))
    .slice(0, CACHE_CHATS)
    .map(([key, c]) => cachedChat(key, c));
  const sends = Object.fromEntries(
    Object.entries(s.chatSends)
      .filter(([, rows]) => rows.length > 0)
      .map(([key, rows]) => [key, keptSends(rows)]),
  );
  return {
    version: HUB_CACHE_VERSION,
    hub,
    asOf: new Date(s.fresh ? nowMs : (s.asOf ?? nowMs)).toISOString(),
    projects,
    chatStates: Object.values(s.chatStates),
    chats,
    sends,
    ...(s.openRequests === undefined ? {} : { openRequests: s.openRequests }),
  };
};

/** The cache as text for main, the least active chats dropped until it fits. */
export const encodeCache = (cache: HubCache): string | undefined => {
  let chats = cache.chats;
  for (;;) {
    const text = JSON.stringify({ ...cache, chats });
    if (new TextEncoder().encode(text).length <= HUB_CACHE_MAX_BYTES) return text;
    if (chats.length === 0) return undefined;
    chats = chats.slice(0, -1);
  }
};

const isCache = (v: unknown): v is HubCache => {
  if (v === null || typeof v !== "object") return false;
  const c = v as Record<keyof HubCache, unknown>;
  return (
    c.version === HUB_CACHE_VERSION &&
    typeof c.hub === "string" &&
    typeof c.asOf === "string" &&
    Array.isArray(c.projects) &&
    Array.isArray(c.chatStates) &&
    Array.isArray(c.chats) &&
    typeof c.sends === "object" &&
    c.sends !== null
  );
};

export const decodeCache = (text: string): HubCache | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isCache(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The cache read at launch, applied only while nothing newer is held: a snapshot that beat it, or data this window
 * already had, wins. Queued and cut-off messages come back queued, to go when the link is back.
 */
export const restoreCache = (s: DataState, cache: HubCache): DataState => {
  if (s.fresh || Object.keys(s.projects).length > 0) return s;
  const asOf = Date.parse(cache.asOf);
  const chats: Record<ProjectKey, Chat> = {};
  for (const c of cache.chats) chats[c.key] = { ...emptyChat, messages: c.messages, hasOlder: c.hasOlder, cached: true };
  const chatSends: Record<ProjectKey, readonly ChatSend[]> = {};
  for (const [key, rows] of Object.entries(cache.sends)) {
    chatSends[key] = rows.map((r) => (r.state.t === "failed" ? r : { ...r, state: { t: "queued" } }));
  }
  return {
    ...s,
    asOf: Number.isNaN(asOf) ? undefined : asOf,
    projects: Object.fromEntries(cache.projects.map((p) => [projectKey(p), p])),
    chatStates: Object.fromEntries(cache.chatStates.map((c) => [projectKey(c.projectRef), c])),
    chats: { ...chats, ...s.chats },
    chatSends: { ...chatSends, ...s.chatSends },
    openRequests: s.openRequests ?? (Array.isArray(cache.openRequests) ? cache.openRequests : undefined),
  };
};

/** What the layer needs of main for the cache. */
export interface CacheIo {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

const messagesChanged = (a: DataState["chats"], b: DataState["chats"]): boolean => {
  if (a === b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key]?.messages !== b[key]?.messages) return true;
  return false;
};

/** Background data is written at most this often; a queued message goes at once. */
const WRITE_EVERY_MS = 3_000;

/**
 * Reads the cache once and keeps it written: at most every WRITE_EVERY_MS for the hub's data, at once when the
 * person's own messages change, and when the window goes away. Returns the stop.
 */
export const keepCache = (store: DataStore, io: CacheIo, focus: () => ProjectKey | null, now: () => number = Date.now): (() => void) => {
  let stopped = false;
  void io.read().then((text) => {
    const cache = text === null || stopped ? undefined : decodeCache(text);
    if (cache !== undefined) store.setState((s) => restoreCache(s, cache), true);
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const s = store.getState();
    const hub = s.hub.phase === "unpaired" ? "" : s.hub.hub;
    const cache = toCache(s, hub, now(), focus());
    const text = cache === undefined ? undefined : encodeCache(cache);
    if (text !== undefined) void io.write(text);
  };
  const stop = store.subscribe((s, prev) => {
    // The person's words, and the moment the link drops (the "as of" time), go at once.
    if (s.chatSends !== prev.chatSends || (prev.fresh && !s.fresh)) {
      write();
      return;
    }
    // Only what the cache holds: streamed text, live frames and the board change far more often and aren't in it.
    const changed =
      s.projects !== prev.projects || s.chatStates !== prev.chatStates || s.openRequests !== prev.openRequests || messagesChanged(s.chats, prev.chats);
    if (changed && timer === undefined) timer = setTimeout(write, WRITE_EVERY_MS);
  });
  // Going away while current: the cache says it was current until now.
  const flush = () => {
    if (timer !== undefined || store.getState().fresh) write();
  };
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
  return () => {
    stopped = true;
    stop();
    flush();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
  };
};
