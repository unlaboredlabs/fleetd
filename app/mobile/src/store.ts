// What the phone shows, as one pure state: the connection, the projects and their chat states from the snapshot and
// events, the chats opened so far (the desktop's chat reducers, desktop.ts), the person's sends on their way, the
// open requests (held through a drop, as the chats are), what the open chat's lead does this moment (its live lane) with when its turn began, and the screens
// of the chats looked at (their cards, and the live view's). The session (session.ts) does the calls and feeds their
// answers back here; a screen's frames go past it (session.ts onFrame), as they come many a second.
import { RESTART_FAST_MS, type HubFrame } from "./hub/client";
import {
  afterCall,
  applyDelta,
  applyHistory,
  emptyChat,
  heldChat,
  mergeMessages,
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
  type HubRole,
  type HubState,
  type HumanRequest,
  type ProjectChatState,
  type ProjectRef,
  type ProjectSummary,
  type Activity,
  type BrowserSession,
  type BrowserSessionEventData,
} from "./desktop";

export type Machine = FleetStatus["machines"][number];

/** "machineId/projectId". */
export type Key = string;

export const keyOf = (ref: ProjectRef): Key => `${ref.machineId}/${ref.projectId}`;

export const refOf = (key: Key): ProjectRef => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

/**
 * The hub's last restart as this phone saw it (hubWord.ts): down since `since` (epoch ms) from the version it ran,
 * `planned` when the hub closed the link to restart (client.ts `restart`), `update` when it said it was to update;
 * live again on the same version, back, which a drop within RESTART_FAST_MS goes on with (a hub still shutting down
 * takes the fast redial, then closes it); back on another version, updated, `took` ms after it went down. Null while
 * nothing is to say.
 */
export type Restart =
  | { readonly t: "down" | "back"; readonly since: number; readonly planned: boolean; readonly update: boolean; readonly from: string | undefined; readonly at?: number }
  | { readonly t: "updated"; readonly at: number; readonly from: string; readonly to: string; readonly took: number };

export interface State {
  readonly hub: HubState;
  readonly restart: Restart | null;
  /** Undefined until the first snapshot. */
  readonly projects: Readonly<Record<Key, ProjectSummary>> | undefined;
  readonly chatStates: Readonly<Record<Key, ProjectChatState>>;
  /** The hub's machines, from the snapshot: what an update goes through. */
  readonly machines: readonly Machine[];
  /** Whether this phone's person is the hub's admin (hub_info), who can update it; undefined until read. */
  readonly admin: boolean | undefined;
  /** This phone's person (hub_info's `me`), whose Only-me projects are theirs; undefined until read, and on a hub before people. */
  readonly me: string | undefined;
  /** That person's name, which the chats list's avatar shows the initial of; undefined as `me` is. */
  readonly meName: string | undefined;
  /** Their picture's id (person_avatar_get), shown in place of that initial; undefined while they have none. */
  readonly meAvatar: string | undefined;
  /** Their role on the hub, which Settings says under their name; undefined as `me` is. */
  readonly meRole: HubRole | undefined;
  readonly chats: Readonly<Record<Key, Chat>>;
  /** Why a chat's older page didn't come, which the top of its thread says, until a page of it does. */
  readonly olderErrors: Readonly<Record<Key, HubError>>;
  readonly sends: Readonly<Record<Key, readonly ChatSend[]>>;
  /**
   * Each chat's newest few messages, read after each snapshot and kept by events: the chats list's previews, with a
   * chat's own messages when those are newer.
   */
  readonly latest: Readonly<Record<Key, readonly ChatMessage[]>>;
  /** Each chat's newest page, read when search opens: what search looks through, with the chats opened. */
  readonly corpus: Readonly<Record<Key, readonly ChatMessage[]>>;
  /** The open requests (requests_list); undefined until read on this connection. */
  readonly requests: readonly HumanRequest[] | undefined;
  /** Approvals answered from here and on their way, by requestId. */
  readonly answering: Readonly<Record<string, true>>;
  /**
   * Answers the link cut off, which may have reached the hub: on their way, never an error, until the requests are
   * read again and say.
   */
  readonly cut: Readonly<Record<string, true>>;
  /** Why an answer failed, by requestId, until the next try. */
  readonly answerErrors: Readonly<Record<string, HubError>>;
  /** Requests answered from here, as the hub answered them: the chat says how each went before its message catches up. */
  readonly decided: Readonly<Record<string, HumanRequest>>;
  /** What a lead does this moment, by live lane id: the open chat's, which the turn line says (turn.ts). */
  readonly leadActivity: Readonly<Record<string, Activity>>;
  /** When each working lead's turn began (hub epoch ms), from the event that said so; unknown for one already working. */
  readonly turnSince: Readonly<Record<Key, number>>;
  /** Each chat's screens, newest first (browser_sessions), read as it opens and again as one changes. */
  readonly screens: Readonly<Record<Key, readonly BrowserSession[]>>;
}

export const initial = (hub: HubState): State => ({
  hub,
  restart: null,
  projects: undefined,
  chatStates: {},
  machines: [],
  admin: undefined,
  me: undefined,
  meName: undefined,
  meAvatar: undefined,
  meRole: undefined,
  chats: {},
  olderErrors: {},
  sends: {},
  latest: {},
  corpus: {},
  requests: undefined,
  answering: {},
  cut: {},
  answerErrors: {},
  decided: {},
  leadActivity: {},
  turnSince: {},
  screens: {},
});

export type Action =
  | { readonly t: "frame"; readonly frame: HubFrame; readonly nowMs: number }
  | { readonly t: "chat_open"; readonly key: Key }
  /** A chat held through a drop goes on as it was: the events the link missed replay into it (client.ts replay). */
  | { readonly t: "resume"; readonly key: Key }
  | { readonly t: "history"; readonly key: Key; readonly page: ChatHistoryOutput; readonly direction: "latest" | "older" }
  | { readonly t: "history_failed"; readonly key: Key; readonly error: HubError; readonly direction: "latest" | "older" }
  /** An older page asked for: one at a time, its spinner at the top. */
  | { readonly t: "loading_older"; readonly key: Key }
  | { readonly t: "latest"; readonly key: Key; readonly messages: readonly ChatMessage[] }
  | { readonly t: "corpus"; readonly key: Key; readonly messages: readonly ChatMessage[] }
  | { readonly t: "admin"; readonly admin: boolean; readonly me?: string | undefined; readonly meName?: string | undefined; readonly meAvatar?: string | undefined; readonly meRole?: HubRole | undefined }
  | { readonly t: "send"; readonly key: Key; readonly row: ChatSend }
  | { readonly t: "sent"; readonly key: Key; readonly clientRequestId: string; readonly result: CallResult; readonly leadWaiting?: string | undefined }
  /** A failed send deleted: it never goes. */
  | { readonly t: "discard"; readonly key: Key; readonly clientRequestId: string }
  | { readonly t: "requests"; readonly requests: readonly HumanRequest[] }
  | { readonly t: "screens"; readonly key: Key; readonly sessions: readonly BrowserSession[] }
  /** One screen as the hub answered a change of control with it. */
  | { readonly t: "screen"; readonly session: BrowserSession }
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
    case "resume": {
      const chat = s.chats[a.key];
      if (chat?.cached !== true) return s;
      return withChat(s, a.key, { ...mergeMessages({ ...chat, cached: false, loaded: true }, chat.held), held: [] });
    }
    case "history":
      return withChat({ ...s, olderErrors: without(s.olderErrors, a.key) }, a.key, applyHistory(chatOf(s, a.key), a.page, a.direction));
    case "loading_older":
      return withChat(s, a.key, { ...chatOf(s, a.key), loadingOlder: true });
    case "history_failed":
      // An older page's failure is about the top of the thread, not the chat: it's said there (Chat.tsx).
      return a.direction === "older"
        ? withChat({ ...s, olderErrors: { ...s.olderErrors, [a.key]: a.error } }, a.key, { ...chatOf(s, a.key), loadingOlder: false })
        : withChat(s, a.key, { ...chatOf(s, a.key), error: a.error, loadingOlder: false });
    case "latest":
      return withLatest(s, a.key, a.messages);
    case "corpus":
      return { ...s, corpus: { ...s.corpus, [a.key]: a.messages } };
    case "admin":
      return s.admin === a.admin && s.me === a.me && s.meName === a.meName && s.meAvatar === a.meAvatar && s.meRole === a.meRole
        ? s
        : { ...s, admin: a.admin, me: a.me, meName: a.meName, meAvatar: a.meAvatar, meRole: a.meRole };
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
    case "discard": {
      const rows = s.sends[a.key] ?? [];
      const sends = rows.filter((r) => r.clientRequestId !== a.clientRequestId);
      return sends.length === rows.length ? s : { ...s, sends: { ...s.sends, [a.key]: sends } };
    }
    case "requests": {
      const answering = Object.keys(s.cut).length === 0 ? s.answering : Object.fromEntries(Object.entries(s.answering).filter(([id]) => s.cut[id] === undefined));
      return { ...s, requests: a.requests.filter((r) => r.state === "open"), answering, cut: {} };
    }
    case "screens":
      return { ...s, screens: { ...s.screens, [a.key]: a.sessions } };
    case "screen": {
      const key = keyOf(a.session.projectRef);
      const known = s.screens[key] ?? [];
      const sessions = known.some((x) => x.sessionId === a.session.sessionId) ? known.map((x) => (x.sessionId === a.session.sessionId ? a.session : x)) : [a.session, ...known];
      return { ...s, screens: { ...s.screens, [key]: sessions } };
    }
    case "answer":
      return { ...s, answering: { ...s.answering, [a.requestId]: true }, answerErrors: without(s.answerErrors, a.requestId) };
    case "answered": {
      if (!a.result.ok && a.result.error.code === "disconnected") return { ...s, cut: { ...s.cut, [a.requestId]: true } };
      const base = { ...s, answering: without(s.answering, a.requestId), cut: without(s.cut, a.requestId) };
      if (!a.result.ok) return { ...base, answerErrors: { ...s.answerErrors, [a.requestId]: a.result.error } };
      const answered = a.result.request;
      return {
        ...base,
        requests: s.requests?.filter((r) => r.requestId !== answered.requestId || answered.state === "open"),
        decided: { ...s.decided, [answered.requestId]: answered },
      };
    }
  }
};

const applyFrame = (s: State, frame: HubFrame, nowMs: number): State => {
  switch (frame.t) {
    case "restart":
      return s.hub.phase === "live" ? { ...s, restart: downFrom(s, nowMs, true, /updat/iu.test(frame.reason)) } : s;
    case "state": {
      const restart = restartAfter(s, frame.state, nowMs);
      // A link that isn't live any more: what it showed stays, held, until the next snapshot and pages replace it. The
      // open requests too, so approvals keep their cards and their chats their place, till requests_list says again.
      if (frame.state.phase === "live" || s.hub.phase !== "live") return { ...s, hub: frame.state, restart };
      const chats: Record<Key, Chat> = {};
      for (const [key, chat] of Object.entries(s.chats)) chats[key] = heldChat(chat) ?? emptyChat;
      return { ...s, hub: frame.state, restart, chats, leadActivity: {} };
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
      return applyEvent(s, frame.event, frame.replayed === true);
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
    case "browser_frame":
    case "browser_error":
    case "error":
      return s;
  }
};

/** The link went down: a restart of its own, or the one it came back from a moment ago going on. */
const downFrom = (s: State, nowMs: number, planned: boolean, update: boolean): Restart => {
  const was = s.restart?.t === "back" && nowMs - (s.restart.at ?? 0) < RESTART_FAST_MS ? s.restart : null;
  if (was === null) return { t: "down", since: nowMs, planned, update, from: s.hub.phase === "live" ? s.hub.version : undefined };
  return { t: "down", since: was.since, planned: planned || was.planned, update: update || was.update, from: was.from };
};

/**
 * The restart after a change of link: a live link that went down without the hub saying why went down unplanned; back
 * live, on another version than it went down on, the hub was updated.
 */
const restartAfter = (s: State, next: HubState, nowMs: number): Restart | null => {
  if (next.phase === "live") {
    const was = s.restart;
    if (was?.t !== "down") return was;
    return was.from !== undefined && next.version !== undefined && next.version !== was.from ? { t: "updated", at: nowMs, from: was.from, to: next.version, took: nowMs - was.since } : { ...was, t: "back", at: nowMs };
  }
  if (s.hub.phase === "live" && s.restart?.t !== "down") return downFrom(s, nowMs, false, false);
  // Stopped or refused: no restart is going on.
  return next.phase === "unpaired" || next.phase === "refused" ? null : s.restart;
};

/** A machine's status as each event says, as the desktop's store patches it: the next snapshot may be a while off. */
const MACHINE_STATUS: Readonly<Record<string, Machine["status"]>> = { "machine.online": "online", "machine.offline": "offline", "machine.degraded": "degraded" };

const applyEvent = (s: State, event: HubEvent, replayed: boolean): State => {
  const status = MACHINE_STATUS[event.type];
  if (status !== undefined) {
    // Missed while the link was down: the snapshot before it says how the machine is now.
    if (replayed) return s;
    const known = s.machines.some((m) => m.machineId === event.machineId && m.status !== status);
    return known ? { ...s, machines: s.machines.map((m) => (m.machineId === event.machineId ? { ...m, status } : m)) } : s;
  }
  if (event.type === "chat.waiting") {
    // What a chat waits for, missed while the link was down: the snapshot before it says it as it is now.
    if (replayed) return s;
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
  const message = data.message;
  // A new message lifts its chat in the list at once, with its time: the hub says chat.waiting only when what its
  // chat waits for changes.
  const at = message?.createdAt ?? event.at;
  const base =
    known === undefined || data.seq <= known.lastSeq
      ? s
      : { ...s, chatStates: { ...s.chatStates, [key]: { ...known, lastSeq: data.seq, lastMessageAt: known.lastMessageAt === undefined || at > known.lastMessageAt ? at : known.lastMessageAt } } };
  const chat = base.chats[key];
  if (chat === undefined) return message === undefined ? base : withLatest(base, key, [message]);
  if (message === undefined) {
    // Too big for the event: the session reads it by seq (missingSeqs).
    return chat.missing.includes(data.seq) ? base : withChat(base, key, { ...chat, missing: [...chat.missing, data.seq] });
  }
  const sends = base.sends[key];
  const settled = sends === undefined ? undefined : settleSends(sends, [message]);
  // Its newest few too: a chat held from an earlier link keeps new messages aside, and the list's preview reads these.
  const out = withChat(withLatest(base, key, [message]), key, mergeLive(chat, message));
  return settled === undefined || settled === sends ? out : { ...out, sends: { ...out.sends, [key]: settled } };
};

/**
 * What an event asks the session to read again: the open requests, a whole snapshot when the projects changed (a
 * machine removed too), the pinned chats when this person changed them on another device, who the person is when the
 * hub's people changed (a new picture), or a chat's screens when one of them started, changed hands or ended.
 */
export const effectsOf = (event: HubEvent): { readonly requests: boolean; readonly snapshot: boolean; readonly pins: boolean; readonly info: boolean; readonly screens?: Key } => {
  const screen = event.type === "browser.session" ? (event.data as BrowserSessionEventData | undefined)?.projectRef : undefined;
  return {
    requests: event.type.startsWith("request."),
    // A removed machine's projects went with it.
    snapshot: event.type === "project.added" || event.type === "project.removed" || event.type === "project.settings" || event.type === "machine.removed",
    pins: event.type === "chat.pins",
    // Who the person is: their name, role or picture may have changed.
    info: event.type === "people.changed",
    ...(screen === undefined ? {} : { screens: keyOf(screen) }),
  };
};
