// What the screens read. Everything that can go stale is derived here from the entities the store holds now: an
// order's phase comes from its lanes' live statuses and a project's needs-you from the hub's chat state, never from a count the board
// cached when it was fetched.
//
// Every selector of hub data is undefined while the connection is not fresh (a skeleton, never the last connection's
// data shown as live) and until the reads it depends on loaded. The exceptions are the sidebar's projects and the
// chats (selectShownProjects, selectChat): they keep what was last seen on screen, and say since when.
//
// Selectors are memoized on the slices they read, so a component re-renders only when its inputs changed, and
// useSyncExternalStore sees a stable value between changes.
import type { AgentLane, LiveLane, Machine, MachineLive, OrderCard, ProjectSummary, TrainLive } from "../../../shared/contracts";
import type { AgentRow } from "./agents-contract";
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
export const mergeLane = <L extends AgentLane>(lane: L, live: LiveLane | undefined, endedAt?: string): L => {
  if (live === undefined || settled(lane.status)) return lane;
  const spark = live.spark ?? lane.live?.spark;
  const ended = settled(live.status) && lane.endedAt === undefined && endedAt !== undefined ? { endedAt } : {};
  return { ...lane, status: live.status, ...ended, live: spark === undefined ? live : { ...live, spark } };
};

export interface OrderView {
  readonly card: OrderCard;
  readonly phase: Phase;
  /** The card's lanes (active ones), live. */
  readonly lanes: readonly AgentLane[];
}

const orderView = (
  card: OrderCard,
  liveLanes: Readonly<Record<string, LiveLane>>,
  detail: OrderDetail | undefined,
  ended: Readonly<Record<string, string>> = {},
): OrderView => {
  const lanes = card.lanes.map((l) => mergeLane(l, liveLanes[l.laneId], ended[l.laneId]));
  const lead = liveLanes[leadLaneId(card.projectRef)];
  // Without a live lead lane, trust the hub's word that the lead is planning.
  const leadWorking =
    lead === undefined ? card.phase === "planning" : lead.status === "working" || lead.status === "starting";
  const phase = orderPhase({
    state: card.state,
    headline: card.next,
    // The hub's count of what waits on you for this order (its requests), refetched on every order event.
    openAsks: card.needsYou,
    lanes: [...lanes, ...(detail?.doneLanes ?? [])],
    hasTasks: card.total > 0,
    prs: card.prs,
    leadWorking,
  });
  return { card, phase, lanes };
};


/** The board: every order with its live phase, by phase then most recently updated; undefined until loaded. */
export const selectBoard = memo(
  (s) => [s.fresh, s.orders, s.live.lanes, s.details, s.live.ended],
  (fresh, orders, liveLanes, details, ended): readonly OrderView[] | undefined => {
    if (!fresh || orders === undefined) return undefined;
    return Object.values(orders)
      .map((card) =>
        orderView(card, liveLanes, details[card.workstreamId], ended),
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
        s.fresh ? s.orders?.[workstreamId] : undefined,
        s.live.lanes,
        s.details[workstreamId],
      ],
    (card, liveLanes, detail): OrderPage | undefined => {
      if (card === undefined) return undefined;
      const lead = detail?.lead === undefined ? undefined : mergeLane(detail.lead, liveLanes[detail.lead.laneId]);
      return { ...orderView(card, liveLanes, detail), detail, lead };
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
    // A lane two cards list is one agent, counted once.
    const seen = new Set<string>();
    for (const card of Object.values(orders)) {
      const lanes = card.lanes.filter((l) => !seen.has(l.laneId)).map((l) => mergeLane(l, liveLanes[l.laneId], ended[l.laneId]));
      for (const l of lanes) seen.add(l.laneId);
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
  /** The chat's newest message seq, when the hub has its chat state: the sidebar's unread mark. */
  readonly lastSeq?: number | undefined;
}

const leadActive = (lanes: DataState["live"]["lanes"], key: ProjectKey): boolean => {
  const at = key.indexOf("/");
  const lead = lanes[leadLaneId({ machineId: key.slice(0, at), projectId: key.slice(at + 1) })];
  return lead !== undefined && active(lead.status);
};

/** The sidebar's and status's projects, by title; undefined until loaded. */
const sameRow = (a: ProjectRow, b: ProjectRow): boolean =>
  a.project === b.project && a.needsYou === b.needsYou && a.running === b.running && a.working === b.working && a.state === b.state && a.lastSeq === b.lastSeq;

// The rows last handed out: a lane frame (4 Hz on the strip) that changes no row's fields hands back the same rows
// and the same list, so the sidebar and the chat header don't re-render for it.
let lastRows: readonly ProjectRow[] | undefined;
/** The last rows of a fresh connection, for the moment after a reconnect before the board is read again. */
let lastLive: ReadonlyMap<ProjectKey, ProjectRow> = new Map();

export const selectProjectList = memo(
  (s) => [s.fresh, s.projects, s.chatStates, selectAgentsByProject(s), s.live.lanes],
  (fresh, projects, chats, agents, liveLanes): readonly ProjectRow[] | undefined => {
    if (!fresh || agents === undefined) return (lastRows = undefined);
    const before = new Map((lastRows ?? []).map((r) => [r.key, r]));
    const rows = Object.entries(projects)
      .map(([key, project]): ProjectRow => {
        const running = (agents[key] ?? noProjectLanes).filter((l) => l.role !== "lead" && active(l.status)).length;
        const chat = chats[key];
        const leadWorking = chat?.leadWorking ?? leadActive(liveLanes, key);
        const needsYou = chat?.needsYou === true;
        const working = running > 0 || leadWorking;
        const row = { key, project, needsYou, running, working, state: projectStateWord(needsYou, working), lastSeq: chat?.lastSeq };
        const prior = before.get(key);
        return prior !== undefined && sameRow(prior, row) ? prior : row;
      })
      // A stable order (by title): rows must not move under the pointer, and ⌘1–9 keep their targets.
      .sort((a, b) => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
    const unchanged = lastRows?.length === rows.length && rows.every((r, i) => r === lastRows?.[i]);
    if (!unchanged) {
      lastRows = rows;
      lastLive = new Map(rows.map((r) => [r.key, r]));
    }
    return lastRows;
  },
);

/**
 * The sidebar's projects: the live rows, else the projects held from before (a drop, a reconnect not yet read
 * back, or the disk cache at launch). Held rows keep whether the lead waits on you and its newest message (for
 * unread); whether agents work they keep only while connected, since offline nobody knows. Undefined while nothing
 * is held.
 */
export const selectShownProjects = memo(
  (s) => [selectProjectList(s), s.fresh, s.projects, s.chatStates],
  (live, fresh, projects, chats): readonly ProjectRow[] | undefined => {
    if (live !== undefined) return live;
    const held = Object.entries(projects);
    if (held.length === 0) return undefined;
    return held
      .map(([key, project]): ProjectRow => {
        const needsYou = chats[key]?.needsYou === true;
        const before = fresh ? lastLive.get(key) : undefined;
        const running = before?.running ?? 0;
        const working = before?.working ?? false;
        return { key, project, needsYou, running, working, state: projectStateWord(needsYou, working), lastSeq: chats[key]?.lastSeq };
      })
      .sort((a, b) => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key));
  },
);

/** When what is held was last current, while there is no fresh connection; undefined when live or nothing is held. */
export const selectOfflineAsOf = (s: DataState): number | undefined => (s.fresh ? undefined : s.asOf);

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

/** Offline, the lead was working when last known: Stop shows, disabled, with why. */
export const selectHeldLeadWorking = perKey((key) => (s: DataState): boolean => !s.fresh && s.chatStates[key]?.leadWorking === true);

/** The hub can stop a lead mid-turn: false until it said so on this connection. */
export const selectCanStop = (s: DataState): boolean => s.fresh && s.chatStop === true;

export interface ChatView {
  /** Oldest first. The lead's streaming message is the last hub item; the person's unsettled sends follow it. */
  readonly items: readonly ChatItem[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  /** Paged above the latest (past what a chat keeps): loadNewer pages back down; live messages wait for it. */
  readonly hasNewer: boolean;
  readonly loadingNewer: boolean;
  readonly error?: HubError | undefined;
  /**
   * Shown from before this connection (a drop, a reconnect not yet read back, the disk cache): nothing pages, and it
   * is never shown as current, even once connected, until this connection's latest page lands.
   */
  readonly held: boolean;
  /** No fresh connection: nothing can be sent or answered now. */
  readonly offline: boolean;
  /** While held: when what is shown was last current. */
  readonly asOf?: number | undefined;
}

const noSends: readonly ChatSend[] = [];

/**
 * A project's chat for the message list: this connection's once its latest page loaded, else what it last showed
 * (held). Undefined while there is neither.
 */
export const selectChat = perKey((key) =>
  memo(
    (s) => [s.fresh, s.chats[key], s.chatSends[key] ?? noSends, s.asOf],
    (fresh, chat, sends, asOf): ChatView | undefined => {
      if (chat === undefined || (!chat.loaded && chat.cached !== true)) return undefined;
      const held = !fresh || !chat.loaded;
      return {
        items: chatItems(chat, sends),
        hasOlder: chat.hasOlder,
        loadingOlder: chat.loadingOlder,
        hasNewer: chat.hasNewer,
        loadingNewer: chat.loadingNewer,
        error: chat.error,
        held,
        offline: !fresh,
        asOf: held ? asOf : undefined,
      };
    },
  ),
);

// The live agents view (A2): the hub's agents_list, each row merged with the live feed (the board subscription carries
// every lane, the leads' included), and one agent's work (agent_work).

export interface LiveAgent {
  /** "machineId/projectId/laneId": the agent's route key. */
  readonly id: string;
  readonly project: ProjectKey;
  /** Live-merged. */
  readonly row: AgentRow;
}

const FINAL: ReadonlySet<AgentLane["status"]> = new Set(["done", "failed", "cancelled"]);

/** The fields an agent's row shows; a frame that changes none of them keeps the row's object. */
const sameAgent = (a: AgentRow, b: AgentRow): boolean =>
  a.projectTitle === b.projectTitle &&
  a.status === b.status &&
  a.statusReason === b.statusReason &&
  a.title === b.title &&
  a.startedAt === b.startedAt &&
  a.pr?.number === b.pr?.number &&
  JSON.stringify(a.live?.activity) === JSON.stringify(b.live?.activity);

const leadFirst = (a: AgentRow, b: AgentRow): number => Number(b.role === "lead") - Number(a.role === "lead");

let lastAgents: readonly LiveAgent[] | undefined;

/**
 * Every agent at work or waiting, across all projects; a lead only while it works or waits. Undefined until
 * agents_list answered on this connection. By project, its lead first, then oldest first: an agent never moves as
 * others start, change or finish, so the row under the pointer stays put. A lane frame that changes no row's fields
 * hands back the same list.
 */
export const selectLiveAgents = memo(
  (s) => [s.fresh, s.agents, s.live.lanes, s.live.ended],
  (fresh, agents, liveLanes, ended): readonly LiveAgent[] | undefined => {
    if (!fresh || agents === undefined) return (lastAgents = undefined);
    const before = new Map((lastAgents ?? []).map((a) => [a.id, a]));
    const out: LiveAgent[] = [];
    for (const r of agents) {
      const row = mergeLane(r, liveLanes[r.laneId], ended[r.laneId]);
      if (FINAL.has(row.status) || (row.role === "lead" && row.status === "idle")) continue;
      const project = projectKey(row.projectRef);
      const id = `${project}/${row.laneId}`;
      const prior = before.get(id);
      out.push(prior !== undefined && sameAgent(prior.row, row) ? prior : { id, project, row });
    }
    out.sort(
      (a, b) =>
        a.row.projectTitle.localeCompare(b.row.projectTitle) ||
        a.project.localeCompare(b.project) ||
        leadFirst(a.row, b.row) ||
        (a.row.startedAt ?? "\uffff").localeCompare(b.row.startedAt ?? "\uffff") ||
        a.row.laneId.localeCompare(b.row.laneId),
    );
    const unchanged = lastAgents?.length === out.length && out.every((a, i) => a === lastAgents?.[i]);
    if (!unchanged) lastAgents = out;
    return lastAgents;
  },
);

/** One agent by its route key; undefined while loading or once it finished. */
export const selectLiveAgent = perKey((id) =>
  memo(
    (s) => [selectLiveAgents(s)],
    (agents): LiveAgent | undefined => agents?.find((a) => a.id === id),
  ),
);
