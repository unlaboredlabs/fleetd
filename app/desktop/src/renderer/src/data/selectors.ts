// What the screens read. Everything that can go stale is derived here from the entities the store holds now: an
// order's phase and "needs you" come from its open asks and its lanes' live statuses, never from a count the board
// cached when it was fetched.
//
// Every selector of hub data is undefined while the connection is not fresh (a skeleton, never the last connection's
// data shown as live) and until the reads it depends on loaded.
//
// Selectors are memoized on the slices they read, so a component re-renders only when its inputs changed, and
// useSyncExternalStore sees a stable value between changes.
import type { AgentLane, Ask, Batch, LiveLane, Machine, MachineLive, OrderCard, TrainLive } from "../../../shared/contracts";
import { orderPhase, PHASE_RANK, settled, type Phase } from "./phase";
import type { DataState, OrderDetail } from "./store";

/** Recomputes only when one of `inputs(state)` changed (by identity). */
const memo = <const I extends unknown[], R>(inputs: (s: DataState) => I, compute: (...args: NoInfer<I>) => R) => {
  let last: { args: I; result: R } | undefined;
  return (s: DataState): R => {
    const args = inputs(s);
    if (last?.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) return last.result;
    const result = compute(...args);
    last = { args, result };
    return result;
  };
};

/** One selector per key (an order id, a lane id), each memoized on its own. */
const perKey = <R>(make: (key: string) => (s: DataState) => R) => {
  const cache = new Map<string, (s: DataState) => R>();
  return (key: string): ((s: DataState) => R) => {
    let selector = cache.get(key);
    if (selector === undefined) {
      selector = make(key);
      cache.set(key, selector);
    }
    return selector;
  };
};

// Connection.

export type ConnectionView =
  | { readonly view: "unpaired" }
  | { readonly view: "refused"; readonly message: string }
  /** Connecting, retrying, or connected but not yet resynced: show skeletons, not the last data. */
  | {
      readonly view: "skeleton";
      readonly hub: string;
      readonly reason?: string | undefined;
      readonly retryAt?: number | undefined;
    }
  | { readonly view: "live"; readonly hub: string };

export const selectConnection = memo(
  (s) => [s.hub, s.fresh],
  (hub, fresh): ConnectionView => {
    switch (hub.phase) {
      case "unpaired":
        return { view: "unpaired" };
      case "refused":
        return { view: "refused", message: hub.message };
      case "retrying":
        return { view: "skeleton", hub: hub.hub, reason: hub.reason, retryAt: hub.retryAt };
      case "connecting":
        return { view: "skeleton", hub: hub.hub };
      case "live":
        return fresh ? { view: "live", hub: hub.hub } : { view: "skeleton", hub: hub.hub };
    }
  },
);

// Asks.

const isOpen = (a: Ask): boolean => a.state === "open";

/** Open asks per order, recounted from the asks the store holds now. */
export const selectOpenAsksByOrder = memo(
  (s) => [s.asks],
  (asks): Readonly<Record<string, readonly Ask[]>> => {
    const out: Record<string, Ask[]> = {};
    for (const ask of Object.values(asks ?? {})) {
      if (!isOpen(ask) || ask.workstreamId === undefined) continue;
      (out[ask.workstreamId] ??= []).push(ask);
    }
    return out;
  },
);

export interface InboxItem {
  readonly ask: Ask;
  readonly batch?: Batch | undefined;
}

/** Open asks, newest batch first, then by number; undefined until this connection's asks have loaded. */
export const selectInbox = memo(
  (s) => [s.fresh, s.asks, s.batches],
  (fresh, asks, batches): readonly InboxItem[] | undefined => {
    if (!fresh || asks === undefined) return undefined;
    const items = Object.values(asks)
      .filter(isOpen)
      .map((ask) => ({ ask, batch: ask.batchId === undefined ? undefined : batches[ask.batchId] }))
      .filter((i) => i.batch?.state !== "closed");
    return items.sort(
      (a, b) =>
        (b.batch?.createdAt ?? "").localeCompare(a.batch?.createdAt ?? "") ||
        (a.ask.number ?? 0) - (b.ask.number ?? 0) ||
        a.ask.createdAt.localeCompare(b.ask.createdAt),
    );
  },
);

/** Undefined until the asks loaded: "0" would claim nothing needs you before anything was asked. */
export const selectNeedsYouCount = memo(
  (s) => [selectInbox(s)],
  (inbox): number | undefined => inbox?.length,
);

// Lanes and orders.

/** The lane id of a project's lead, as the hub cuts it (80 UTF-16 units, whole characters). */
export const leadLaneId = (r: { readonly machineId: string; readonly projectId: string }): string => {
  let id = `lead:${r.machineId}/${r.projectId}`;
  while (id.length > 80) id = Array.from(id).slice(0, -1).join("");
  return id;
};

/** A lane with its live values merged in. A finished lane keeps its own; the feed says no more about it. */
export const mergeLane = (lane: AgentLane, live: LiveLane | undefined): AgentLane => {
  if (live === undefined || settled(lane.status)) return lane;
  const spark = live.spark ?? lane.live?.spark;
  return { ...lane, status: live.status, live: spark === undefined ? live : { ...live, spark } };
};

export interface OrderView {
  readonly card: OrderCard;
  readonly phase: Phase;
  /** Open asks about this order, now. */
  readonly asks: readonly Ask[];
  /** The card's lanes (active ones), live. */
  readonly lanes: readonly AgentLane[];
}

const orderView = (
  card: OrderCard,
  openAsks: readonly Ask[],
  liveLanes: Readonly<Record<string, LiveLane>>,
  detail: OrderDetail | undefined,
): OrderView => {
  const lanes = card.lanes.map((l) => mergeLane(l, liveLanes[l.laneId]));
  const lead = liveLanes[leadLaneId(card.projectRef)];
  // Without a live lead lane, trust the hub's word that the lead is planning.
  const leadWorking =
    lead === undefined ? card.phase === "planning" : lead.status === "working" || lead.status === "starting";
  const phase = orderPhase({
    state: card.state,
    headline: card.next,
    openAsks: openAsks.length,
    lanes: [...lanes, ...(detail?.doneLanes ?? [])],
    hasTasks: card.total > 0,
    prs: card.prs,
    leadWorking,
  });
  return { card, phase, asks: openAsks, lanes };
};

const noAsks: readonly Ask[] = [];

/** The board: every order with its live phase, by phase then most recently updated; undefined until loaded. */
export const selectBoard = memo(
  (s) => [s.fresh, s.orders, s.asks !== undefined, selectOpenAsksByOrder(s), s.live.lanes, s.details],
  (fresh, orders, asksLoaded, asks, liveLanes, details): readonly OrderView[] | undefined => {
    // Phases count open asks, so the board waits for them too.
    if (!fresh || orders === undefined || !asksLoaded) return undefined;
    return Object.values(orders)
      .map((card) =>
        orderView(card, asks[card.workstreamId] ?? noAsks, liveLanes, details[card.workstreamId]),
      )
      .sort(
        (a, b) =>
          PHASE_RANK[a.phase.phase] - PHASE_RANK[b.phase.phase] ||
          b.card.updatedAt.localeCompare(a.card.updatedAt) ||
          a.card.workstreamId.localeCompare(b.card.workstreamId),
      );
  },
);

export interface OrderPage extends OrderView {
  /** Undefined until order_get answered for this connection. */
  readonly detail?: OrderDetail | undefined;
  /** The project's lead, live. */
  readonly lead?: AgentLane | undefined;
}

/** One order for its own view: undefined until the board or its order_get loaded it. */
export const selectOrder = perKey((workstreamId) =>
  memo(
    (s) =>
      [
        s.fresh && s.asks !== undefined ? s.orders?.[workstreamId] : undefined,
        selectOpenAsksByOrder(s)[workstreamId] ?? noAsks,
        s.live.lanes,
        s.details[workstreamId],
      ],
    (card, asks, liveLanes, detail): OrderPage | undefined => {
      if (card === undefined) return undefined;
      const lead = detail?.lead === undefined ? undefined : mergeLane(detail.lead, liveLanes[detail.lead.laneId]);
      return { ...orderView(card, asks, liveLanes, detail), detail, lead };
    },
  ),
);

/** An order's latest events, oldest first. */
export const selectOrderEvents = perKey((workstreamId) => (s: DataState) => s.orderEvents[workstreamId] ?? noEvents);
const noEvents: DataState["events"] = [];

/** A lane's live values as the feed last sent them (a project lead's included, which no card lists). */
export const selectLiveLane = perKey((laneId) => (s: DataState) => s.live.lanes[laneId]);

/** A project lead's recent messages in full, as streamed, oldest first. */
export const selectLeadStream = perKey((laneId) => (s: DataState) => s.live.streams?.[laneId] ?? noStream);
const noStream: NonNullable<DataState["live"]["streams"]>[string] = [];

/** The message a lane is writing, as streamed so far. */
export const selectLiveText = perKey((laneId) => (s: DataState) => s.live.text[laneId]);

// Fleet.

export interface MachineView {
  readonly machine: Machine;
  /** Load and running agents from the live feed, when it has the machine. */
  readonly live?: MachineLive | undefined;
}

export const selectMachines = memo(
  (s) => [s.fresh, s.machines, s.live.machines],
  (fresh, machines, live): readonly MachineView[] | undefined =>
    !fresh
      ? undefined
      : Object.values(machines)
      .map((machine) => {
        const now = live[machine.machineId];
        // The feed's status is newer than the snapshot's when it has one.
        return { machine: now === undefined ? machine : { ...machine, status: now.status }, live: now };
      })
      .sort((a, b) => a.machine.name.localeCompare(b.machine.name)),
);

export const selectTrains = memo(
  (s) => [s.fresh && s.orders !== undefined, s.trains],
  (loaded, trains): readonly TrainLive[] | undefined =>
    loaded ? Object.values(trains).sort((a, b) => a.repo.localeCompare(b.repo)) : undefined,
);

export const selectProjects = memo(
  (s) => [s.fresh, s.projects],
  (fresh, projects) => (fresh ? Object.values(projects).sort((a, b) => a.title.localeCompare(b.title)) : undefined),
);

/** The hub's clock now, from the live feed's skew. */
export const hubNow = (s: DataState, localNowMs: number): number => localNowMs + (s.live.skewMs ?? 0);
