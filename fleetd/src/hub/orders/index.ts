// The orders board: open workstreams joined with their agents (tasks and the project's lead), PRs, open requests and
// the trains of their repos, for the app's board and order view. Reads the
// existing stores; owns no table.
import type {
  Change,
  OrderCard,
  ProjectRef,
  ThreadRef,
  TrainLive,
  Workstream,
  WorkstreamId,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { executors, peek } from "../executor/index.ts";
import { profiles } from "../projects/profiles.ts";
import { isoMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { sortCards } from "./phase.ts";
import { hasTrain, leadGet, leadProfile, openRequests, trainChanges } from "./sources.ts";
import {
  BOARD_ORDERS,
  BOARD_TRAINS,
  card,
  type Joined,
  type Lookups,
  model,
  trainLive,
} from "./cards.ts";
import { workstreamsList } from "./workstreams.ts";

export {
  BOARD_ORDERS,
  BOARD_TRAINS,
  card,
  CARD_LANES,
  CARD_PRS,
  DONE_LANES,
  type Joined,
  leadLane,
  leadLaneId,
  liveLane,
  type Lookups,
  type OrderParts,
  parkedReason,
  prRef,
  shortTitle,
  taskLane,
  TITLE_CHARS,
  trainLive,
} from "./cards.ts";

/** Tasks read per order: far above what one order spawns. */
const ORDER_TASKS = 200;
/** Changes read per project to find its orders' PRs. */
const PROJECT_CHANGES = 200;

/** The executor's activity (T2253's `hub.area("activity")`), once its area exists. */
type ActivityLive = { live(r: ThreadRef): ReturnType<Lookups["live"]> };

export function lookups(hub: Hub): Lookups {
  return {
    thread: (r) => {
      const s = executors(hub).tracked(r)?.summary;
      return s ? { status: s.status, ...(s.model !== undefined ? { model: s.model } : {}), ...(s.effort !== undefined ? { effort: s.effort } : {}) } : undefined;
    },
    live: (r) => peek<ActivityLive>(hub, "activity")?.live(r),
    leadProfile: (r) => {
      const name = leadProfile(hub, r);
      if (name !== undefined) return name;
      try {
        return profiles(hub).defaultProfile().name;
      } catch {
        return undefined;
      }
    },
  };
}

/** The open orders the caller may read (and those done since `doneSince`), newest first. */
export function ordersInScope(hub: Hub, caller: Caller, project: ProjectRef | undefined, doneSince: string | undefined): Workstream[] {
  const out = workstreamsList(hub.db.conn, { ...(project ? { projectRef: project } : {}), state: "open", limit: 500 });
  if (doneSince !== undefined) {
    out.push(
      ...workstreamsList(hub.db.conn, { ...(project ? { projectRef: project } : {}), state: "done", limit: 100 }).filter((w) => w.updatedAt >= doneSince),
    );
  }
  return out.filter((w) => allows(caller, "read", w.projectRef.machineId));
}

export const orderTasks = (hub: Hub, id: WorkstreamId) => TaskRecords.list(hub.db.conn, { workstreamId: id, limit: ORDER_TASKS });

/** Every open secret or approval request, counted per workstream. */
export function openRequestsByOrder(hub: Hub): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of openRequests(hub, 500)) if (r.workstreamId !== undefined) out.set(r.workstreamId, (out.get(r.workstreamId) ?? 0) + 1);
  return out;
}

export const projectChanges = (hub: Hub, project: ProjectRef) => trainChanges(hub, { projectRef: project, limit: PROJECT_CHANGES });

const leadWorking = (hub: Hub, project: ProjectRef) => leadGet(hub, project)?.state === "working";

/** One order joined, for the board or order_get. */
export function join(hub: Hub, w: Workstream, changes: Change[], requests: number): Joined {
  return card(
    {
      workstream: w,
      tasks: orderTasks(hub, w.workstreamId),
      changes: changes.filter((c) => c.workstreamId === w.workstreamId),
      openRequests: requests,
      leadWorking: leadWorking(hub, w.projectRef),
    },
    lookups(hub),
  );
}

/** Cards for these orders, sorted for the board, and the trains of their repos. */
export function board(hub: Hub, orders: Workstream[]): { cards: OrderCard[]; trains: TrainLive[]; truncated: boolean } {
  const requests = openRequestsByOrder(hub);
  const changes = new Map<string, Change[]>();
  const keyOf = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;
  const cards: OrderCard[] = [];
  let truncated = orders.length > BOARD_ORDERS;
  for (const w of orders.slice(0, BOARD_ORDERS)) {
    const k = keyOf(w.projectRef);
    if (!changes.has(k)) changes.set(k, projectChanges(hub, w.projectRef));
    const joined = join(hub, w, changes.get(k) ?? [], requests.get(w.workstreamId) ?? 0);
    truncated ||= joined.truncated;
    cards.push(joined.card);
  }
  sortCards(cards);
  return { cards, trains: trains(hub, [...changes.values()].flat()), truncated };
}

function trains(hub: Hub, changes: Change[]): TrainLive[] {
  const today = `${isoMs(hub.clock.now()).slice(0, 10)}T00:00:00.000Z`;
  const repos = [...new Set(changes.map((c) => c.repo.toLowerCase()))].sort();
  const out: TrainLive[] = [];
  for (const repo of repos) {
    if (!hasTrain(hub, repo)) continue;
    const ofRepo = changes.filter((c) => c.repo.toLowerCase() === repo);
    const name = ofRepo[0]?.repo;
    if (name === undefined) continue;
    const train = trainLive(name, ofRepo, today);
    if (train.chips.length > 0) out.push(train);
    if (out.length === BOARD_TRAINS) break;
  }
  return out;
}
