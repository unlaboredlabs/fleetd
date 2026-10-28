// What the phone shows, as one pure state: the connection, the projects and their chat states from the snapshot and
// events, the chats opened so far (the desktop's chat reducers, desktop.ts), the person's sends on their way, and the
// open requests. The session (session.ts) does the calls and feeds their answers back here.
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
  type ChatMessageEventData,
  type ChatSend,
  type HubError,
  type HubEvent,
  type HubState,
  type HumanRequest,
  type ProjectChatState,
  type ProjectRef,
  type ProjectSummary,
} from "./desktop";

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
  readonly chats: Readonly<Record<Key, Chat>>;
  readonly sends: Readonly<Record<Key, readonly ChatSend[]>>;
  /** The open requests (requests_list); undefined until read on this connection. */
  readonly requests: readonly HumanRequest[] | undefined;
  /** Approvals answered from here and on their way, by requestId. */
  readonly answering: Readonly<Record<string, true>>;
  /** Why an answer failed, by requestId, until the next try. */
  readonly answerErrors: Readonly<Record<string, HubError>>;
}

export const initial = (hub: HubState): State => ({
  hub,
  projects: undefined,
  chatStates: {},
  chats: {},
  sends: {},
  requests: undefined,
  answering: {},
  answerErrors: {},
});

export type Action =
  | { readonly t: "frame"; readonly frame: HubFrame; readonly nowMs: number }
  | { readonly t: "chat_open"; readonly key: Key }
  | { readonly t: "history"; readonly key: Key; readonly page: ChatHistoryOutput; readonly direction: "latest" | "older" }
  | { readonly t: "history_failed"; readonly key: Key; readonly error: HubError }
  | { readonly t: "send"; readonly key: Key; readonly row: ChatSend }
  | { readonly t: "sent"; readonly key: Key; readonly clientRequestId: string; readonly result: CallResult; readonly leadWaiting?: string | undefined }
  | { readonly t: "requests"; readonly requests: readonly HumanRequest[] }
  | { readonly t: "answer"; readonly requestId: string }
  | { readonly t: "answered"; readonly requestId: string; readonly result: { ok: true; request: HumanRequest } | { ok: false; error: HubError } };

const chatOf = (s: State, key: Key): Chat => s.chats[key] ?? emptyChat;

const withChat = (s: State, key: Key, chat: Chat): State => (chat === s.chats[key] ? s : { ...s, chats: { ...s.chats, [key]: chat } });

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
      return { ...s, hub: frame.state, chats, requests: undefined, answering: {} };
    }
    case "snapshot": {
      const snap = frame.snapshot;
      return {
        ...s,
        projects: Object.fromEntries(snap.projects.map((p) => [keyOf(p), p])),
        chatStates: Object.fromEntries((snap.chats ?? []).map((c) => [keyOf(c.projectRef), c])),
      };
    }
    case "event":
      return applyEvent(s, frame.event);
    case "chat_delta": {
      const key = keyOf(frame.delta.projectRef);
      const chat = s.chats[key];
      return chat === undefined ? s : withChat(s, key, applyDelta(chat, frame.delta, nowMs));
    }
    case "error":
      return s;
  }
};

const applyEvent = (s: State, event: HubEvent): State => {
  if (event.type === "chat.waiting") {
    const state = event.data as ProjectChatState | undefined;
    if (state?.projectRef === undefined) return s;
    return { ...s, chatStates: { ...s.chatStates, [keyOf(state.projectRef)]: state } };
  }
  if (event.type !== "chat.message") return s;
  const data = event.data as ChatMessageEventData | undefined;
  if (data?.projectRef === undefined) return s;
  const key = keyOf(data.projectRef);
  const known = s.chatStates[key];
  const base = known === undefined || data.seq <= known.lastSeq ? s : { ...s, chatStates: { ...s.chatStates, [key]: { ...known, lastSeq: data.seq } } };
  const chat = base.chats[key];
  const message = data.message;
  if (chat === undefined) return base;
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
