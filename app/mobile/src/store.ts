// What the phone shows, as one pure state: the connection, the projects and their chat states from the snapshot and
// events, the chats opened so far (the desktop's chat reducers, desktop.ts), the person's sends on their way, the
// open requests (held through a drop, as the chats are), what the open chat's lead does this moment (its live lane) with when its turn began, and the screens
// of the chats looked at (their cards, and the live view's). The session (session.ts) does the calls and feeds their
// answers back here; a screen's frames go past it (session.ts onFrame), as they come many a second.
import { farFailed, farJoins, farLoading, farPage, farPageFrom, followLive, openingFar, type FarWindow } from "./chatView";
import { RESTART_FAST_MS, type HubFrame } from "./hub/client";
import { keyOf, refOf, type Key } from "./projectKey";
import {
  afterCall,
  applyDelta,
  applyHistory,
  emptyChat,
  heldChat,
  joinWindow,
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
  type ChatMessagePin,
  type ChatMessagePinsEventData,
  type ChatSend,
  type FleetStatus,
  type HubError,
  type HubEvent,
  type HubRole,
  type HubState,
  type HubUpdateData,
  type HumanRequest,
  type OrderCard,
  type ProjectChatState,
  type ProjectRef,
  type ProjectStatusRow,
  type ProjectSummary,
  type Activity,
  type BrowserSession,
  type BrowserSessionEventData,
  workedToward,
  type TurnSpan,
} from "./desktop";

export type Machine = FleetStatus["machines"][number];

export { keyOf, refOf, type Key } from "./projectKey";

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
  /**
   * The hub's update as its row says it, for everyone: the `hub.update` event's data, and the app snapshot's
   * `update`, the update going on or the last one; undefined from a hub before them, or one that never updated itself.
   */
  readonly hubUpdate: HubUpdateData | undefined;
  /** Undefined until the first snapshot. */
  readonly projects: Readonly<Record<Key, ProjectSummary>> | undefined;
  readonly chatStates: Readonly<Record<Key, ProjectChatState>>;
  /** The hub's machines, from the snapshot: what an update goes through. */
  readonly machines: readonly Machine[];
  /** Whether this phone's person is the hub's admin (hub_info), who can update it; undefined until read. */
  readonly admin: boolean | undefined;
  /** This phone's person (hub_info's `me`); undefined until read, and on a hub before people. */
  readonly me: string | undefined;
  /** That person's name, which the chats list's avatar shows the initial of; undefined as `me` is. */
  readonly meName: string | undefined;
  /** Their picture's id (person_avatar_get), shown in place of that initial; undefined while they have none. */
  readonly meAvatar: string | undefined;
  /** Their role on the hub, which Settings says under their name; undefined as `me` is. */
  readonly meRole: HubRole | undefined;
  /**
   * The tools the hub doesn't serve (hub_info's `leftOut`): on fleetd cloud, its self-update and restart, whose rows
   * Settings leaves out. Empty until read (or kept from the last launch), and on a self-run hub: one with any is a
   * fleetd cloud team however it was paired (cloud/account.ts shownHub).
   */
  readonly leftOut: readonly string[];
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
  /**
   * A chat opened at a message far back, around it (chatView.ts FarWindow): shown in its thread until it joins the chat's own
   * messages or the person goes back to the newest.
   */
  readonly windows: Readonly<Record<Key, FarWindow>>;
  /** Each chat's pinned messages, newest pinned first (messagePins.ts), read as it opens and again as one changes. */
  readonly messagePins: Readonly<Record<Key, readonly ChatMessagePin[]>>;
  /** The open requests (requests_list); undefined until read, or as last seen before the app was closed (cache.ts). */
  readonly requests: readonly HumanRequest[] | undefined;
  /** Whether the open requests were read from the hub since the app started, rather than only kept from before. */
  readonly requestsRead: boolean;
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
  /** Since when each lead lane does that (hub epoch ms): a run of Claude's retries from the first (W791). */
  readonly leadActivitySince?: Readonly<Record<string, number>>;
  /**
   * The hub's clock less this device's, from the live frames as the desktop reads it (its data/store.ts applyLive):
   * the largest `at - received` since the last full frame. A wake's count and Try again's countdown go by it.
   */
  readonly skewMs?: number | undefined;
  /** When each working lead's turn began (hub epoch ms), from the event that said so; unknown for one already working. */
  readonly turnSince: Readonly<Record<Key, number>>;
  /** Each lead's latest turn seen to its end (hub epoch ms at each end): how long it took, kept with its reply's time (chatView.ts). */
  readonly turnWorked: Readonly<Record<Key, { readonly since: number; readonly until: number; readonly ms?: number }>>;
  /** Each lead's last turns seen to their end, `cut` when the bot's last thread end before it went idle failed or was
   * interrupted: "Worked for" counts those the lead carried on toward its reply (the desktop's workedToward). */
  readonly turnSpans?: Readonly<Record<Key, readonly TurnSpan[]>> | undefined;
  /** The type of each bot's last thread end in the turn under way. */
  readonly turnLastEnd?: Readonly<Record<Key, string>> | undefined;
  /**
   * When each lead was last seen to stop working (hub epoch ms, the event's time), its start seen or not: a turn that
   * ended without a reply ends the bot's wait in the reply's place too (wake.ts). Absent from a cache before it.
   */
  readonly turnEnded?: Readonly<Record<Key, number>> | undefined;
  /** Why each blocked bot can't start, as Status last said it ("" with no reason); absent: not blocked. */
  readonly blocked?: Readonly<Record<Key, string>> | undefined;
  /** Each chat's screens, newest first (browser_sessions), read as it opens and again as one changes. */
  readonly screens: Readonly<Record<Key, readonly BrowserSession[]>>;
  /** Each project's agents at work, its lead not counted, from the open orders (orders_board): its bot works while any do, as the desktop's does. */
  readonly running: Readonly<Record<Key, number>>;
  /** The open orders (orders_board): a tagged chat's tags, lens and About… menu (chatTags.ts). */
  readonly orders: readonly OrderCard[];
}

export const initial = (hub: HubState): State => ({
  hub,
  restart: null,
  hubUpdate: undefined,
  projects: undefined,
  chatStates: {},
  machines: [],
  admin: undefined,
  me: undefined,
  meName: undefined,
  meAvatar: undefined,
  meRole: undefined,
  leftOut: [],
  chats: {},
  olderErrors: {},
  sends: {},
  latest: {},
  corpus: {},
  windows: {},
  messagePins: {},
  requests: undefined,
  requestsRead: false,
  answering: {},
  cut: {},
  answerErrors: {},
  decided: {},
  leadActivity: {},
  turnSince: {},
  turnWorked: {},
  screens: {},
  running: {},
  orders: [],
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
  /** A window asked for around a message far back, a page of it come or failed, or it closed (chatView.ts FarWindow). */
  | { readonly t: "window_open"; readonly key: Key; readonly anchor: string }
  | { readonly t: "window_page"; readonly key: Key; readonly anchor: string; readonly page: ChatHistoryOutput; readonly end: "around" | "older" | "newer" }
  | { readonly t: "window_loading"; readonly key: Key; readonly end: "older" | "newer" }
  | { readonly t: "window_failed"; readonly key: Key; readonly anchor: string; readonly end: "around" | "older" | "newer"; readonly error: HubError }
  | { readonly t: "window_close"; readonly key: Key }
  | { readonly t: "message_pins"; readonly key: Key; readonly pins: readonly ChatMessagePin[] }
  | { readonly t: "admin"; readonly admin: boolean; readonly me?: string | undefined; readonly meName?: string | undefined; readonly meAvatar?: string | undefined; readonly meRole?: HubRole | undefined; readonly leftOut?: readonly string[] | undefined }
  | { readonly t: "send"; readonly key: Key; readonly row: ChatSend }
  | { readonly t: "sent"; readonly key: Key; readonly clientRequestId: string; readonly result: CallResult; readonly leadWaiting?: string | undefined }
  /** A failed send deleted: it never goes. */
  | { readonly t: "discard"; readonly key: Key; readonly clientRequestId: string }
  | { readonly t: "requests"; readonly requests: readonly HumanRequest[] }
  | { readonly t: "board"; readonly orders: readonly OrderCard[] }
  /** Status's rows: which bots are blocked, and why. */
  | { readonly t: "status"; readonly rows: readonly ProjectStatusRow[] }
  /** A message moved to another order (chat_about_set's answer), before its event comes. */
  | { readonly t: "retagged"; readonly key: Key; readonly message: ChatMessage }
  | { readonly t: "screens"; readonly key: Key; readonly sessions: readonly BrowserSession[] }
  /** One screen as the hub answered a change of control with it. */
  | { readonly t: "screen"; readonly session: BrowserSession }
  | { readonly t: "answer"; readonly requestId: string }
  | { readonly t: "answered"; readonly requestId: string; readonly result: { ok: true; request: HumanRequest } | { ok: false; error: HubError } };

const chatOf = (s: State, key: Key): Chat => s.chats[key] ?? emptyChat;

/** Each project's agents at work in its open orders, its lead not counted, an agent two orders list once (the desktop's
 * selectProjectList running). */
export const runningOf = (orders: readonly OrderCard[]): Record<Key, number> => {
  const out: Record<Key, number> = {};
  const seen = new Set<string>();
  for (const card of orders) {
    for (const lane of card.lanes) {
      if (seen.has(lane.laneId)) continue;
      seen.add(lane.laneId);
      if (lane.role === "lead" || (lane.status !== "working" && lane.status !== "starting")) continue;
      const key = keyOf(card.projectRef);
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
};

/**
 * A chat as it opens before its latest page is read: the newest few messages the list holds, shown as they are (a
 * cached chat, which the page starts over), rather than a stand-in. The page's older messages come in above them, off
 * the screen's newest end, so nothing on screen moves.
 */
export const openingChat = (latest: readonly ChatMessage[] | undefined): Chat =>
  latest === undefined || latest.length === 0 ? emptyChat : { ...emptyChat, messages: latest, cached: true };

/**
 * The chats held whole: the one open and the last ones opened before it, for going back and forth. Each held chat
 * takes its messages from the events as they come (up to 2000 of them), so one held for each chat ever opened made the
 * app slower and bigger the longer it ran; one opened again reads its newest page, as on its first opening.
 */
export const CHATS_KEPT = 3;

/** A chat opened: held, after the others, which past CHATS_KEPT go from the one opened longest ago. */
const keepOpened = (s: State, key: Key): State => {
  const order = Object.keys(s.chats);
  if (order.at(-1) === key && s.chats[key] !== undefined) return s;
  const kept = [...order.filter((k) => k !== key), key].slice(-CHATS_KEPT);
  const chats: Record<Key, Chat> = {};
  for (const k of kept) chats[k] = k === key ? (s.chats[key] ?? openingChat(s.latest[key])) : s.chats[k]!;
  const gone = order.filter((k) => !kept.includes(k));
  if (gone.length === 0) return { ...s, chats };
  const drop = <T>(map: Readonly<Record<Key, T>>): Readonly<Record<Key, T>> => (gone.some((k) => k in map) ? Object.fromEntries(Object.entries(map).filter(([k]) => !gone.includes(k))) : map);
  return { ...s, chats, windows: drop(s.windows), olderErrors: drop(s.olderErrors) };
};

const withChat = (s: State, key: Key, chat: Chat): State => (chat === s.chats[key] ? s : { ...s, chats: { ...s.chats, [key]: chat } });

/** A chat's window, changed; one that has met the chat's own messages joins them and goes (desktop.ts joinWindow). */
const withWindow = (s: State, key: Key, w: FarWindow | undefined): State => {
  if (w === undefined) return { ...s, windows: without(s.windows, key) };
  const chat = s.chats[key];
  if (chat !== undefined && w.window !== undefined && farJoins(w, chat)) return withChat({ ...s, windows: without(s.windows, key) }, key, joinWindow(chat, w.window));
  return { ...s, windows: { ...s.windows, [key]: w } };
};

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
      return keepOpened(s, a.key);
    case "resume": {
      const chat = s.chats[a.key];
      if (chat?.cached !== true) return s;
      return withChat(s, a.key, { ...mergeMessages({ ...chat, cached: false, loaded: true }, chat.held), held: [] });
    }
    case "history": {
      const out = withChat({ ...s, olderErrors: without(s.olderErrors, a.key) }, a.key, applyHistory(chatOf(s, a.key), a.page, a.direction));
      // Its newest page may reach back to an open window's newest end.
      const w = out.windows[a.key];
      return w === undefined ? out : withWindow(out, a.key, w);
    }
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
    case "window_open":
      return withWindow(s, a.key, openingFar(a.anchor));
    case "window_loading": {
      const w = s.windows[a.key];
      return w === undefined || farPageFrom(w, a.end) === undefined ? s : withWindow(s, a.key, farLoading(w, a.end));
    }
    case "window_page": {
      // A page for a window since closed, or opened at another message: dropped.
      const w = s.windows[a.key];
      return w?.at !== a.anchor ? s : withWindow(s, a.key, farPage(w, a.page, a.end));
    }
    case "window_failed": {
      const w = s.windows[a.key];
      return w?.at !== a.anchor ? s : withWindow(s, a.key, farFailed(w, a.end, a.error));
    }
    case "window_close":
      return a.key in s.windows ? withWindow(s, a.key, undefined) : s;
    case "message_pins":
      return { ...s, messagePins: { ...s.messagePins, [a.key]: a.pins } };
    case "admin": {
      const leftOut = a.leftOut ?? [];
      return s.admin === a.admin && s.me === a.me && s.meName === a.meName && s.meAvatar === a.meAvatar && s.meRole === a.meRole && s.leftOut.join() === leftOut.join()
        ? s
        : { ...s, admin: a.admin, me: a.me, meName: a.meName, meAvatar: a.meAvatar, meRole: a.meRole, leftOut: s.leftOut.join() === leftOut.join() ? s.leftOut : leftOut };
    }
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
    case "board":
      // Read again with each of an order's events, mostly as it was: the same board changes nothing, and draws nothing.
      return JSON.stringify(a.orders) === JSON.stringify(s.orders) ? s : { ...s, running: runningOf(a.orders), orders: a.orders };
    case "status": {
      const blocked = Object.fromEntries(a.rows.filter((r) => r.state === "blocked").map((r) => [keyOf(r.projectRef), r.blockedReason ?? ""]));
      return JSON.stringify(blocked) === JSON.stringify(s.blocked ?? {}) ? s : { ...s, blocked };
    }
    case "retagged": {
      const chat = s.chats[a.key];
      return chat === undefined ? s : withChat(s, a.key, mergeMessages(chat, [a.message]));
    }
    case "requests": {
      const answering = Object.keys(s.cut).length === 0 ? s.answering : Object.fromEntries(Object.entries(s.answering).filter(([id]) => s.cut[id] === undefined));
      return { ...s, requests: a.requests.filter((r) => r.state === "open"), requestsRead: true, answering, cut: {} };
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
        // A hub that never updated itself sends null rather than leaving it out.
        hubUpdate: snap.update ?? undefined,
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
      const at = Date.parse(frame.frame.at);
      const seen = Number.isNaN(at) ? undefined : at - nowMs;
      const skewMs = seen === undefined ? s.skewMs : !full && s.skewMs !== undefined ? Math.max(s.skewMs, seen) : seen;
      if (!full && lanes.length === 0) return skewMs === s.skewMs ? s : { ...s, skewMs };
      const next: Record<string, Activity> = full ? {} : { ...s.leadActivity };
      const since: Record<string, number> = full ? {} : { ...s.leadActivitySince };
      for (const lane of lanes) {
        if (lane.activity === undefined) {
          delete next[lane.laneId];
          delete since[lane.laneId];
        } else {
          next[lane.laneId] = lane.activity.activity;
          const ms = Date.parse(lane.activity.since);
          if (Number.isNaN(ms)) delete since[lane.laneId];
          else since[lane.laneId] = ms;
        }
      }
      return { ...s, leadActivity: next, leadActivitySince: since, skewMs };
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

/** A thread's end, whose type says whether its run completed. */
const THREAD_ENDS = new Set(["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"]);
/** The turns kept per lead for "Worked for". */
const SPANS_KEPT = 8;

const applyEvent = (s: State, event: HubEvent, replayed: boolean): State => {
  const status = MACHINE_STATUS[event.type];
  if (status !== undefined) {
    // Missed while the link was down: the snapshot before it says how the machine is now.
    if (replayed) return s;
    // Why it is degraded, as the event says it (a runner check that answered after the snapshot); none otherwise.
    const data = (event.data ?? {}) as { degradedReason?: unknown; degradedCause?: unknown };
    const patch = (m: Machine): Machine => {
      const { degradedReason: _reason, degradedCause: _cause, ...rest } = m;
      if (status !== "degraded") return { ...rest, status };
      const reason = typeof data.degradedReason === "string" ? data.degradedReason : m.degradedReason;
      return { ...rest, status, ...(reason === undefined ? {} : { degradedReason: reason }), ...(data.degradedCause === "claude_login" ? { degradedCause: "claude_login" } : {}) };
    };
    // A degraded one again: its cause may have changed.
    const known = s.machines.some((m) => m.machineId === event.machineId && (m.status !== status || status === "degraded"));
    return known ? { ...s, machines: s.machines.map((m) => (m.machineId === event.machineId ? patch(m) : m)) } : s;
  }
  // Missed while the link was down: the snapshot before it has the update as it is now.
  if (event.type === "hub.update") return replayed ? s : { ...s, hubUpdate: (event.data as HubUpdateData | undefined) ?? s.hubUpdate };
  // A bot's thread ended: the last one before its lead goes idle is the lead's own, which says whether its turn was cut.
  if (THREAD_ENDS.has(event.type) && event.machineId !== undefined && event.projectId !== undefined) {
    const key = keyOf({ machineId: event.machineId, projectId: event.projectId });
    return { ...s, turnLastEnd: { ...s.turnLastEnd, [key]: event.type } };
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
    // It ends at its first "idle": how long it took, from a start seen here.
    const since = s.turnSince[key];
    const ended = !state.leadWorking && since !== undefined;
    const lastEnd = began ? undefined : s.turnLastEnd?.[key];
    const cut = lastEnd === "thread.failed" || lastEnd === "thread.interrupted";
    const spans = ended ? [...(s.turnSpans?.[key] ?? []), { since, until: Date.parse(event.at), ...(cut ? { cut: true } : {}) }].slice(-SPANS_KEPT) : s.turnSpans?.[key];
    // How long it worked toward its reply: this turn, and the cut ones right before it since your message.
    const asked = ended ? s.chats[key]?.messages.findLast((m) => m.author === "human" && Date.parse(m.createdAt) < since) : undefined;
    const ms = ended && spans !== undefined ? workedToward(spans, asked === undefined ? undefined : Date.parse(asked.createdAt)) : undefined;
    const turnWorked = ended ? { ...s.turnWorked, [key]: { since, until: Date.parse(event.at), ...(ms === undefined ? {} : { ms }) } } : s.turnWorked;
    const turnSpans = spans === undefined ? s.turnSpans : { ...s.turnSpans, [key]: spans };
    const turnLastEnd = began ? without(s.turnLastEnd ?? {}, key) : s.turnLastEnd;
    const stopped = !state.leadWorking && s.chatStates[key]?.leadWorking === true && !Number.isNaN(Date.parse(event.at));
    const turnEnded = stopped ? { ...s.turnEnded, [key]: Date.parse(event.at) } : s.turnEnded;
    return { ...s, chatStates: { ...s.chatStates, [key]: state }, turnSince, turnWorked, turnEnded, turnSpans, turnLastEnd };
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
  let base =
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
  // A message the open window holds too (a stream's end, a retag): its copy there follows.
  const w = base.windows[key];
  if (w !== undefined) base = { ...base, windows: { ...base.windows, [key]: followLive(w, message) } };
  // Its newest few too: a chat held from an earlier link keeps new messages aside, and the list's preview reads these.
  const out = withChat(withLatest(base, key, [message]), key, mergeLive(chat, message));
  return settled === undefined || settled === sends ? out : { ...out, sends: { ...out.sends, [key]: settled } };
};

/**
 * What an event asks the session to read again: the open requests, the orders board when its agents moved, a whole snapshot when the projects changed (a
 * machine removed too), the pinned chats or the sections when this person changed them on another device, who the person is when the
 * hub's people changed (a new picture), a chat's screens when one of them started, changed hands or ended, or a
 * chat's pinned messages when someone pinned or unpinned one (`messagePins`, its chat).
 */
export const effectsOf = (event: HubEvent): { readonly requests: boolean; readonly board: boolean; readonly status: boolean; readonly snapshot: boolean; readonly pins: boolean; readonly sections: boolean; readonly info: boolean; readonly screens?: Key; readonly messagePins?: Key } => {
  const screen = event.type === "browser.session" ? (event.data as BrowserSessionEventData | undefined)?.projectRef : undefined;
  const pinned = event.type === "chat.message_pins" ? (event.data as ChatMessagePinsEventData | undefined)?.projectRef : undefined;
  return {
    requests: event.type.startsWith("request."),
    // An agent started, ended or changed its order: who works where (the bots).
    board: event.type.startsWith("task.") || event.type.startsWith("workstream."),
    // A machine gone offline or back, a usage pause or limit: whether a bot is blocked (the desktop's effects.ts).
    status: event.type.startsWith("machine.") || event.type.startsWith("usage."),
    // A removed machine's projects went with it.
    snapshot: event.type === "project.added" || event.type === "project.removed" || event.type === "project.settings" || event.type === "machine.removed",
    pins: event.type === "chat.pins",
    sections: event.type === "chat.sections",
    // Who the person is: their name, role or picture may have changed.
    info: event.type === "people.changed",
    ...(screen === undefined ? {} : { screens: keyOf(screen) }),
    ...(pinned === undefined ? {} : { messagePins: keyOf(pinned) }),
  };
};
