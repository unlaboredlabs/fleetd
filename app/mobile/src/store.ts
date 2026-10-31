// What the phone shows, as one pure state: the connection, the projects and their chat states from the snapshot and
// events, the chats opened so far (the desktop's chat reducers, desktop.ts), the person's sends on their way, the
// open requests, and what the open chat's lead does this moment (its live lane) with when its turn began. The session (session.ts) does the calls and feeds their answers back here.
import type { HubFrame } from "./hub/client";
import {
  afterCall,
  applyDelta,
  applyHistory,
  emptyChat,
  heldChat,
  mergeLive,
  mergeOwn,
  settleSends,
  upsertSend,
  type CallResult,
  type Chat,
  type ChatHistoryOutput,
  type ChatMessage,
  type ChatMessageEventData,
  type ChatSend,
  type FleetStatus,
  type HubError,
  type HubEvent,
  type HubState,
  type HumanRequest,
  type ProjectChatState,
  type ProjectRef,
  type ProjectSummary,
  type Activity,
} from "./desktop";

export type Machine = FleetStatus["machines"][number];

/** "machineId/projectId". */
export type Key = string;

export const keyOf = (ref: ProjectRef): Key => `${ref.machineId}/${ref.projectId}`;

export const refOf = (key: Key): ProjectRef => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

export interface State {
  readonly hub: HubState;
  /** Undefined until the first snapshot. */
  readonly projects: Readonly<Record<Key, ProjectSummary>> | undefined;
  readonly chatStates: Readonly<Record<Key, ProjectChatState>>;
  /** The hub's machines, from the snapshot: what an update goes through. */
  readonly machines: readonly Machine[];
  /** Whether this phone's person is the hub's admin (hub_info), who can update it; undefined until read. */
  readonly admin: boolean | undefined;
  /** This phone's person (hub_info's `me`), whose Navis are theirs; undefined until read, and on a hub before people. */
  readonly me: string | undefined;
  /** That person's name, which the chats list's avatar shows the initial of; undefined as `me` is. */
  readonly meName: string | undefined;
  readonly chats: Readonly<Record<Key, Chat>>;
  readonly sends: Readonly<Record<Key, readonly ChatSend[]>>;
  /** Each chat's newest few messages, read after each snapshot and kept by events: the chats list's previews. */
  readonly latest: Readonly<Record<Key, readonly ChatMessage[]>>;
  /** Each chat's newest page, read when search opens: what search looks through, with the chats opened. */
  readonly corpus: Readonly<Record<Key, readonly ChatMessage[]>>;
  /** The open requests (requests_list); undefined until read on this connection. */
  readonly requests: readonly HumanRequest[] | undefined;
  /** Approvals answered from here and on their way, by requestId. */
  readonly answering: Readonly<Record<string, true>>;
  /** Why an answer failed, by requestId, until the next try. */
  readonly answerErrors: Readonly<Record<string, HubError>>;
  /** What a lead does this moment, by live lane id: the open chat's, which the turn line says (turn.ts). */
  readonly leadActivity: Readonly<Record<string, Activity>>;
  /** When each working lead's turn began (hub epoch ms), from the event that said so; unknown for one already working. */
  readonly turnSince: Readonly<Record<Key, number>>;
}

export const initial = (hub: HubState): State => ({
  hub,
  projects: undefined,
  chatStates: {},
  machines: [],
  admin: undefined,
  me: undefined,
  meName: undefined,
  chats: {},
  sends: {},
  latest: {},
  corpus: {},
  requests: undefined,
  answering: {},
  answerErrors: {},
  leadActivity: {},
  turnSince: {},
});

export type Action =
  | { readonly t: "frame"; readonly frame: HubFrame; readonly nowMs: number }
  | { readonly t: "chat_open"; readonly key: Key }
  | { readonly t: "history"; readonly key: Key; readonly page: ChatHistoryOutput; readonly direction: "latest" | "older" }
  | { readonly t: "history_failed"; readonly key: Key; readonly error: HubError }
  | { readonly t: "latest"; readonly key: Key; readonly messages: readonly ChatMessage[] }
  | { readonly t: "corpus"; readonly key: Key; readonly messages: readonly ChatMessage[] }
  | { readonly t: "admin"; readonly admin: boolean; readonly me?: string | undefined; readonly meName?: string | undefined }
  | { readonly t: "send"; readonly key: Key; readonly row: ChatSend }
  | { readonly t: "sent"; readonly key: Key; readonly clientRequestId: string; readonly result: CallResult; readonly leadWaiting?: string | undefined }
  | { readonly t: "requests"; readonly requests: readonly HumanRequest[] }
  | { readonly t: "answer"; readonly requestId: string }
  | { readonly t: "answered"; readonly requestId: string; readonly result: { ok: true; request: HumanRequest } | { ok: false; error: HubError } };

const chatOf = (s: State, key: Key): Chat => s.chats[key] ?? emptyChat;

const withChat = (s: State, key: Key, chat: Chat): State => (chat === s.chats[key] ? s : { ...s, chats: { ...s.chats, [key]: chat } });

/** The newest messages kept for a chat's preview. */
export const LATEST = 3;

const withLatest = (s: State, key: Key, messages: readonly ChatMessage[]): State => {
  const known = s.latest[key] ?? [];
  const merged = new Map([...known, ...messages].map((m) => [m.messageId, m]));
  const newest = [...merged.values()].sort((x, y) => x.seq - y.seq).slice(-LATEST);
  return { ...s, latest: { ...s.latest, [key]: newest } };
};

const without = <T>(map: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> =>
  key in map ? Object.fromEntries(Object.entries(map).filter(([k]) => k !== key)) : map;

export const reduce = (s: State, a: Action): State => {
  switch (a.t) {
    case "frame":
      return applyFrame(s, a.frame, a.nowMs);
    case "chat_open":
      return s.chats[a.key] === undefined ? withChat(s, a.key, emptyChat) : s;
    case "history":
      return withChat(s, a.key, applyHistory(chatOf(s, a.key), a.page, a.direction));
    case "history_failed":
      return withChat(s, a.key, { ...chatOf(s, a.key), error: a.error, loadingOlder: false });
    case "latest":
      return withLatest(s, a.key, a.messages);
    case "corpus":
      return { ...s, corpus: { ...s.corpus, [a.key]: a.messages } };
    case "admin":
      return s.admin === a.admin && s.me === a.me && s.meName === a.meName ? s : { ...s, admin: a.admin, me: a.me, meName: a.meName };
    case "send": {
      const sends = upsertSend(s.sends[a.key] ?? [], a.row);
      return { ...s, sends: { ...s.sends, [a.key]: sends } };
    }
    case "sent": {
      const rows = s.sends[a.key] ?? [];
      const row = rows.find((r) => r.clientRequestId === a.clientRequestId);
      if (row === undefined) return s;
      const next = afterCall(row, a.result);
      const sends = next === undefined ? rows.filter((r) => r !== row) : rows.map((r) => (r === row ? next : r));
      let out: State = { ...s, sends: { ...s.sends, [a.key]: sends } };
      if (a.result.ok) {
        const chat = mergeOwn(chatOf(out, a.key), a.result.message);
        const waiting = a.leadWaiting === undefined ? chat : { ...chat, leadWaiting: { ...chat.leadWaiting, [a.result.message.messageId]: a.leadWaiting } };
        out = withChat(out, a.key, waiting);
      }
      return out;
    }
    case "requests":
      return { ...s, requests: a.requests.filter((r) => r.state === "open") };
    case "answer":
      return { ...s, answering: { ...s.answering, [a.requestId]: true }, answerErrors: without(s.answerErrors, a.requestId) };
    case "answered": {
      const base = { ...s, answering: without(s.answering, a.requestId) };
      if (!a.result.ok) return { ...base, answerErrors: { ...s.answerErrors, [a.requestId]: a.result.error } };
      const answered = a.result.request;
      return { ...base, requests: s.requests?.filter((r) => r.requestId !== answered.requestId || answered.state === "open") };
    }
  }
};

const applyFrame = (s: State, frame: HubFrame, nowMs: number): State => {
  switch (frame.t) {
    case "state": {
      // A link that isn't live any more: what it showed stays, held, until the next snapshot and pages replace it.
      if (frame.state.phase === "live" || s.hub.phase !== "live") return { ...s, hub: frame.state };
      const chats: Record<Key, Chat> = {};
      for (const [key, chat] of Object.entries(s.chats)) chats[key] = heldChat(chat) ?? emptyChat;
      return { ...s, hub: frame.state, chats, requests: undefined, answering: {}, leadActivity: {} };
    }
    case "snapshot": {
      const snap = frame.snapshot;
      const chatStates = Object.fromEntries((snap.chats ?? []).map((c) => [keyOf(c.projectRef), c]));
      return {
        ...s,
        projects: Object.fromEntries(snap.projects.map((p) => [keyOf(p), p])),
        machines: snap.machines,
        chatStates,
        turnSince: Object.fromEntries(Object.entries(s.turnSince).filter(([key]) => chatStates[key]?.leadWorking === true)),
      };
    }
    case "event":
      return applyEvent(s, frame.event);
    case "chat_delta": {
      const key = keyOf(frame.delta.projectRef);
      const chat = s.chats[key];
      return chat === undefined ? s : withChat(s, key, applyDelta(chat, frame.delta, nowMs));
    }
    case "live": {
      // A full frame names every lane in scope (the others are gone); a delta only those that changed.
      const { full, lanes } = frame.frame;
      if (!full && lanes.length === 0) return s;
      const next: Record<string, Activity> = full ? {} : { ...s.leadActivity };
      for (const lane of lanes) {
        if (lane.activity === undefined) delete next[lane.laneId];
        else next[lane.laneId] = lane.activity.activity;
      }
      return { ...s, leadActivity: next };
    }
    case "error":
      return s;
  }
};

const applyEvent = (s: State, event: HubEvent): State => {
  if (event.type === "chat.waiting") {
    const state = event.data as ProjectChatState | undefined;
    if (state?.projectRef === undefined) return s;
    const key = keyOf(state.projectRef);
    // A turn begins when its lead starts working; the hub says "working" again mid-turn, which is no new turn.
    const began = state.leadWorking && s.chatStates[key]?.leadWorking !== true;
    const turnSince = began ? { ...s.turnSince, [key]: Date.parse(event.at) } : state.leadWorking ? s.turnSince : without(s.turnSince, key);
    return { ...s, chatStates: { ...s.chatStates, [key]: state }, turnSince };
  }
  if (event.type !== "chat.message") return s;
  const data = event.data as ChatMessageEventData | undefined;
  if (data?.projectRef === undefined) return s;
  const key = keyOf(data.projectRef);
  const known = s.chatStates[key];
  const base = known === undefined || data.seq <= known.lastSeq ? s : { ...s, chatStates: { ...s.chatStates, [key]: { ...known, lastSeq: data.seq } } };
  const chat = base.chats[key];
  const message = data.message;
  if (chat === undefined) return message === undefined ? base : withLatest(base, key, [message]);
  if (message === undefined) {
    // Too big for the event: the session reads it by seq (missingSeqs).
    return chat.missing.includes(data.seq) ? base : withChat(base, key, { ...chat, missing: [...chat.missing, data.seq] });
  }
  const sends = base.sends[key];
  const settled = sends === undefined ? undefined : settleSends(sends, [message]);
  const out = withChat(base, key, mergeLive(chat, message));
  return settled === undefined || settled === sends ? out : { ...out, sends: { ...out.sends, [key]: settled } };
};

/** What an event asks the session to read again: the open requests, or a whole snapshot when the projects changed. */
export const effectsOf = (event: HubEvent): { readonly requests: boolean; readonly snapshot: boolean } => ({
  requests: event.type.startsWith("request."),
  snapshot: event.type === "project.added" || event.type === "project.removed" || event.type === "project.settings",
});
