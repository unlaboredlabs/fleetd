// What the train, reviews, PRs and the GitHub App take from other areas, in one place: the shared seams (D346), each
// re-exported from its owner's module once it lands, `hub.peek(name)` of an owner's area until then (never a stand-in
// made under its name, D355), and reads of other areas' tables with the Rust hub's own SQL (people, workstreams, tasks,
// projects, repos, machines, order variables).
import type { Database } from "bun:sqlite";
import type {
  HubEvent,
  HubEventType,
  Machine,
  MachineId,
  Person,
  PersonId,
  ProjectRef,
  ProjectRepo,
  Workstream,
  WorkstreamId,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { events, type NewEvent } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { link } from "../link/index.ts";
import * as repoStore from "../repos/store.ts";

// --- time ---

export { isoMs, parseMs } from "../store/time.ts";

export { cap, clip } from "./text.ts";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

// --- the event log (src/hub/store/events.ts) ---

export { events, type NewEvent } from "../store/events.ts";

/** EventLog.append at now, on a project: the Rust hosts' `append_event`. */
export function emit(hub: Hub, r: ProjectRef | undefined, type: string, summary: string, data?: unknown, threadId?: string): void {
  const event: Record<string, unknown> = { at: isoMs(hub.clock.now()), type };
  if (r) {
    event.machineId = r.machineId;
    event.projectId = r.projectId;
  }
  if (threadId !== undefined) event.threadId = threadId;
  event.summary = summary;
  if (data !== undefined && data !== null) event.data = data;
  events(hub).append(event as NewEvent);
}

// --- lead wakes (src/hub/api/leads.ts, D348) ---

export { leadWakes, type LineKind, type Trigger } from "../api/leads.ts";

// --- the node link (src/hub/link) ---

export { link } from "../link/index.ts";

export const nodeCan = (hub: Hub, m: MachineId, capName: string) => link(hub).can(m, capName);
/** Linked, and its hello says it lacks `cap`: too old. Never for a node not linked, which said nothing. */
export const nodeLacks = (hub: Hub, m: MachineId, capName: string) => link(hub).lacks(m, capName);

// --- the sweep (src/hub/sweep) ---

export { type SweepCheck, sweep } from "../sweep/index.ts";

// --- other areas' tables, read with the Rust SQL ---

type PersonRow = { person_id: string; name: string; role: string; created_ms: number; removed_ms: number | null };
const PERSON_COLUMNS = "person_id, name, role, created_ms, removed_ms";

function person(row: PersonRow): Person {
  const name = row.name.trim() || "Owner";
  const out = { personId: row.person_id, name, role: row.role, createdAt: isoMs(row.created_ms) } as Person;
  if (row.removed_ms !== null) out.removedAt = isoMs(row.removed_ms);
  return out;
}

export const people = {
  get(db: Database, id: PersonId): Person | undefined {
    const row = db.query<PersonRow, [string]>(`SELECT ${PERSON_COLUMNS} FROM people WHERE person_id = ?`).get(id);
    return row ? person(row) : undefined;
  },
  /** On the hub, oldest first. */
  active(db: Database): Person[] {
    return db
      .query<PersonRow, []>(`SELECT ${PERSON_COLUMNS} FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid`)
      .all()
      .map(person);
  },
  /** The first owner still on the hub. */
  owner(db: Database): Person | undefined {
    const row = db
      .query<PersonRow, []>(
        `SELECT ${PERSON_COLUMNS} FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1`,
      )
      .get();
    return row ? person(row) : undefined;
  },
};

/** `W12` → 12, as leads/records.rs numbers workstreams; tasks are `T<n>`, changes `X<n>`. */
export const numberOf = (id: string) => Number.parseInt(id.slice(1), 10) || 0;

/** The project's open workstreams' ids, newest first (leads/records.rs `workstreams_list` with state open). */
export function openWorkstreams(db: Database, r: ProjectRef, limit: number): WorkstreamId[] {
  return db
    .query<{ n: number }, [string, string, number]>(
      "SELECT n FROM workstreams WHERE machine_id = ? AND project_id = ? AND state = 'open' ORDER BY n DESC LIMIT ?",
    )
    .all(r.machineId, r.projectId, limit)
    .map((row) => `W${row.n}`);
}

export function workstream(db: Database, id: WorkstreamId): Workstream | undefined {
  const row = db.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(numberOf(id));
  return row ? (JSON.parse(row.data) as Workstream) : undefined;
}

/** The project's repos, oldest first, its own made first when it has none (repos/mod.rs `repos_of`). */
export function reposOf(db: Database, project: ProjectRef): ProjectRepo[] {
  return db.transaction(() => {
    repoStore.ensureOwn(db, project);
    return repoStore.of(db, project);
  })();
}

/** The projects with a repo whose key is `repoKey` (`github.com/owner/name`), and each repo. */
export function reposWithKey(db: Database, repoKey: string): { project: ProjectRef; repo: ProjectRepo }[] {
  return repoStore
    .withKey(db, repoKey)
    .flatMap((project) => repoStore.of(db, project).filter((r) => r.repoKey?.toLowerCase() === repoKey.toLowerCase()).map((repo) => ({ project, repo })));
}

export function machine(db: Database, m: MachineId): Machine | undefined {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM machines WHERE machine_id = ?").get(m);
  return row ? (JSON.parse(row.data) as Machine) : undefined;
}

/** A project's node report (`projects.data`), as `ProjectSummary`. */
export function project<T = Record<string, unknown>>(db: Database, r: ProjectRef): T | undefined {
  const row = db
    .query<{ data: string }, [string, string]>("SELECT data FROM projects WHERE machine_id = ? AND project_id = ?")
    .get(r.machineId, r.projectId);
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
export const refKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

// --- an order's variables (projects/order_env.rs over `order_env`) ---

export type OrderEnvRow = { name: string; fingerprint: string; bytes: number; requestId: string; updatedAt: string };

export const orderEnv = {
  list(db: Database, r: ProjectRef, order: string): OrderEnvRow[] {
    return db
      .query<
        { name: string; fingerprint: string; bytes: number; request_id: string; updated_at: string },
        [string, string, string]
      >(
        `SELECT name, fingerprint, bytes, request_id, updated_at FROM order_env
           WHERE machine_id = ? AND project_id = ? AND workstream_id = ? ORDER BY name`,
      )
      .all(r.machineId, r.projectId, order)
      .map((x) => ({ name: x.name, fingerprint: x.fingerprint, bytes: x.bytes, requestId: x.request_id, updatedAt: x.updated_at }));
  },
  save(db: Database, r: ProjectRef, order: string, row: OrderEnvRow): void {
    db.query(
      `INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id, workstream_id, name) DO UPDATE SET fingerprint = excluded.fingerprint,
           bytes = excluded.bytes, request_id = excluded.request_id, updated_at = excluded.updated_at`,
    ).run(r.machineId, r.projectId, order, row.name, row.fingerprint, row.bytes, row.requestId, row.updatedAt);
  },
  forgetOne(db: Database, r: ProjectRef, order: string, name: string): void {
    db.query("DELETE FROM order_env WHERE machine_id = ? AND project_id = ? AND workstream_id = ? AND name = ?").run(
      r.machineId,
      r.projectId,
      order,
      name,
    );
  },
};

// --- the status view's freshness registry (src/hub/status, the Rust `hub/status/fresh.rs`) ---

export interface FreshLike {
  expect(source: string, staleAfterMs: number, nowMs: number): void;
  forget(source: string): void;
  touch(source: string, atMs: number): void;
  fail(source: string, reason: string): void;
}

/** GitHub answers for a repo, from any `gh api` call. */
export const GITHUB_STALE_MS = 180_000;
/** The end of a train pass for a repo. */
export const TRAIN_STALE_MS = 120_000;
export const freshGithub = (repo: string) => `github:${repo}`;
export const freshTrain = (repo: string) => `train:${repo}`;

const NO_FRESH: FreshLike = { expect() {}, forget() {}, touch() {}, fail() {} };

/**
 * The status area's freshness registry, which it makes itself under the name status_fresh: peeked at each call, never
 * made here (D355), so a call before the status area exists goes nowhere and every call after reaches it.
 */
export function fresh(hub: Hub): FreshLike {
  const now = () => hub.peek<FreshLike>("status_fresh") ?? NO_FRESH;
  return {
    expect: (source, staleAfterMs, nowMs) => now().expect(source, staleAfterMs, nowMs),
    forget: (source) => now().forget(source),
    touch: (source, atMs) => now().touch(source, atMs),
    fail: (source, reason) => now().fail(source, reason),
  };
}

// --- tasks (tasks/records.rs over `tasks`) ---

export type TaskFilter = { projectRef?: ProjectRef; state?: string; workstreamId?: WorkstreamId; limit: number };

/** Newest first, as `TaskRecords::list`. */
export function tasks<T = import("../../shared/contracts.ts").Task>(db: Database, filter: TaskFilter): T[] {
  let sql = "SELECT data FROM tasks WHERE 1";
  const args: (string | number)[] = [];
  if (filter.projectRef) {
    sql += " AND machine_id = ? AND project_id = ?";
    args.push(filter.projectRef.machineId, filter.projectRef.projectId);
  }
  if (filter.state !== undefined) {
    sql += " AND state = ?";
    args.push(filter.state);
  }
  if (filter.workstreamId !== undefined) {
    sql += " AND workstream_id = ?";
    args.push(filter.workstreamId);
  }
  sql += " ORDER BY n DESC LIMIT ?";
  args.push(filter.limit);
  return db
    .query<{ data: string }, (string | number)[]>(sql)
    .all(...args)
    .map((r) => JSON.parse(r.data) as T);
}

export function task<T = import("../../shared/contracts.ts").Task>(db: Database, taskId: string): T | undefined {
  const row = db.query<{ data: string }, [number]>("SELECT data FROM tasks WHERE n = ?").get(numberOf(taskId));
  return row ? (JSON.parse(row.data) as T) : undefined;
}
