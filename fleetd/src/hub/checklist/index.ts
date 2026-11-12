// Each project's checklist (table `checklists`): the lead's to-do list for the
// human, one row per project with its items as JSON in order. The lead changes it with `checklist` (calls.ts), the app
// reads it with `checklist_get`, a person takes items off with `checklist_remove` (tools.ts), and the lead's digest
// shows what is still open.
import type { Database } from "bun:sqlite";
import type { PersonRef, ProjectRef, TodoItem } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { readWorkstream } from "../leads/records.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { TaskRecords } from "../tasks/records.ts";
import { changeRecords } from "../train/index.ts";
import { parsePrUrl } from "../train/states.ts";
import { type Checklist, type ChecklistCall, digestOf, doneCount, edited, item, type Liveness } from "./list.ts";

export { type Checklist, CHECKLIST_MAX, type ChecklistCall, doneCount, edited, type TodoEdit } from "./list.ts";

function readOn(c: Database, r: ProjectRef): Checklist {
  const row = c
    .query<{ next_id: number; items: string; updated_ms: number }, [string, string]>(
      "SELECT next_id, items, updated_ms FROM checklists WHERE machine_id = ? AND project_id = ?",
    )
    .get(r.machineId, r.projectId);
  if (!row) return { items: [], nextId: 1 };
  return { items: JSON.parse(row.items) as TodoItem[], nextId: row.next_id, updatedMs: row.updated_ms };
}

export const read = (db: HubDb, r: ProjectRef) => readOn(db.conn, r);

function writeOn(c: Database, r: ProjectRef, next: Checklist, nowMs: number): Checklist {
  c.query(
    `INSERT INTO checklists (machine_id, project_id, next_id, items, updated_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (machine_id, project_id) DO UPDATE SET
       next_id = excluded.next_id, items = excluded.items, updated_ms = excluded.updated_ms`,
  ).run(r.machineId, r.projectId, next.nextId, JSON.stringify(next.items.map(item)), nowMs);
  return { ...next, updatedMs: nowMs };
}

/** Applies the call in one transaction: the list after it, and whether it changed (when it was already so, nothing is written). */
export function apply(db: HubDb, r: ProjectRef, call: ChecklistCall, nowMs: number): { list: Checklist; changed: boolean } {
  return db.transaction((c) => {
    const list = readOn(c, r);
    const next = edited(list, call, isoMs(nowMs));
    if (JSON.stringify(next.items.map(item)) === JSON.stringify(list.items.map(item)) && list.updatedMs !== undefined) {
      return { list, changed: false };
    }
    return { list: writeOn(c, r, next, nowMs), changed: true };
  });
}

/**
 * A person's removal, in one transaction: the list after it, and the items it took off in the list's order (none when
 * every id was already gone, and then nothing is written). Ids stay used, so the lead can't hand one out again.
 */
export function remove(db: HubDb, r: ProjectRef, ids: number[], nowMs: number): { list: Checklist; removed: TodoItem[] } {
  return db.transaction((c) => {
    const list = readOn(c, r);
    const removed = list.items.filter((i) => ids.includes(i.id));
    if (removed.length === 0) return { list, removed };
    const kept = list.items.filter((i) => !ids.includes(i.id));
    return { list: writeOn(c, r, { ...list, items: kept }, nowMs), removed };
  });
}

/** `checklist.changed`, which tells the app to read the list again; `person` made the change (undefined: the lead). */
export function changed(hub: Hub, r: ProjectRef, list: Checklist, by: string, person: PersonRef | undefined, now: number): void {
  const [done, total] = [doneCount(list), list.items.length];
  events(hub).append({
    at: isoMs(now),
    type: "checklist.changed",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: `checklist: ${done} of ${total} done`,
    data: { projectRef: r, done, total, by, ...(person === undefined ? {} : { person }) },
  });
}

/**
 * What runs behind the project's links now: an open order with a queued, running or idle agent, such a task itself,
 * and a PR whose Change is still on the train (not merged, refused or abandoned).
 */
export function liveness(hub: Hub, r: ProjectRef): Liveness {
  const tasks = TaskRecords.live(hub.db.conn, r, 500);
  const trains = changeRecords(hub);
  return {
    order: (id) => readWorkstream(hub.db.conn, id)?.state === "open" && tasks.some((t) => t.workstreamId === id),
    task: (id) => tasks.some((t) => t.taskId === id),
    pr: (url) => {
      const pr = parsePrUrl(url);
      return pr !== undefined && trains.openFor(pr.repo, pr.number) !== undefined;
    },
  };
}

/** The digest's Checklist section at `nowMs`: how far along it is, stale items first, then the rest not done. Undefined while empty. */
export function digestLines(hub: Hub, r: ProjectRef, nowMs: number): string[] | undefined {
  try {
    return digestOf(read(hub.db, r), nowMs, liveness(hub, r));
  } catch (error) {
    console.warn("checklist read for the digest:", error);
    return undefined;
  }
}

/** A project's list, for other areas (the project bridge). */
export const checklistRead = (hub: Hub, r: ProjectRef) => read(hub.db, r);
