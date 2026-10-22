// The renderer's hub state: what main forwards (state, snapshot, events, live frames) and what calls returned,
// keyed by entity. Every change goes through the pure reducers here, so they are unit-tested without a hub.
//
// Freshness: a snapshot starts a new generation and drops everything calls filled in, so a (re)connect shows
// skeletons until the refetches land, never the previous connection's data as if it were live.
import { createStore } from "zustand/vanilla";
import {
  dataField,
  eventData,
  type HubEventOf,
  type AgentLane,
  type Claim,
  type HubEvent,
  type LiveFrame,
  type LiveLane,
  type Machine,
  type MachineLive,
  type OrderCard,
  type ProjectSummary,
  type SlotState,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  type TrainLive,
} from "../../../shared/contracts";
import type { HubError, HubFrame, HubState } from "../../../shared/hub";
import { applyDelta, emptyChat, mergeLive, settleSends, type Chat, type ChatSend } from "./chat";
import type { AgentRow } from "./agents-contract";
import { CHAT_EVENTS, type ChatDelta, type ProjectChatState } from "./chat-contract";
import { ordersNamed } from "./effects";
import { settled } from "./phase";

/** "machineId/projectId". */
export type ProjectKey = string;
export const projectKey = (r: { readonly machineId: string; readonly projectId: string }): ProjectKey =>
  `${r.machineId}/${r.projectId}`;

/** An order's detail from order_get. */
export interface OrderDetail {
  readonly lead?: AgentLane | undefined;
  /** Newest first. */
  readonly doneLanes: readonly AgentLane[];
  readonly claims: readonly Claim[];
}

export interface LiveState {
  readonly lanes: Readonly<Record<string, LiveLane>>;
  /**
   * When the feed first said each lane finished (the frame's hub time). A board card still lists a lane the feed
   * just finished, without an end time; this is its end time until the hub's own arrives, so its clock stops and its
   * check can hold for a moment before it leaves.
   */
  readonly ended: Readonly<Record<string, string>>;
  /** The tail of the message each lane is writing. */
  readonly text: Readonly<Record<string, { readonly messageId: string; readonly text: string }>>;
  /**
   * A project lead's recent messages in full, oldest first (the order view's conversation): `text` keeps a tail, and
   * a lead can stream far more than that before its log has the message. Bounded per lead by STREAM_CHARS.
   */
  readonly streams?: Readonly<Record<string, readonly { readonly messageId: string; readonly text: string }[]>> | undefined;
  readonly machines: Readonly<Record<string, MachineLive>>;
  readonly slots?: SlotState | undefined;
  /** Hub clock minus local clock, in ms; see `applyLive`. */
  readonly skewMs?: number | undefined;
  /** The feed dropped: values stay, the UI greys them, until the next frame. */
  readonly stale: boolean;
}

export interface DataState {
  readonly hub: HubState;
  /** A snapshot arrived since the link last went down: what the store holds is current. */
  readonly fresh: boolean;
  /** Bumped by every snapshot; call results from an older generation are dropped. */
  readonly generation: number;
  readonly sessionError?: HubError | undefined;
  /** The last event applied; older or repeated ones are ignored. */
  readonly cursor?: number | undefined;
  readonly machines: Readonly<Record<string, Machine>>;
  readonly projects: Readonly<Record<ProjectKey, ProjectSummary>>;
  readonly attention: readonly HubEvent[];
  readonly slots?: SlotState | undefined;
  /** Every order the board lists, by workstreamId; undefined until this generation's board landed. */
  readonly orders?: Readonly<Record<string, OrderCard>> | undefined;
  readonly details: Readonly<Record<string, OrderDetail>>;
  /** Every agent across the projects (agents_list), as last read; undefined until this generation's read landed. */
  readonly agents?: readonly AgentRow[] | undefined;
  readonly trains: Readonly<Record<string, TrainLive>>;
  /** The latest events, oldest first. */
  readonly events: readonly HubEvent[];
  /** The latest events naming each order, oldest first: the order view's merged event lines. */
  readonly orderEvents: Readonly<Record<string, readonly HubEvent[]>>;
  readonly live: LiveState;
  /** Each opened project's lead chat; dropped by a snapshot, so a reconnect shows its skeleton until reread. */
  readonly chats: Readonly<Record<ProjectKey, Chat>>;
  /** The person's messages not yet settled by the hub. Theirs, not the hub's: kept across reconnects. */
  readonly chatSends: Readonly<Record<ProjectKey, readonly ChatSend[]>>;
  /** Per project: whether its lead waits on the person, and whether it works. */
  readonly chatStates: Readonly<Record<ProjectKey, ProjectChatState>>;
  /** Whether this hub can stop a lead mid-turn (chat_stop); undefined until asked, again on each connection. */
  readonly chatStop?: boolean | undefined;
}

const RECENT_EVENTS = 200;
const ORDER_EVENTS = 100;
/** Orders whose event lines are kept; the least recently active goes first. */
const ORDERS_WITH_EVENTS = 100;
const TEXT_TAIL = 2000;
const STREAM_CHARS = 1_500_000;
const isLeadLane = (laneId: string) => laneId.startsWith("lead:");

type Stream = readonly { readonly messageId: string; readonly text: string }[];
/** Appends to a lead's stream, dropping its oldest messages past the cap (the newest is cut to its tail). */
const appendStream = (stream: Stream, messageId: string, append: string): Stream => {
  const last = stream.at(-1);
  let next = last?.messageId === messageId ? [...stream.slice(0, -1), { messageId, text: last.text + append }] : [...stream, { messageId, text: append }];
  let size = next.reduce((n, m) => n + m.text.length, 0);
  while (size > STREAM_CHARS && next.length > 1) {
    size -= next[0]?.text.length ?? 0;
    next = next.slice(1);
  }
  const only = next[0];
  if (size > STREAM_CHARS && only !== undefined) next = [{ messageId: only.messageId, text: only.text.slice(-STREAM_CHARS) }];
  return next;
};

/**
 * The leads' streams after a live frame. A frame with no lead text keeps them, identity included; a full frame
 * starts them over, as it does `text`.
 */
export const applyStreams = (streams: LiveState["streams"], frame: LiveFrame): LiveState["streams"] => {
  const lead = (frame.text ?? []).filter((t) => isLeadLane(t.laneId));
  if (lead.length === 0) return frame.full ? {} : streams;
  const next: Record<string, Stream> = frame.full ? {} : { ...streams };
  for (const t of lead) next[t.laneId] = appendStream(next[t.laneId] ?? [], t.messageId, t.append);
  return next;
};

const emptyLive: LiveState = { lanes: {}, ended: {}, text: {}, machines: {}, stale: true };

export const initialState = (): DataState => ({
  hub: { phase: "connecting", hub: "", attempt: 0 },
  fresh: false,
  generation: 0,
  machines: {},
  projects: {},
  attention: [],
  details: {},
  trains: {},
  events: [],
  orderEvents: {},
  live: emptyLive,
  chats: {},
  chatSends: {},
  chatStates: {},
});

/** What a frame asks of the query layer besides the state change. */
export interface Effects {
  /** A new snapshot: refetch everything. */
  readonly refetchAll?: boolean;
}

const byId = <T>(items: readonly T[], id: (item: T) => string): Record<string, T> =>
  Object.fromEntries(items.map((item) => [id(item), item]));

const pushCapped = <T>(list: readonly T[], item: T, cap: number): readonly T[] =>
  list.length < cap ? [...list, item] : [...list.slice(list.length - cap + 1), item];

/** The last `max` UTF-16 units, never splitting a surrogate pair. */
const tail = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let from = text.length - max;
  const code = text.charCodeAt(from);
  if (code >= 0xdc00 && code <= 0xdfff) from += 1;
  return text.slice(from);
};

export const applyFrame = (s: DataState, frame: HubFrame, nowMs: number): [DataState, Effects] => {
  switch (frame.t) {
    case "state": {
      const live = frame.state.phase === "live";
      return [{ ...s, hub: frame.state, fresh: live && s.fresh, live: live ? s.live : { ...s.live, stale: true } }, {}];
    }
    case "snapshot": {
      const snap = frame.snapshot;
      return [
        {
          ...s,
          fresh: true,
          generation: s.generation + 1,
          sessionError: undefined,
          cursor: snap.cursor,
          machines: byId(snap.machines, (m) => m.machineId),
          projects: byId(snap.projects, projectKey),
          attention: snap.attention,
          slots: snap.slots,
          orders: undefined,
          agents: undefined,
          details: {},
          trains: {},
          chats: {},
          chatStates: byId(snap.chats ?? [], (c) => projectKey(c.projectRef)),
          chatStop: undefined,
        },
        { refetchAll: true },
      ];
    }
    case "event":
      return [applyEvent(s, frame.event), {}];
    case "chat_delta":
      return [applyChatDelta(s, frame.delta), {}];
    case "live":
      return [{ ...s, live: { ...applyLive(s.live, frame.frame, nowMs), streams: applyStreams(s.live.streams, frame.frame) } }, {}];
    case "error":
      return [{ ...s, sessionError: frame.error }, {}];
  }
};

/** The chat states with `key`'s newest seq raised to `seq`; the same object when it is not newer or unknown. */
const newerSeq = (states: DataState["chatStates"], key: ProjectKey, seq: number): DataState["chatStates"] => {
  const state = states[key];
  return state === undefined || seq <= state.lastSeq ? states : { ...states, [key]: { ...state, lastSeq: seq } };
};

/** The chat events: messages into an opened chat, the person's sends settled, the lead's waiting/working state. */
const applyChatEvent = (s: DataState, event: HubEvent): DataState => {
  switch (event.type) {
    case CHAT_EVENTS.message: {
      const data = eventData<"chat.message">(event as HubEventOf<"chat.message">);
      if (data === undefined) return s;
      const key = projectKey(data.projectRef);
      // Every project's newest seq follows its messages, opened or not: the sidebar's unread mark compares it with
      // the seq last looked at.
      const states = newerSeq(s.chatStates, key, data.seq);
      const base = states === s.chatStates ? s : { ...s, chatStates: states };
      const chat = base.chats[key];
      const message = data.message;
      if (message === undefined) {
        // Too big for the event: read it by seq, unless the chat already has this copy or a newer one.
        const held = chat?.messages.find((m) => m.messageId === data.messageId);
        if (chat?.loaded !== true || (held !== undefined && held.state === data.state)) return base;
        return chat.missing.includes(data.seq) ? base : { ...base, chats: { ...base.chats, [key]: { ...chat, missing: [...chat.missing, data.seq] } } };
      }
      const sends = base.chatSends[key];
      const settled = sends === undefined ? undefined : settleSends(sends, [message]);
      return {
        ...base,
        chats: chat?.loaded === true ? { ...base.chats, [key]: mergeLive(chat, message) } : base.chats,
        chatSends: settled === undefined || settled === sends ? base.chatSends : { ...base.chatSends, [key]: settled },
      };
    }
    case CHAT_EVENTS.waiting: {
      const state = eventData<"chat.waiting">(event as HubEventOf<"chat.waiting">);
      if (state === undefined) return s;
      return { ...s, chatStates: { ...s.chatStates, [projectKey(state.projectRef)]: state } };
    }
    default:
      return s;
  }
};

/** A streamed frame of the subscribed chat. */
export const applyChatDelta = (s: DataState, d: ChatDelta): DataState => {
  const key = projectKey(d.projectRef);
  const chat = s.chats[key];
  if (chat?.loaded !== true) return s;
  const next = applyDelta(chat, d);
  return next === chat ? s : { ...s, chats: { ...s.chats, [key]: next } };
};

/** A chat's state, created on first touch. */
export const chatOf = (s: DataState, key: ProjectKey): Chat => s.chats[key] ?? emptyChat;

const patchOrder = (s: DataState, workstreamId: string | undefined, patch: Partial<OrderCard>): DataState => {
  const card = workstreamId === undefined ? undefined : s.orders?.[workstreamId];
  if (card === undefined || workstreamId === undefined) return s;
  return { ...s, orders: { ...s.orders, [workstreamId]: { ...card, ...patch } } };
};

const withOrderEvent = (
  rings: DataState["orderEvents"],
  workstreamId: string,
  event: HubEvent,
): DataState["orderEvents"] => {
  const next = { ...rings, [workstreamId]: pushCapped(rings[workstreamId] ?? [], event, ORDER_EVENTS) };
  const keys = Object.keys(next);
  if (keys.length <= ORDERS_WITH_EVENTS) return next;
  const lastSeq = (k: string) => next[k]?.at(-1)?.seq ?? 0;
  const oldest = keys.reduce((a, b) => (lastSeq(b) < lastSeq(a) ? b : a));
  return Object.fromEntries(Object.entries(next).filter(([k]) => k !== oldest));
};

/**
 * One hub event: kept for the event lines, and patched straight into the entities it changes, so what counts open
 * asks or shows an order's state is right at once. The refetches it triggers (see `effectsOf`) then bring the rest.
 */
export const applyEvent = (s: DataState, event: HubEvent): DataState => {
  if (s.cursor !== undefined && event.seq <= s.cursor) return s;
  const workstreamId = dataField(event, "workstreamId");
  let next: DataState = {
    ...s,
    cursor: event.seq,
    events: pushCapped(s.events, event, RECENT_EVENTS),
    // Every order the event names: a lead woken for several orders lists them in data.workstreamIds.
    orderEvents: ordersNamed(event).reduce((rings, id) => withOrderEvent(rings, id, event), s.orderEvents),
  };
  switch (event.type) {
    case "workstream.state": {
      const state = dataField(event, "state");
      if (state !== undefined) next = patchOrder(next, workstreamId, { state: state as OrderCard["state"] });
      break;
    }
    case "workstream.done":
      next = patchOrder(next, workstreamId, { state: "done" });
      break;
    case "machine.online":
    case "machine.offline":
    case "machine.degraded": {
      const id = event.machineId;
      const machine = id === undefined ? undefined : next.machines[id];
      if (id !== undefined && machine !== undefined) {
        const status = event.type === "machine.online" ? "online" : event.type === "machine.offline" ? "offline" : "degraded";
        next = { ...next, machines: { ...next.machines, [id]: { ...machine, status } } };
      }
      break;
    }
    default:
      break;
  }
  return applyChatEvent(next, event);
};

/**
 * One live frame. A full frame replaces every lane (lanes it leaves out are gone); a delta upserts the lanes that
 * changed, keeping a lane's sparkline when the frame omits it (absent means unchanged) but not its activity
 * (absent means nothing to say). The clock skew is the largest `at - received` since the last full frame: every
 * frame is late by its trip, so the largest is the closest to the true offset and elapsed times never run back.
 */
export const applyLive = (live: LiveState, frame: LiveFrame, nowMs: number): LiveState => {
  const at = Date.parse(frame.at);
  const seen = Number.isNaN(at) ? undefined : at - nowMs;
  const skewMs =
    seen === undefined ? live.skewMs : !frame.full && live.skewMs !== undefined ? Math.max(live.skewMs, seen) : seen;
  // A delta that names no lane (streamed text, a machine) leaves the lanes as they were, identity included, so
  // nothing that reads only lanes recomputes.
  const keepLanes = !frame.full && frame.lanes.length === 0;
  const lanes: Record<string, LiveLane> = keepLanes ? live.lanes : frame.full ? {} : { ...live.lanes };
  if (!keepLanes) {
    for (const lane of frame.lanes) {
      const spark = lane.spark ?? live.lanes[lane.laneId]?.spark;
      lanes[lane.laneId] = spark === undefined ? lane : { ...lane, spark };
    }
  }
  // Kept for lanes still in scope; a lane's first finished frame sets it. Unchanged entries keep the old object.
  let ended = live.ended;
  if (!keepLanes) {
    const next: Record<string, string> = {};
    for (const [id, lane] of Object.entries(lanes)) {
      const at = live.ended[id] ?? (settled(lane.status) ? frame.at : undefined);
      if (at !== undefined) next[id] = at;
    }
    const was = Object.keys(live.ended);
    const same = was.length === Object.keys(next).length && was.every((id) => next[id] === live.ended[id]);
    if (!same) ended = next;
  }
  const text: Record<string, { messageId: string; text: string }> = frame.full ? {} : { ...live.text };
  for (const t of frame.text ?? []) {
    const prev = text[t.laneId];
    const base = prev !== undefined && prev.messageId === t.messageId ? prev.text : "";
    text[t.laneId] = { messageId: t.messageId, text: tail(base + t.append, TEXT_TAIL) };
  }
  return {
    lanes,
    ended,
    text,
    machines: frame.machines === undefined ? live.machines : byId(frame.machines, (m) => m.machineId),
    slots: frame.slots ?? live.slots,
    skewMs,
    stale: false,
  };
};

type Ingest = {
  [T in ToolName]: { readonly tool: T; readonly input: ToolInput<T>; readonly output: ToolOutput<T> };
}[ToolName];


/**
 * cap_set's answer: the hub's slot state with the new cap or max agents, applied at once. It replaces the live
 * frame's copy too, which would otherwise keep showing the old value until the next frame (none comes without a
 * live scope, as in Settings).
 */
export const applySlots = (s: DataState, slots: SlotState): DataState => ({
  ...s,
  slots,
  live: s.live.slots === undefined ? s.live : { ...s.live, slots },
});

/** A call's result, folded into the entities it covers. Tools the store doesn't hold stay in the query cache. */
export const ingest = (s: DataState, call: Ingest): DataState => {
  switch (call.tool) {
    case "orders_board": {
      const scope = call.input.projectRef;
      const kept = Object.values(s.orders ?? {}).filter(
        (o) => scope !== undefined && projectKey(o.projectRef) !== projectKey(scope),
      );
      const trains = { ...s.trains, ...byId(call.output.trains, (t) => t.repo) };
      return { ...s, orders: byId([...kept, ...call.output.orders], (o) => o.workstreamId), trains };
    }
    case "order_get": {
      const { order, lead, doneLanes, claims } = call.output;
      const id = order.workstreamId;
      return {
        ...s,
        orders: s.orders === undefined ? undefined : { ...s.orders, [id]: order },
        details: { ...s.details, [id]: { lead, doneLanes, claims: claims ?? [] } },
      };
    }
    case "agents_list":
      // Whole-fleet reads only: a project's own list would drop every other project's agents.
      return call.input.projectRef === undefined ? { ...s, agents: call.output.agents } : s;
    default:
      return s;
  }
};

export const createDataStore = () => createStore<DataState>()(initialState);
export type DataStore = ReturnType<typeof createDataStore>;
