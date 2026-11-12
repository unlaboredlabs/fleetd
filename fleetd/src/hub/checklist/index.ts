// Each project's checklist (table `checklists`): the lead's to-do list for the
// human, one row per project with its items as JSON in order. The lead changes it with `checklist` (calls.ts), the app
// reads it with `checklist_get`, a person takes items off with `checklist_remove` (tools.ts), and the lead's digest
// shows what is still open.
import type { Database } from "bun:sqlite";
import type { PersonRef, ProjectRef, TodoItem } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";
import { type Checklist, type ChecklistCall, digestOf, doneCount, edited, item } from "./list.ts";

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

/** The digest's Checklist section: how far along it is, then every item not done, in order. Undefined while empty. */
export function digestLines(db: HubDb, r: ProjectRef): string[] | undefined {
  let list: Checklist;
  try {
    list = read(db, r);
  } catch (error) {
    console.warn("checklist read for the digest:", error);
    return undefined;
  }
  return digestOf(list);
}

/** A project's list, for other areas (the Navi bridge). */
export const checklistRead = (hub: Hub, r: ProjectRef) => read(hub.db, r);
