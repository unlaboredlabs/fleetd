// What the phone keeps of a hub between launches, so it opens on the chats as it last saw them, as Messages and
// other chat apps do, rather than on skeleton rows: the projects and their chat states, each chat's newest few messages (the
// list's previews), the open approvals (each chat's count and place), who the person is, the messages on their way,
// which an app iOS kills must not lose, and the chat that was open, which opens again where it was, as in Messages.
// The snapshot and pages replace it all once the link is live. Pure, so it is unit-tested; cacheStore.ts keeps it on
// disk.
import { emptyChat, type Chat, type ChatMessage, type ChatSend, type HubRole, type HumanRequest, type ProjectChatState, type ProjectSummary } from "./desktop";
import type { Key, State } from "./store";

/** Where the open chat was scrolled to, as Chat.tsx says: kept with it. */
export interface OpenAt {
  /** How far up from its newest end, in points. */
  readonly offset: number;
  /** How many of its rows, from the newest, reach the oldest that showed. */
  readonly rows: number;
  /** The oldest message that showed. */
  readonly oldestSeq: number | undefined;
}

/** The chat that was open when the app went: what it showed and a screen more, and where it was scrolled to. */
export interface OpenChat extends OpenAt {
  readonly key: Key;
  readonly messages: readonly ChatMessage[];
  readonly hasOlder: boolean;
}

/** How many messages older than the oldest that showed are kept, for a scroll on; and the most an open chat keeps. */
const OPEN_MORE = 30;
const OPEN_MOST = 400;

export interface Cached {
  /** The hub it was read from (Paired.hub): another's is never shown. */
  readonly hub: string;
  readonly projects: Readonly<Record<Key, ProjectSummary>> | undefined;
  readonly chatStates: Readonly<Record<Key, ProjectChatState>>;
  readonly latest: Readonly<Record<Key, readonly ChatMessage[]>>;
  readonly sends: Readonly<Record<Key, readonly ChatSend[]>>;
  readonly requests: readonly HumanRequest[] | undefined;
  readonly me: string | undefined;
  readonly meName: string | undefined;
  readonly meAvatar?: string | undefined;
  readonly meRole?: HubRole | undefined;
  readonly open?: OpenChat | undefined;
}

/** Where a send stands in the cache: one on its way when the app went may have reached the hub, so it goes again. */
const keptSend = (row: ChatSend): ChatSend => (row.state.t === "sending" ? { ...row, state: { t: "reconnecting" }, reached: true } : row);

/**
 * The open chat as kept: its messages from a screen before the oldest that showed to the newest. One scrolled further
 * back than OPEN_MOST messages opens again at its newest end.
 */
export const openChatOf = (key: Key, chat: Chat, at: OpenAt): OpenChat | undefined => {
  if (chat.messages.length === 0) return undefined;
  const from = at.oldestSeq === undefined ? -1 : chat.messages.findIndex((m) => m.seq >= at.oldestSeq!);
  const start = from < 0 ? Math.max(0, chat.messages.length - OPEN_MORE) : Math.max(0, from - OPEN_MORE);
  if (chat.messages.length - start > OPEN_MOST) return { key, messages: chat.messages.slice(-OPEN_MORE), hasOlder: true, offset: 0, rows: 0, oldestSeq: undefined };
  return { key, messages: chat.messages.slice(start), hasOlder: start > 0 || chat.hasOlder, ...at };
};

export const cachedOf = (hub: string, s: State, open?: { readonly key: Key; readonly at: OpenAt }): Cached => ({
  hub,
  projects: s.projects,
  chatStates: s.chatStates,
  latest: s.latest,
  sends: Object.fromEntries(Object.entries(s.sends).flatMap(([key, rows]) => (rows.length === 0 ? [] : [[key, rows.map(keptSend)]]))),
  requests: s.requests,
  me: s.me,
  meName: s.meName,
  meAvatar: s.meAvatar,
  meRole: s.meRole,
  open: open === undefined || s.chats[open.key] === undefined ? undefined : openChatOf(open.key, s.chats[open.key]!, open.at),
});

/**
 * A state opened on what was kept: shown until the snapshot replaces it. No lead is shown working, as none may be;
 * the sends go once the link is live (session.ts toResend). The open chat is a cached one, shown as it was until its
 * latest page starts it over.
 */
export const withCached = (s: State, c: Cached): State => ({
  ...s,
  projects: c.projects,
  chatStates: Object.fromEntries(Object.entries(c.chatStates).map(([key, state]) => [key, state.leadWorking ? { ...state, leadWorking: false } : state])),
  latest: c.latest,
  sends: c.sends,
  requests: c.requests,
  me: c.me,
  meName: c.meName,
  meAvatar: c.meAvatar,
  meRole: c.meRole,
  chats: c.open === undefined ? s.chats : { ...s.chats, [c.open.key]: { ...emptyChat, messages: c.open.messages, hasOlder: c.open.hasOlder, cached: true } },
});

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** Read back from disk for `hub`: null when it is another hub's or isn't a Cached's shape. */
export const parseCached = (raw: unknown, hub: string): Cached | null => {
  const o = record(raw);
  if (o === undefined || o.hub !== hub) return null;
  const projects = record(o.projects);
  const chatStates = record(o.chatStates);
  const latest = record(o.latest);
  const sends = record(o.sends);
  if (chatStates === undefined || latest === undefined || sends === undefined) return null;
  const lists = <T>(r: Record<string, unknown>): Record<Key, readonly T[]> => Object.fromEntries(Object.entries(r).filter((e): e is [string, T[]] => Array.isArray(e[1])));
  return {
    hub,
    projects: projects as Cached["projects"],
    chatStates: chatStates as Cached["chatStates"],
    latest: lists<ChatMessage>(latest),
    sends: lists<ChatSend>(sends),
    requests: Array.isArray(o.requests) ? (o.requests as HumanRequest[]) : undefined,
    me: typeof o.me === "string" ? o.me : undefined,
    meName: typeof o.meName === "string" ? o.meName : undefined,
    meAvatar: typeof o.meAvatar === "string" ? o.meAvatar : undefined,
    meRole: o.meRole === "owner" || o.meRole === "admin" || o.meRole === "member" ? o.meRole : undefined,
    open: openOf(o.open),
  };
};

const openOf = (v: unknown): OpenChat | undefined => {
  const o = record(v);
  if (o === undefined || typeof o.key !== "string" || !Array.isArray(o.messages) || typeof o.offset !== "number" || typeof o.rows !== "number") return undefined;
  return {
    key: o.key,
    messages: o.messages as ChatMessage[],
    hasOlder: o.hasOlder === true,
    offset: o.offset,
    rows: o.rows,
    oldestSeq: typeof o.oldestSeq === "number" ? o.oldestSeq : undefined,
  };
};
