// Each Navi is its owner's (D215; crates/fleetd/src/hub/navi/owner.rs): the person whose key made it, else the hub's
// first owner. Only they see it in a list or reach it through a tool. Anyone else is refused, an admin too, except to
// delete the Navi of a person since removed from the hub.
//
// The gate is one place: `guard` runs before every tool's handler and refuses a call that names another person's
// Navi, by its project, one of its threads, requests, automations, screens, orders, tasks or steers. Lists leave those
// Navis out with `others`.
//
// A key with no person counts as the hub's owner. A Navi with no owner (a hub without people) is anyone's.
import type { Database } from "bun:sqlite";
import type { HubEvent, MachineId, PersonId, ProjectRef, ProjectSummary, ThreadId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Caller } from "../api/registry.ts";
import type { HubDb } from "../store/db.ts";
import * as store from "./store.ts";

/** How deep `guard` looks into a call's input for the projects it names. */
const DEPTH = 4;

const key = (r: ProjectRef) => `${r.machineId}\u0000${r.projectId}`;

/** A set of project refs, by value. */
export class Refs {
  private readonly keys: Set<string>;
  constructor(refs: ProjectRef[]) {
    this.keys = new Set(refs.map(key));
  }
  get size(): number {
    return this.keys.size;
  }
  has(r: ProjectRef): boolean {
    return this.keys.has(key(r));
  }
}

function ownerOn(c: Database): PersonId | undefined {
  return (
    c
      .query<{ person_id: string }, []>(
        "SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1",
      )
      .get()?.person_id ?? undefined
  );
}

/** The person `caller` acts as for Navis: their own, or the hub's first owner for a key with no person. */
export function who(c: Database, caller: Caller): PersonId | undefined {
  return caller.person ? caller.person.personId : ownerOn(c);
}

/** The Navis `caller` may not see or use: every one with an owner other than them. */
export function others(db: HubDb, caller: Caller): Refs {
  return new Refs(store.others(db.conn, who(db.conn, caller)));
}

/**
 * The Navis that aren't `person`'s, for one who acts for a person outside a key: a Navi for its owner, a hub link
 * for the person who made it (undefined with `orOwner`: the hub's owner).
 */
export function othersOf(db: HubDb, person: PersonId | undefined, orOwner: boolean): Refs {
  const me = person ?? (orOwner ? ownerOn(db.conn) : undefined);
  return new Refs(store.others(db.conn, me));
}

/** Whether `caller` may see and use `r`: any project but another person's Navi. */
export const mayUse = (db: HubDb, caller: Caller, r: ProjectRef) => !others(db, caller).has(r);

/** Whether `project` is one of `navis`. */
export const among = (navis: Refs, project: ProjectSummary) =>
  navis.size > 0 && navis.has({ machineId: project.machineId, projectId: project.projectId });

/**
 * Whether `event` is about one of `navis`. An event that names a thread but no project is its thread's project's;
 * one whose thread can't be read is left out too.
 */
export function about(db: HubDb, navis: Refs, event: HubEvent): boolean {
  if (navis.size === 0) return false;
  if (event.machineId !== undefined && event.projectId !== undefined) {
    return navis.has({ machineId: event.machineId, projectId: event.projectId });
  }
  if (event.machineId !== undefined && event.threadId !== undefined) return threadAmong(db, navis, event.machineId, event.threadId);
  return false;
}

/** Whether thread `t` on `m` is one of `navis`'s. One whose project can't be read counts as one. */
export function threadAmong(db: HubDb, navis: Refs, m: MachineId, t: ThreadId): boolean {
  if (navis.size === 0) return false;
  try {
    const r = threadProject(db.conn, m, t);
    return r !== undefined && navis.has(r);
  } catch {
    return true;
  }
}

/** The refusal for a call that names another person's Navi. */
export const refused = (r: ProjectRef) =>
  new ToolError(
    "forbidden",
    `${r.projectId} on ${r.machineId} is another person's Only me project: only its owner uses and manages it.`,
    "Your own projects are in your list; make one with project_add.",
  );

/**
 * Throws unless `input` names no other person's Navi. `project_remove` of the Navi of a person since removed from the
 * hub goes through for a key with admin on its machine: their Navi has no one else to delete it.
 */
export function guard(db: HubDb, caller: Caller, tool: string, input: unknown): void {
  const navis = others(db, caller);
  if (navis.size === 0) return;
  const named: ProjectRef[] = [];
  refs(db.conn, input, DEPTH, named);
  const r = named.find((n) => navis.has(n));
  if (!r) return;
  if (tool === "project_remove" && allows(caller, "admin", r.machineId) && ownerRemoved(db.conn, r)) return;
  // An admin may turn another person's Only me off, and that alone (D310).
  const fields = input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input) : [];
  const onlyMeAlone = fields.includes("onlyMe") && fields.every((k) => k === "machineId" || k === "projectId" || k === "onlyMe");
  if (tool === "project_settings_set" && onlyMeAlone && allows(caller, "admin", r.machineId)) return;
  throw refused(r);
}

/** Whether the Navi's owner was removed from the hub. */
function ownerRemoved(c: Database, r: ProjectRef): boolean {
  return (
    c
      .query(
        `SELECT 1 FROM project_settings s JOIN people p ON p.person_id = s.owner_person
             WHERE s.machine_id = ? AND s.project_id = ? AND s.only_me = 1 AND p.removed_ms IS NOT NULL`,
      )
      .get(r.machineId, r.projectId) !== null
  );
}

/**
 * The projects a call's input names, at any of its objects down to `depth`: a `machineId` with a `projectId`, or with
 * a `threadId`, a `requestId`, an `automationId`, a `sessionId`, a `workstreamId`, a `taskId` and a `steerId`.
 */
function refs(c: Database, input: unknown, depth: number, out: ProjectRef[]): void {
  if (Array.isArray(input)) {
    if (depth > 0) for (const v of input) refs(c, v, depth - 1, out);
    return;
  }
  if (!input || typeof input !== "object") return;
  const fields = input as Record<string, unknown>;
  const text = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined);
  const push = (r: ProjectRef | undefined) => r && out.push(r);
  const m = text("machineId");
  if (m !== undefined) {
    const p = text("projectId");
    const t = text("threadId");
    if (p !== undefined) out.push({ machineId: m, projectId: p });
    else if (t !== undefined) push(threadProject(c, m, t));
  }
  const id = (k: string, f: (id: string) => ProjectRef | undefined) => {
    const v = text(k);
    if (v !== undefined) push(f(v));
  };
  id("requestId", (v) => requestProject(c, v));
  id("automationId", (v) => automationProject(c, v));
  id("sessionId", (v) => screenProject(c, v));
  id("workstreamId", (v) => numberedProject(c, "workstreams", "W", v));
  id("taskId", (v) => numberedProject(c, "tasks", "T", v));
  id("steerId", (v) => steerProject(c, v));
  if (depth > 0) for (const v of Object.values(fields)) refs(c, v, depth - 1, out);
}

type RefRow = { machine_id: string; project_id: string };
const refOf = (row: RefRow | null): ProjectRef | undefined =>
  row ? { machineId: row.machine_id, projectId: row.project_id } : undefined;

function threadProject(c: Database, m: string, t: string): ProjectRef | undefined {
  const row = c.query<{ project_id: string }, [string, string]>("SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?").get(m, t);
  return row ? { machineId: m, projectId: row.project_id } : undefined;
}

/** `<prefix><n>` → n, as Rust's `parse::<i64>` reads the digits after the prefix. */
function serial(id: string, prefix: string): number | undefined {
  if (!id.startsWith(prefix)) return undefined;
  const digits = id.slice(prefix.length);
  return /^[+-]?\d+$/.test(digits) ? Number(digits) : undefined;
}

/** The project of row n of `table` (`workstreams` or `tasks`), by an id `<prefix><n>`. */
function numberedProject(c: Database, table: "workstreams" | "tasks", prefix: string, id: string): ProjectRef | undefined {
  const n = serial(id, prefix);
  if (n === undefined) return undefined;
  return refOf(c.query<RefRow, [number]>(`SELECT machine_id, project_id FROM ${table} WHERE n = ?`).get(n));
}

/** A steer's project: its order's. */
function steerProject(c: Database, id: string): ProjectRef | undefined {
  const n = serial(id, "S");
  if (n === undefined) return undefined;
  const order = c.query<{ workstream_id: string }, [number]>("SELECT workstream_id FROM steers WHERE n = ?").get(n);
  return order ? numberedProject(c, "workstreams", "W", order.workstream_id) : undefined;
}

function automationProject(c: Database, id: string): ProjectRef | undefined {
  return refOf(c.query<RefRow, [string]>("SELECT machine_id, project_id FROM automations WHERE automation_id = ?").get(id));
}

/** A screen's project: a Navi's screen is its owner's to watch, take over and replay. */
export function screenProject(c: Database, id: string): ProjectRef | undefined {
  return refOf(c.query<RefRow, [string]>("SELECT machine_id, project_id FROM browser_sessions WHERE session_id = ?").get(id));
}

/** A chat request's project: `Q<n>` is row n of `requests`. */
function requestProject(c: Database, id: string): ProjectRef | undefined {
  const n = serial(id, "Q");
  if (n === undefined) return undefined;
  const row = c
    .query<{ m: string | null; p: string | null }, [number]>(
      `SELECT json_extract(data, '$.projectRef.machineId') AS m, json_extract(data, '$.projectRef.projectId') AS p
             FROM requests WHERE n = ?`,
    )
    .get(n);
  return row?.m != null && row.p != null ? { machineId: row.m, projectId: row.p } : undefined;
}
