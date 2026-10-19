// What the board knows about live work: board snapshots per project (orders_board) and the ephemeral live feed
// merged on top. Pure and immutable, so React re-renders only what a frame changed. Ported from the GPUI app's
// live/state.rs; E1's store takes it over (same rules) when it lands.
//
// Live frames carry only lanes that changed. A lane's live values win over its snapshot, except that a snapshot
// saying the lane ended is final: the hub stops sending a lane once it leaves the live scope, so a stale
// "working" would otherwise stick. A board card lists only active lanes; a lane that left its card and that the
// feed says settled is kept at its place for a while, so the board can show how it ended before letting it go.
import type { AgentLane, LiveFrame, LiveLane, MachineLive, OrdersBoardOutput, SlotState, TrainLive } from "./contracts";
import { parseMs } from "./format";
import { isFinal, isRunning } from "./words";

export type ProjectKey = `${string}/${string}`;
export const projectKey = (p: { readonly machineId: string; readonly projectId: string }): ProjectKey =>
  `${p.machineId}/${p.projectId}`;

interface Left {
  readonly lane: AgentLane;
  readonly at: number;
  readonly index: number;
}

export interface LiveState {
  readonly boards: ReadonlyMap<ProjectKey, OrdersBoardOutput>;
  readonly lanes: ReadonlyMap<string, LiveLane>;
  /** When the feed first said each lane settled (the frame's hub time). */
  readonly ended: ReadonlyMap<string, string>;
  /** Lanes that left their board card, per order. */
  readonly left: ReadonlyMap<string, readonly Left[]>;
  /** When each PR chip was first seen merged (hub ms); 0 for merges already there when its board first loaded. */
  readonly mergedAt: ReadonlyMap<string, number>;
  /** Every lane each order on a board has listed, at its latest snapshot: the finish counts its agents from it. */
  readonly seen: ReadonlyMap<string, ReadonlyMap<string, AgentLane>>;
  readonly machines: readonly MachineLive[];
  readonly slots: SlotState | undefined;
  /** hub clock − local clock, ms: the largest `at − received` since the last full frame (the least delayed). */
  readonly skewMs: number | undefined;
  readonly stale: boolean;
}

export const EMPTY: LiveState = {
  boards: new Map(),
  lanes: new Map(),
  ended: new Map(),
  left: new Map(),
  seen: new Map(),
  mergedAt: new Map(),
  machines: [],
  slots: undefined,
  skewMs: undefined,
  stale: false,
};

/** How long a lane that left its card is remembered: past the board's hold. */
const LEFT_KEEP_MS = 60_000;

export const applyFrame = (s: LiveState, frame: LiveFrame, localNowMs: number): LiveState => {
  const at = parseMs(frame.at);
  const seen = at === undefined ? undefined : at - localNowMs;
  const skewMs = seen === undefined ? s.skewMs : !frame.full && s.skewMs !== undefined ? Math.max(s.skewMs, seen) : seen;
  const lanes = new Map(frame.full ? [] : s.lanes);
  const ended = new Map(s.ended);
  for (const lane of frame.lanes) {
    if (isFinal(lane.status) && !ended.has(lane.laneId)) ended.set(lane.laneId, frame.at);
    const spark = lane.spark ?? s.lanes.get(lane.laneId)?.spark;
    lanes.set(lane.laneId, spark ? { ...lane, spark } : lane);
  }
  return {
    ...s,
    lanes,
    ended,
    skewMs,
    stale: false,
    machines: frame.machines ?? s.machines,
    slots: frame.slots ?? s.slots,
  };
};

export const setBoard = (s: LiveState, key: ProjectKey, out: OrdersBoardOutput): LiveState => {
  const at = parseMs(out.at) ?? 0;
  const left = new Map(s.left);
  for (const card of s.boards.get(key)?.orders ?? []) {
    const now = out.orders.find((c) => c.workstreamId === card.workstreamId);
    const gone = card.lanes.flatMap((l, index) =>
      !isFinal(l.status) && !(now?.lanes.some((n) => n.laneId === l.laneId) ?? false) ? [{ lane: l, at, index }] : [],
    );
    if (gone.length > 0) left.set(card.workstreamId, [...(left.get(card.workstreamId) ?? []), ...gone]);
  }
  for (const [w, list] of left) {
    const kept = list.filter((l) => at - l.at < LEFT_KEEP_MS);
    if (kept.length === 0) left.delete(w);
    else left.set(w, kept);
  }
  const ended = new Map([...s.ended].filter(([id]) => s.lanes.has(id)));
  const seen = new Map(s.seen);
  for (const card of s.boards.get(key)?.orders ?? []) {
    if (!out.orders.some((o) => o.workstreamId === card.workstreamId)) seen.delete(card.workstreamId);
  }
  for (const card of out.orders) {
    const lanes = new Map(seen.get(card.workstreamId));
    for (const l of card.lanes) lanes.set(l.laneId, l);
    seen.set(card.workstreamId, lanes);
  }
  const mergedAt = new Map(s.mergedAt);
  const firstLoad = !s.boards.has(key);
  for (const chip of out.trains.flatMap((t) => t.chips)) {
    if (chip.state === "merged" && !mergedAt.has(chip.changeId)) mergedAt.set(chip.changeId, firstLoad ? 0 : at);
  }
  const boards = new Map(s.boards);
  boards.set(key, out);
  return { ...s, boards, left, ended, seen, mergedAt };
};

export const markStale = (s: LiveState): LiveState => (s.stale ? s : { ...s, stale: true });

/** `ended`: when the feed first said the lane settled; it stops the lane's clock until the snapshot says when. */
const merge = (snapshot: AgentLane, live: LiveLane | undefined, ended: string | undefined): AgentLane => {
  if (!live || isFinal(snapshot.status)) return snapshot;
  const spark = live.spark ?? snapshot.live?.spark;
  const endedAt = isFinal(live.status) && snapshot.endedAt === undefined ? ended : snapshot.endedAt;
  return {
    ...snapshot,
    status: live.status,
    ...(endedAt === undefined ? {} : { endedAt }),
    live: spark ? { ...live, spark } : live,
  };
};

/** The order's lanes with live values merged in, the lanes that left the card and settled back at their place. */
export const orderLanes = (s: LiveState, workstreamId: string): AgentLane[] => {
  let card;
  for (const b of s.boards.values()) {
    card = b.orders.find((o) => o.workstreamId === workstreamId);
    if (card) break;
  }
  const lanes: AgentLane[] = [...(card?.lanes ?? [])];
  for (const { lane, index } of s.left.get(workstreamId) ?? []) {
    const live = s.lanes.get(lane.laneId);
    if (!lanes.some((c) => c.laneId === lane.laneId) && live && isFinal(live.status)) {
      lanes.splice(Math.min(index, lanes.length), 0, lane);
    }
  }
  return lanes.map((l) => merge(l, s.lanes.get(l.laneId), s.ended.get(l.laneId)));
};

/** Every lane the order has had, finished ones included: its lanes now, then the ones that left, at their latest. */
export const seenLanes = (s: LiveState, workstreamId: string): AgentLane[] => {
  const now = orderLanes(s, workstreamId);
  const ids = new Set(now.map((l) => l.laneId));
  const old = [...(s.seen.get(workstreamId)?.values() ?? [])].filter((l) => !ids.has(l.laneId));
  return [...now, ...old.map((l) => merge(l, s.lanes.get(l.laneId), s.ended.get(l.laneId)))];
};

/** One train per repo: projects sharing a repo report the same train; the most recent snapshot wins. */
export const trains = (s: LiveState): TrainLive[] => {
  const byRepo = new Map<string, TrainLive>();
  for (const b of [...s.boards.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    for (const t of b.trains) byRepo.set(t.repo, t);
  }
  return [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
};

/**
 * Each machine's "running" from the same lanes the board draws (agents at work there, not the leads), so the strip
 * and the lanes never disagree. Until the boards load, a machine keeps what its node reported.
 */
export const machines = (s: LiveState): MachineLive[] => {
  if (s.boards.size === 0) return [...s.machines];
  const by = new Map<string, number>();
  for (const b of s.boards.values()) {
    for (const o of b.orders) {
      for (const l of orderLanes(s, o.workstreamId)) {
        if (l.role !== "lead" && isRunning(l.status) && l.threadRef) {
          by.set(l.threadRef.machineId, (by.get(l.threadRef.machineId) ?? 0) + 1);
        }
      }
    }
  }
  return s.machines.map((m) => ({ ...m, running: by.get(m.machineId) ?? 0 }));
};

/** How long a finished lane shows its check before it leaves, and a merged PR stays on the train strip. */
export const DONE_HOLD_MS = 8_000;
export const MERGED_HOLD_MS = 10_000;
/** The fade-and-collapse of a leaving row; matches --dur-base. */
export const EXIT_MS = 180;

/**
 * Whether anything on the board changes with time alone at `hubNowMs`: a lane's clock running, a finished lane
 * holding its check, a merged chip waiting to leave. When nothing does, the board's clock stops.
 */
export const needsClock = (s: LiveState, hubNowMs: number): boolean => {
  for (const b of s.boards.values()) {
    for (const o of b.orders) {
      for (const l of orderLanes(s, o.workstreamId)) {
        if (isRunning(l.status) && l.startedAt !== undefined) return true;
        const ended = parseMs(l.endedAt);
        if (isFinal(l.status) && ended !== undefined && hubNowMs < ended + DONE_HOLD_MS + EXIT_MS) return true;
      }
    }
  }
  for (const at of s.mergedAt.values()) if (hubNowMs < at + MERGED_HOLD_MS + EXIT_MS) return true;
  return false;
};

export const hubNow = (s: LiveState, localNowMs: number): number => localNowMs + (s.skewMs ?? 0);

/** The lane id of a project's lead (live.rs lead_lane_id), cut to the contract's 80 characters. */
export const leadLaneId = (p: { readonly machineId: string; readonly projectId: string }): string =>
  `lead:${p.machineId}/${p.projectId}`.slice(0, 80);

/** A project's lead as a lane, from its live values (the board feed carries the lead though no card lists it). */
export const leadLane = (live: LiveLane): AgentLane => ({
  laneId: live.laneId,
  role: "lead",
  title: "lead",
  status: live.status,
  live,
});
