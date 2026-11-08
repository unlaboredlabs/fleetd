// What the phone keeps of a hub between launches, so it opens on the chats as it last saw them, as Messages and
// other chat apps do, rather than on skeleton rows: the projects and their chat states, each chat's newest few messages (the
// list's previews), the open approvals (each chat's count and place), who the person is, and the messages on their way,
// which an app iOS kills must not lose. The snapshot and pages replace it all once the link is live. Pure, so it is
// unit-tested; cacheStore.ts keeps it on disk.
import type { ChatMessage, ChatSend, HubRole, HumanRequest, ProjectChatState, ProjectSummary } from "./desktop";
import type { Key, State } from "./store";

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
}

/** Where a send stands in the cache: one on its way when the app went may have reached the hub, so it goes again. */
const keptSend = (row: ChatSend): ChatSend => (row.state.t === "sending" ? { ...row, state: { t: "reconnecting" }, reached: true } : row);

export const cachedOf = (hub: string, s: State): Cached => ({
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
});

/**
 * A state opened on what was kept: shown until the snapshot replaces it. No lead is shown working, as none may be;
 * the sends go once the link is live (session.ts toResend).
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
  };
};
