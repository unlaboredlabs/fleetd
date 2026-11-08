// What the train, reviews, PRs and the GitHub App take from other areas, in one place: the shared seams (D346) by
// their area names, each with a stand-in until its owner's module serves it, and reads of other areas' tables with the
// Rust hub's own SQL (people, workstreams, tasks, Navis, repos, machines, order variables). When an owner's module
// lands, its area replaces the stand-in here by name: `hub.area(name, …)` keeps whichever was made first, and each
// stand-in has the owner's shape.
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

// --- time ---

/** `2026-10-17T10:00:00.000Z`: UTC with milliseconds, the form of every timestamp the hub stores. */
export function isoMs(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "1970-01-01T00:00:00.000Z" : date.toISOString();
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Milliseconds of an RFC 3339 timestamp (finer digits dropped); undefined for anything else. */
export function parseMs(text: string): number | undefined {
  if (!RFC3339.test(text)) return undefined;
  const ms = Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? undefined : ms;
}

/** The first `max` UTF-16 units of `text`, never splitting a surrogate pair (api/grants.rs `clip`). */
export function clip(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const c of text) {
    units += c.length;
    if (units > max) return out;
    out += c;
  }
  return text;
}

/** `cap`: at most `max` items, and `truncated` when some were cut. */
export function cap<T>(items: T[], max: number): { items: T[]; truncated?: true } {
  return items.length > max ? { items: items.slice(0, max), truncated: true } : { items };
}

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

// --- the event log (T2246's src/hub/store/events.ts, `hub.area("events")`) ---

export type NewEvent = Omit<HubEvent, "seq">;
export type WaitResult = { events: HubEvent[]; cursor: number; more: boolean };
export type WaitInput = { cursor?: number; types?: HubEventType[]; machineId?: MachineId; timeoutSec: number };

export interface EventLogLike {
  append(event: NewEvent): HubEvent;
  head(): number;
  wait(input: WaitInput, signal?: AbortSignal): Promise<WaitResult>;
  subscribe(listener: (event: HubEvent) => void): () => void;
}

/** The stand-in: the same rows as the Rust log writes, without trimming or retention. */
class EventLogStandIn implements EventLogLike {
  private headSeq: number;
  private readonly listeners = new Set<(event: HubEvent) => void>();

  constructor(private readonly hub: Hub) {
    const row = hub.db.conn.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get();
    this.headSeq = row?.seq ?? 0;
  }

  head(): number {
    return this.headSeq;
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(event: NewEvent): HubEvent {
    const row = this.hub.db.conn
      .query<{ seq: number }, [number, string, string | null, string]>(
        "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?) RETURNING seq",
      )
      .get(this.hub.clock.now(), event.type, event.machineId ?? null, JSON.stringify(event));
    this.headSeq = row?.seq ?? this.headSeq + 1;
    const stored = { ...event, seq: this.headSeq } as HubEvent;
    for (const l of this.listeners) {
      try {
        l(stored);
      } catch (error) {
        console.error("event listener failed:", error);
      }
    }
    return stored;
  }

  private page(after: number, types?: HubEventType[]): WaitResult {
    const rows = this.hub.db.all<{ seq: number; data: string }>(
      `SELECT seq, data FROM events WHERE seq > $after
         AND ($types IS NULL OR type IN (SELECT value FROM json_each($types))) ORDER BY seq LIMIT 101`,
      { after, types: types ? JSON.stringify(types) : null },
    );
    const more = rows.length > 100;
    const events = rows.slice(0, 100).map((r) => ({ ...(JSON.parse(r.data) as NewEvent), seq: r.seq }) as HubEvent);
    return { events, cursor: more ? (events[99]?.seq ?? after) : Math.max(after, this.headSeq), more };
  }

  async wait(input: WaitInput, signal?: AbortSignal): Promise<WaitResult> {
    const deadline = this.hub.clock.now() + input.timeoutSec * 1000;
    let after = Math.min(input.cursor ?? this.headSeq, this.headSeq);
    for (;;) {
      const page = this.page(after, input.types);
      const remaining = deadline - this.hub.clock.now();
      if (page.events.length > 0 || remaining <= 0 || signal?.aborted) return page;
      after = page.cursor;
      await new Promise<void>((resolve) => {
        const off = this.subscribe(() => done());
        const timer = setTimeout(done, remaining);
        signal?.addEventListener("abort", done, { once: true });
        function done() {
          clearTimeout(timer);
          off();
          signal?.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }
}

export const events = (hub: Hub): EventLogLike => hub.area<EventLogLike>("events", (h) => new EventLogStandIn(h));

/** EventLog.append at now, on a project: the Rust hosts' `append_event`. */
export function emit(hub: Hub, r: ProjectRef | undefined, type: string, summary: string, data?: unknown): void {
  const event: Record<string, unknown> = { at: isoMs(hub.clock.now()), type };
  if (r) {
    event.machineId = r.machineId;
    event.projectId = r.projectId;
  }
  event.summary = summary;
  if (data !== undefined && data !== null) event.data = data;
  events(hub).append(event as NewEvent);
}

// --- lead wakes (T2246's src/hub/api/leads.ts, D348) ---

export type LineKind = "task_result" | "task_waiting" | "train" | "human" | "cap_raised" | "request" | "recovery" | "quiet" | "cut_off" | "factory";
export type Trigger = { kind: "intent"; workstreamId: WorkstreamId; text: string } | { kind: "line"; line: LineKind; text: string };
export type LeadWakes = { trigger(r: ProjectRef, trigger: Trigger): void };

export const leadWakes = (hub: Hub): LeadWakes => hub.area<LeadWakes>("lead_wakes", () => ({ trigger: () => {} }));

// --- the node link (T2253's src/hub/link, D346) ---

export interface LinkLike {
  /** Sends `frame` and resolves with the node's `*_result` for it; rejects when the node is offline or times out. */
  request?(machineId: MachineId, frame: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The node is linked and its hello lists `cap`. */
  can?(machineId: MachineId, cap: string): boolean;
  /** The node's link, while it is linked. */
  linkId?(machineId: MachineId): string | undefined;
}

export const link = (hub: Hub): LinkLike => hub.area<LinkLike>("link", () => ({}));

export const nodeCan = (hub: Hub, m: MachineId, capName: string) => link(hub).can?.(m, capName) ?? false;
/** Linked, and its hello says it lacks `cap`: too old. Never for a node not linked, which said nothing. */
export const nodeLacks = (hub: Hub, m: MachineId, capName: string) =>
  link(hub).linkId?.(m) !== undefined && !nodeCan(hub, m, capName);

// --- the sweep (src/hub/sweep: every 5 minutes, each check registered by its area) ---

export type SweepCheck = { name: string; run: () => Promise<void> };
export interface SweepLike {
  register(check: SweepCheck): void;
}

export const SWEEP_EVERY_MS = 5 * 60_000;

/** The stand-in runs each check every 5 minutes, one after another, until the hub stops. */
function sweepStandIn(hub: Hub): SweepLike {
  const checks: SweepCheck[] = [];
  let started = false;
  return {
    register(check) {
      checks.push(check);
      if (started) return;
      started = true;
      const timer = setInterval(async () => {
        for (const c of checks) {
          try {
            await c.run();
          } catch (error) {
            console.warn(`sweep: ${c.name} failed:`, error);
          }
        }
      }, SWEEP_EVERY_MS);
      timer.unref?.();
      hub.shutdown.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    },
  };
}

export const sweep = (hub: Hub): SweepLike => hub.area<SweepLike>("sweep", sweepStandIn);

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

export function workstream(db: Database, id: WorkstreamId): Workstream | undefined {
  const row = db.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(numberOf(id));
  return row ? (JSON.parse(row.data) as Workstream) : undefined;
}

/** A Navi (an Only me project) and its owner. */
export function navi(db: Database, r: ProjectRef): { owner?: PersonId } | undefined {
  const row = db
    .query<{ owner_person: string | null }, [string, string]>(
      "SELECT owner_person FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1",
    )
    .get(r.machineId, r.projectId);
  if (!row) return undefined;
  return row.owner_person === null ? {} : { owner: row.owner_person };
}

/** The Navis `person` may not see or use: every one with an owner other than them (navi/store.rs `others`). */
export function otherNavis(db: Database, me: PersonId | undefined): ProjectRef[] {
  return db
    .query<{ machine_id: string; project_id: string }, [string | null]>(
      `SELECT machine_id, project_id FROM project_settings
         WHERE only_me = 1 AND owner_person IS NOT NULL AND (?1 IS NULL OR owner_person != ?1)`,
    )
    .all(me ?? null)
    .map((r) => ({ machineId: r.machine_id, projectId: r.project_id }));
}

const REPO_COLUMNS = `n, name, checkout_machine_id, checkout_project_id, repo_key, base, machine_id, project_id,
     (SELECT json_extract(p.data, '$.workspaceRoot') FROM projects p
      WHERE p.machine_id = repos.checkout_machine_id AND p.project_id = repos.checkout_project_id) AS path`;

type RepoRow = {
  n: number;
  name: string;
  checkout_machine_id: string;
  checkout_project_id: string;
  repo_key: string | null;
  base: string | null;
  machine_id: string;
  project_id: string;
  path: string | null;
};

function repoOf(row: RepoRow): ProjectRepo {
  const repo: ProjectRepo = {
    repoId: `R${row.n}`,
    name: row.name,
    checkout: { machineId: row.checkout_machine_id, projectId: row.checkout_project_id },
  };
  if (row.repo_key !== null) repo.repoKey = row.repo_key;
  if (row.base !== null) repo.base = row.base;
  if (row.path !== null) repo.path = row.path;
  return repo;
}

/** The project's repos, oldest first (repos/store.rs `of`). */
export function reposOf(db: Database, project: ProjectRef): ProjectRepo[] {
  return db
    .query<RepoRow, [string, string]>(`SELECT ${REPO_COLUMNS} FROM repos WHERE machine_id = ? AND project_id = ? ORDER BY n`)
    .all(project.machineId, project.projectId)
    .map(repoOf);
}

/** The projects with a repo whose key is `repoKey` (`github.com/owner/name`), and each repo. */
export function reposWithKey(db: Database, repoKey: string): { project: ProjectRef; repo: ProjectRepo }[] {
  return db
    .query<RepoRow, [string]>(`SELECT ${REPO_COLUMNS} FROM repos WHERE lower(repo_key) = lower(?) ORDER BY n`)
    .all(repoKey)
    .map((row) => ({ project: { machineId: row.machine_id, projectId: row.project_id }, repo: repoOf(row) }));
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

/** Until the status area serves it, freshness goes nowhere. */
export const fresh = (hub: Hub): FreshLike =>
  hub.area<FreshLike>("status_fresh", () => ({ expect() {}, forget() {}, touch() {}, fail() {} }));

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
