// What the screens read. Everything that can go stale is derived here from the entities the store holds now: an
// order's phase and "needs you" come from its open asks and its lanes' live statuses, never from a count the board
// cached when it was fetched.
//
// Every selector of hub data is undefined while the connection is not fresh (a skeleton, never the last connection's
// data shown as live) and until the reads it depends on loaded.
//
// Selectors are memoized on the slices they read, so a component re-renders only when its inputs changed, and
// useSyncExternalStore sees a stable value between changes.
import type { AgentLane, Ask, Batch, LiveLane, Machine, MachineLive, OrderCard, ProjectSummary, TrainLive } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { chatItems, type ChatItem, type ChatSend } from "./chat";
import { orderPhase, PHASE_RANK, settled, type Phase } from "./phase";
import { projectKey, type DataState, type OrderDetail, type ProjectKey } from "./store";

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
      /** What to do about it, as main words it; may hold `code` in backticks. */
      readonly fix?: string | undefined;
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
        return { view: "skeleton", hub: hub.hub, reason: hub.reason, fix: hub.fix, retryAt: hub.retryAt };
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

/** Why the open asks couldn't be read, while they can't: the inbox shows it; the board draws without needs-you marks. */
export const selectAsksError = (s: DataState) => (s.fresh ? s.asksError : undefined);

/** Undefined until the asks loaded (or when their read failed): "0" would claim nothing needs you. */
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

/**
 * A lane with its live values merged in. A finished lane keeps its own; the feed says no more about it. `endedAt`:
 * when the feed said it finished, its end time until the hub's own arrives.
 */
export const mergeLane = (lane: AgentLane, live: LiveLane | undefined, endedAt?: string): AgentLane => {
  if (live === undefined || settled(lane.status)) return lane;
  const spark = live.spark ?? lane.live?.spark;
  const ended = settled(live.status) && lane.endedAt === undefined && endedAt !== undefined ? { endedAt } : {};
  return { ...lane, status: live.status, ...ended, live: spark === undefined ? live : { ...live, spark } };
};

export interface OrderView {
  readonly card: OrderCard;
  readonly phase: Phase;
  /** Open asks about this order, now. */
  readonly asks: readonly Ask[];
  /** False when the asks couldn't be read: `asks` is empty and the phase uses the board's cached count instead. */
  readonly asksKnown: boolean;
  /** The card's lanes (active ones), live. */
  readonly lanes: readonly AgentLane[];
}

const orderView = (
  card: OrderCard,
  openAsks: readonly Ask[],
  liveLanes: Readonly<Record<string, LiveLane>>,
  detail: OrderDetail | undefined,
  ended: Readonly<Record<string, string>> = {},
  asksKnown = true,
): OrderView => {
  const lanes = card.lanes.map((l) => mergeLane(l, liveLanes[l.laneId], ended[l.laneId]));
  const lead = liveLanes[leadLaneId(card.projectRef)];
  // Without a live lead lane, trust the hub's word that the lead is planning.
  const leadWorking =
    lead === undefined ? card.phase === "planning" : lead.status === "working" || lead.status === "starting";
  const phase = orderPhase({
    state: card.state,
    headline: card.next,
    // Asks unreadable: fall back to the hub's count from the board, so an order waiting on you still says so.
    openAsks: asksKnown ? openAsks.length : card.needsYou,
    lanes: [...lanes, ...(detail?.doneLanes ?? [])],
    hasTasks: card.total > 0,
    prs: card.prs,
    leadWorking,
  });
  return { card, phase, asks: openAsks, asksKnown, lanes };
};

const noAsks: readonly Ask[] = [];

const asksState = (s: DataState): "loading" | "loaded" | "failed" =>
  s.asks !== undefined ? "loaded" : s.asksError !== undefined ? "failed" : "loading";

/** The board: every order with its live phase, by phase then most recently updated; undefined until loaded. */
export const selectBoard = memo(
  (s) => [s.fresh, s.orders, asksState(s), selectOpenAsksByOrder(s), s.live.lanes, s.details, s.live.ended],
  (fresh, orders, asksAre, asks, liveLanes, details, ended): readonly OrderView[] | undefined => {
    // Phases count open asks, so the board waits for them, but not on a read that failed.
    if (!fresh || orders === undefined || asksAre === "loading") return undefined;
    return Object.values(orders)
      .map((card) =>
        orderView(card, asks[card.workstreamId] ?? noAsks, liveLanes, details[card.workstreamId], ended, asksAre === "loaded"),
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
        s.fresh && asksState(s) !== "loading" ? s.orders?.[workstreamId] : undefined,
        selectOpenAsksByOrder(s)[workstreamId] ?? noAsks,
        s.live.lanes,
        s.details[workstreamId],
        asksState(s) === "loaded",
      ],
    (card, asks, liveLanes, detail, asksKnown): OrderPage | undefined => {
      if (card === undefined) return undefined;
      const lead = detail?.lead === undefined ? undefined : mergeLane(detail.lead, liveLanes[detail.lead.laneId]);
      return { ...orderView(card, asks, liveLanes, detail, {}, asksKnown), detail, lead };
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

// The board (F2).
export interface BoardData {
  readonly connection: ConnectionView;
  /** Every order with its live phase and lanes; undefined until loaded. */
  readonly orders: readonly OrderView[] | undefined;
  /** order_get's details, for the agents a card leaves out (finished ones, with their end times). */
  readonly details: DataState["details"];
  /** Every lane's live values, the project leads' included (no card lists a lead). */
  readonly liveLanes: DataState["live"]["lanes"];
  readonly projects: ReturnType<typeof selectProjects>;
  readonly machines: readonly MachineView[] | undefined;
  readonly trains: readonly TrainLive[] | undefined;
  readonly slots: DataState["slots"];
  readonly skewMs: number;
  /** The live feed dropped: values stay, greyed, until the next frame. */
  readonly stale: boolean;
}

const noDetails: DataState["details"] = {};
const noLanes: DataState["live"]["lanes"] = {};

/** Everything the board and its strips draw, from one place. */
export const selectBoardData = memo(
  (s) =>
    [
      selectConnection(s),
      selectBoard(s),
      // Gated like every hub-data selector: nothing from a connection that isn't fresh.
      s.fresh ? s.details : noDetails,
      s.fresh ? s.live.lanes : noLanes,
      selectProjects(s),
      selectMachines(s),
      selectTrains(s),
      s.fresh ? (s.live.slots ?? s.slots) : undefined,
      s.live.skewMs ?? 0,
      s.live.stale,
    ],
  (connection, orders, details, liveLanes, projects, machines, trains, slots, skewMs, stale): BoardData => ({
    connection,
    orders,
    details,
    liveLanes,
    projects,
    machines,
    trains,
    slots,
    skewMs,
    stale,
  }),
);

// The lead chats (A7).

const active = (status: AgentLane["status"]): boolean => status === "working" || status === "starting";
const noProjectLanes: readonly AgentLane[] = [];

const byActiveFirst = (a: AgentLane, b: AgentLane): number =>
  Number(active(b.status)) - Number(active(a.status)) || (b.startedAt ?? "").localeCompare(a.startedAt ?? "");

/** Every project's agents, live-merged, active first; undefined until the board loaded. */
const selectAgentsByProject = memo(
  (s) => [s.fresh, s.orders, s.live.lanes, s.live.ended],
  (fresh, orders, liveLanes, ended): Readonly<Record<ProjectKey, readonly AgentLane[]>> | undefined => {
    if (!fresh || orders === undefined) return undefined;
    const out: Record<ProjectKey, AgentLane[]> = {};
    for (const card of Object.values(orders)) {
      const lanes = card.lanes.map((l) => mergeLane(l, liveLanes[l.laneId], ended[l.laneId]));
      (out[projectKey(card.projectRef)] ??= []).push(...lanes);
    }
    for (const lanes of Object.values(out)) lanes.sort(byActiveFirst);
    return out;
  },
);

/** One project's agents for the chat's live strip: live-merged, active first. */
export const selectProjectAgents = perKey((key) =>
  memo(
    (s) => [selectAgentsByProject(s)],
    (byProject): readonly AgentLane[] | undefined => (byProject === undefined ? undefined : (byProject[key] ?? noProjectLanes)),
  ),
);

/** A project's state word: the sidebar dot, the chat header and the Status row all show this one. */
export type ProjectStateWord = "waiting_on_you" | "blocked" | "working" | "idle";

/**
 * The state word. Whether the lead waits on you comes only from the hub's chat state (ProjectChatState.needsYou),
 * so no two places can disagree on it. `rowState` is the Status row's own word (status_projects): it adds
 * "blocked" (a cause outside the work) and a "working" the agents count can't see (PRs in review, CI or the
 * train), and its "waiting on you" never counts on its own.
 */
export const projectStateWord = (needsYou: boolean, working: boolean, rowState?: string): ProjectStateWord => {
  if (needsYou) return "waiting_on_you";
  if (rowState === "blocked") return "blocked";
  return working || rowState === "working" ? "working" : "idle";
};

export interface ProjectRow {
  readonly key: ProjectKey;
  readonly project: ProjectSummary;
  /** The lead is waiting for the person's reply: the hub's chat state, the one source for it. */
  readonly needsYou: boolean;
  /** The state word without the Status row's own causes; the Status screen passes its row to projectStateWord. */
  readonly state: ProjectStateWord;
  /** The lead or any of the project's agents is at work. */
  readonly working: boolean;
  /** Agents at work, the lead not counted. */
  readonly running: number;
}

const leadActive = (lanes: DataState["live"]["lanes"], key: ProjectKey): boolean => {
  const at = key.indexOf("/");
  const lead = lanes[leadLaneId({ machineId: key.slice(0, at), projectId: key.slice(at + 1) })];
  return lead !== undefined && active(lead.status);
};

/** The sidebar's and status's projects, by title; undefined until loaded. */
export const selectProjectList = memo(
  (s) => [s.fresh, s.projects, s.chatStates, selectAgentsByProject(s), s.live.lanes],
  (fresh, projects, chats, agents, liveLanes): readonly ProjectRow[] | undefined => {
    if (!fresh || agents === undefined) return undefined;
    return Object.entries(projects)
      .map(([key, project]) => {
        const running = (agents[key] ?? noProjectLanes).filter((l) => l.role !== "lead" && active(l.status)).length;
        const chat = chats[key];
        const leadWorking = chat?.leadWorking ?? leadActive(liveLanes, key);
        const needsYou = chat?.needsYou === true;
        const working = running > 0 || leadWorking;
        return { key, project, needsYou, running, working, state: projectStateWord(needsYou, working) };
      })
      // A stable order (by title): rows must not move under the pointer, and ⌘1–9 keep their targets.
      .sort((a, b) => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
  },
);

/** One project's row: what the sidebar dot, the chat header and the Status row read. */
export const selectProjectRow = perKey((key) =>
  memo(
    (s) => [selectProjectList(s)],
    (rows): ProjectRow | undefined => rows?.find((r) => r.key === key),
  ),
);

/** How many projects' leads wait on the person (dock badge, window title). */
export const selectNeedsYouTotal = memo(
  (s) => [selectProjectList(s)],
  (rows): number | undefined => rows?.filter((r) => r.needsYou).length,
);

export const selectNeedsYou = perKey((key) => (s: DataState): boolean | undefined =>
  s.fresh && key in s.projects ? s.chatStates[key]?.needsYou === true : undefined,
);

/** Whether the project's lead is at work now: typing then steers it rather than starting a turn. */
export const selectLeadWorking = perKey((key) => (s: DataState): boolean | undefined =>
  s.fresh ? (s.chatStates[key]?.leadWorking ?? leadActive(s.live.lanes, key)) : undefined,
);

export interface ChatView {
  /** Oldest first. The lead's streaming message is the last hub item; the person's unsettled sends follow it. */
  readonly items: readonly ChatItem[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Paged above the latest (past what a chat keeps): loadNewer pages back down; live messages wait for it. */
  readonly hasNewer: boolean;
  readonly loadingNewer: boolean;
  readonly error?: HubError | undefined;
}

const noSends: readonly ChatSend[] = [];

/** A project's chat for the message list; undefined until its latest page loaded on this connection. */
export const selectChat = perKey((key) =>
  memo(
    (s) => [s.fresh, s.chats[key], s.chatSends[key] ?? noSends],
    (fresh, chat, sends): ChatView | undefined => {
      if (!fresh || chat?.loaded !== true) return undefined;
      return {
        items: chatItems(chat, sends),
        hasOlder: chat.hasOlder,
        loadingOlder: chat.loadingOlder,
        hasNewer: chat.hasNewer,
        loadingNewer: chat.loadingNewer,
        error: chat.error,
      };
    },
  ),
);
