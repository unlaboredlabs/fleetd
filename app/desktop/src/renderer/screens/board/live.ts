// What the board derives from the data layer's view of live work (src/data, selectBoardData): every lane an order
// has had, each machine's running agents and the slots they hold, and whether anything changes with time alone.
// Pure; the data layer owns the hub data.
import { type BoardData, type OrderView, selectBoardData } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import { projectKey as key, type ProjectKey as Key } from "../../src/data/store";
import type { AgentLane, LiveLane, MachineLive, SlotState, TrainLive } from "./contracts";
import { parseMs } from "./format";
import { isFinal, isRunning } from "./words";

export type ProjectKey = Key;
export const projectKey = key;

/** How long a finished lane shows its check before it leaves, and a merged PR stays on the train strip. */
export const DONE_HOLD_MS = 8_000;
export const MERGED_HOLD_MS = 10_000;
/** The fade-and-collapse of a leaving row; matches --dur-base. */
export const EXIT_MS = 180;

export const hubNow = (d: BoardData, localNowMs: number): number => localNowMs + d.skewMs;

/**
 * Every lane the order has had: its card's lanes (at work, live), then the finished ones its detail lists (order_get,
 * with their end times), which the card leaves out.
 */
export const seenLanes = (d: BoardData, order: OrderView): AgentLane[] => {
  const ids = new Set(order.lanes.map((l) => l.laneId));
  const done = (d.details[order.card.workstreamId]?.doneLanes ?? []).filter((l) => !ids.has(l.laneId));
  return [...order.lanes, ...done];
};

const agentsAtWork = (d: BoardData): AgentLane[] =>
  (d.orders ?? []).flatMap((o) => o.lanes).filter((l) => l.role !== "lead" && isRunning(l.status) && l.threadRef !== undefined);

/**
 * Each machine with its "running" counted from the lanes the board draws (agents at work there, not the leads), so
 * the strip and the rows never disagree. Undefined until the machines loaded: a skeleton, not an empty strip.
 */
export const machinesNow = (d: BoardData): MachineLive[] | undefined => {
  if (d.machines === undefined) return undefined;
  const by = new Map<string, number>();
  for (const l of agentsAtWork(d)) if (l.threadRef) by.set(l.threadRef.machineId, (by.get(l.threadRef.machineId) ?? 0) + 1);
  return d.machines.map(({ machine, live }) => ({
    ...(live ?? { asOf: machine.lastSeenAt }),
    machineId: machine.machineId,
    name: machine.name,
    status: machine.status,
    running: by.get(machine.machineId) ?? 0,
  }));
};

export interface SlotUse {
  /** Agents at work, counted exactly as each machine's "running". */
  readonly agents: number;
  /** Project leads in a turn: they hold slots too, and are said apart. */
  readonly leads: number;
  /** Agents drawn as queued. */
  readonly queued: number;
}

/** Slot use from the lanes the board draws; the hub's `slots.used` counts turns the board doesn't draw. */
export const slotUse = (d: BoardData): SlotUse => {
  const lanes = (d.orders ?? []).flatMap((o) => o.lanes);
  let leads = 0;
  for (const [id, l] of Object.entries(d.liveLanes)) if (id.startsWith("lead:") && (l.status === "working" || l.status === "starting")) leads++;
  return { agents: agentsAtWork(d).length, leads, queued: lanes.filter((l) => l.role !== "lead" && l.status === "queued").length };
};

/**
 * Whether anything on the board changes with time alone at `hubNowMs`: a lane's clock running, or a finished lane
 * holding its check. When nothing does, the board's clock stops.
 */
export const needsClock = (d: BoardData, hubNowMs: number): boolean =>
  (d.orders ?? []).some((o) =>
    seenLanes(d, o).some((l) => {
      if (isRunning(l.status) && l.startedAt !== undefined) return true;
      const ended = parseMs(l.endedAt);
      return isFinal(l.status) && ended !== undefined && hubNowMs < ended + DONE_HOLD_MS + EXIT_MS;
    }),
  );

/** A project's lead as a lane, from its live values (the feed carries the lead though no card lists it). */
export const leadLane = (live: LiveLane): AgentLane => ({ laneId: live.laneId, role: "lead", title: "lead", status: live.status, live });

export { leadLaneId } from "../../src/data/selectors";

/** What the bottom strips draw: no lanes, only what the lanes add up to. */
export interface StripData {
  readonly machines: readonly MachineLive[] | undefined;
  readonly trains: readonly TrainLive[] | undefined;
  readonly slots: SlotState | undefined;
  readonly use: SlotUse;
  readonly skewMs: number;
}

const sameStrip = (a: StripData, b: StripData): boolean =>
  a.trains === b.trains &&
  a.slots === b.slots &&
  a.skewMs === b.skewMs &&
  a.use.agents === b.use.agents &&
  a.use.leads === b.use.leads &&
  a.use.queued === b.use.queued &&
  JSON.stringify(a.machines) === JSON.stringify(b.machines);

let lastStrip: StripData | undefined;

/**
 * The strips' data, the same object until something they draw changes: the strips sit under every screen, and a
 * lane's every activity change must not redraw them.
 */
export const selectStrips = (s: DataState): StripData => {
  const d = selectBoardData(s);
  const next: StripData = { machines: machinesNow(d), trains: d.trains, slots: d.slots, use: slotUse(d), skewMs: d.skewMs };
  if (lastStrip !== undefined && sameStrip(lastStrip, next)) return lastStrip;
  lastStrip = next;
  return next;
};
