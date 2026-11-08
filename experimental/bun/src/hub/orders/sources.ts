// What the orders board, order_get and agents read of other areas (D352): leads from src/hub/leads (`leads(hub)`,
// `leadProfile`), the merge train's changes from src/hub/train (`trainChanges`, `trainOf`) and open requests from
// src/hub/approvals (`openRequests`). Each is looked up at runtime, so the board runs before those areas land; until
// one does, its rows are read here, read-only, with the Rust hub's own SQL.
import type { Change, HumanRequest, Lead, LeadState, ProjectRef, ThreadSummary } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { store } from "../store/hub_store.ts";

type LeadsArea = { get(r: ProjectRef): Lead | undefined; list(): Lead[] };
type ChangeFilter = { projectRef?: ProjectRef; repo?: string; state?: string; limit: number };
type Areas = {
  leads?: (hub: Hub) => LeadsArea;
  leadProfile?: (hub: Hub, r: ProjectRef) => string | undefined;
  trainChanges?: (hub: Hub, filter: ChangeFilter) => Change[];
  trainOf?: (hub: Hub, repo: string) => unknown;
  openRequests?: (hub: Hub, limit: number) => HumanRequest[];
};

const found: Areas = {};
const look = async (path: string, names: (keyof Areas)[]) => {
  try {
    const m = (await import(path)) as Record<string, unknown>;
    for (const name of names) if (typeof m[name] === "function") (found as Record<string, unknown>)[name] = m[name];
  } catch {}
};
// Variables, so the bundler leaves the lookups to run time and a missing module is no build error.
const LEADS = "../leads/index.ts";
const TRAIN = "../train/index.ts";
const APPROVALS = "../approvals/index.ts";
const loading = Promise.all([
  look(LEADS, ["leads", "leadProfile"]),
  look(TRAIN, ["trainChanges", "trainOf"]),
  look(APPROVALS, ["openRequests"]),
]);

/** Resolves once the areas were looked for. */
export const sourcesReady = () => loading;

/** `leads::lead::lead_state`: a lead's state from its thread. */
export function leadState(thread: ThreadSummary | undefined, projectGone: boolean): LeadState {
  if (projectGone) return "stopped";
  if (!thread) return "starting";
  if (thread.status === "running") return "working";
  if (thread.status === "waiting" || thread.status === "failed") return "stalled";
  return "idle";
}

type LeadRow = {
  machine_id: string;
  project_id: string;
  thread_id: string;
  started_at: string;
  last_wake_at: string | null;
  session_generation: number;
};

function leadOf(hub: Hub, row: LeadRow): Lead {
  const projectRef = { machineId: row.machine_id, projectId: row.project_id };
  const thread = store(hub).threadGet({ machineId: row.machine_id, threadId: row.thread_id })?.thread;
  return {
    projectRef,
    threadId: row.thread_id,
    startedAt: row.started_at,
    ...(row.last_wake_at !== null ? { lastWakeAt: row.last_wake_at } : {}),
    sessionGeneration: row.session_generation,
    state: leadState(thread, !store(hub).projectGet(projectRef)),
  };
}

const LEAD_COLUMNS = "machine_id, project_id, thread_id, started_at, last_wake_at, session_generation";

/** The project's lead, with its state. */
export function leadGet(hub: Hub, r: ProjectRef): Lead | undefined {
  if (found.leads) return found.leads(hub).get(r);
  const row = hub.db.conn
    .query<LeadRow, [string, string]>(`SELECT ${LEAD_COLUMNS} FROM leads WHERE machine_id = ? AND project_id = ?`)
    .get(r.machineId, r.projectId);
  return row ? leadOf(hub, row) : undefined;
}

/** Every project's lead. */
export function leadsList(hub: Hub): Lead[] {
  if (found.leads) return found.leads(hub).list();
  return hub.db.conn.query<LeadRow, []>(`SELECT ${LEAD_COLUMNS} FROM leads ORDER BY machine_id, project_id`).all().map((row) => leadOf(hub, row));
}

/** The profile the project's lead session started on; undefined for one started before fleetd kept it. */
export function leadProfile(hub: Hub, r: ProjectRef): string | undefined {
  if (found.leadProfile) return found.leadProfile(hub, r);
  return (
    hub.db.conn.query<{ profile: string | null }, [string, string]>("SELECT profile FROM leads WHERE machine_id = ? AND project_id = ?").get(r.machineId, r.projectId)
      ?.profile ?? undefined
  );
}

/** The train's changes, newest first (train/records.rs `list`). */
export function trainChanges(hub: Hub, filter: ChangeFilter): Change[] {
  if (found.trainChanges) return found.trainChanges(hub, filter);
  return hub.db.conn
    .query<{ data: string }, [string | null, string | null, string | null, string | null, number]>(
      `SELECT data FROM changes
                     WHERE (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2))
                       AND (?3 IS NULL OR repo = ?3) AND (?4 IS NULL OR state = ?4)
                     ORDER BY n DESC LIMIT ?5`,
    )
    .all(filter.projectRef?.machineId ?? null, filter.projectRef?.projectId ?? null, filter.repo?.toLowerCase() ?? null, filter.state ?? null, filter.limit)
    .map((r) => JSON.parse(r.data) as Change);
}

/** Whether the repo has a train (train/records.rs `train`). */
export function hasTrain(hub: Hub, repo: string): boolean {
  if (found.trainOf) return found.trainOf(hub, repo) !== undefined;
  return hub.db.conn.query("SELECT 1 FROM trains WHERE repo = ?1").get(repo.toLowerCase()) !== null;
}

/** Every open secret or approval request, newest first (approvals/store.rs `list` of open ones). */
export function openRequests(hub: Hub, limit: number): HumanRequest[] {
  if (found.openRequests) return found.openRequests(hub, limit);
  return hub.db.conn
    .query<{ data: string }, [number]>(`SELECT data FROM requests WHERE state IN ('open') ORDER BY n DESC LIMIT ?1`)
    .all(Math.max(1, limit))
    .map((r) => JSON.parse(r.data) as HumanRequest);
}
