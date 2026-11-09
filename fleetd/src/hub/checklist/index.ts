// Each project's checklist (table `checklists`): the lead's to-do list for the
// human, one row per project with its items as JSON in order. The lead changes it with `checklist` (calls.ts), the app
// reads it with `checklist_get`, a person takes items off with `checklist_remove` (tools.ts), and the lead's digest
// shows what is still open.
import type { Database } from "bun:sqlite";
import type { PersonRef, ProjectRef, TodoItem, TodoLink, TodoState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { isoMs } from "../store/time.ts";

export const CHECKLIST_MAX = 50;

/** One change: without `id` it adds an item, with `id` it sets that item's text, state or link, or removes it. */
export type TodoEdit = { id?: number; text?: string; state?: TodoState; link?: TodoLink; remove?: boolean };
export type ChecklistCall = { items: TodoEdit[]; replace?: boolean };

/** A project's list as stored. */
export type Checklist = {
  items: TodoItem[];
  /** The id the next new item gets. */
  nextId: number;
  /** Undefined while the lead has never set one. */
  updatedMs?: number;
};

export const doneCount = (list: Checklist) => list.items.filter((i) => i.state === "done").length;

const linkEmpty = (l: TodoLink) => l.pr === undefined && l.taskId === undefined && l.workstreamId === undefined;

/** Keys in the Rust struct's order, absent fields left out, so stored rows read the same. */
function item(i: TodoItem): TodoItem {
  const out: Record<string, unknown> = { id: i.id, text: i.text, state: i.state };
  if (i.link !== undefined) out.link = i.link;
  out.updatedAt = i.updatedAt;
  if (i.person !== undefined) out.person = i.person;
  return out as TodoItem;
}

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

function idsFix(list: Checklist): string {
  if (list.items.length === 0) return "The checklist is empty: add items without an id.";
  return `Its items are ${list.items.map((i) => i.id).join(", ")}.`;
}

/**
 * The call's edits, in order, on `list`; a refusal (thrown) leaves it as it was. Ids are never reused, so an id the
 * lead still holds from a removed item can't name a new one.
 */
export function edited(list: Checklist, call: ChecklistCall, at: string): Checklist {
  const next: Checklist = { ...list, items: call.replace === true ? [] : list.items.map((i) => ({ ...i })) };
  for (const edit of call.items) {
    if (edit.id === undefined) {
      if (edit.text === undefined) continue;
      const link = edit.link !== undefined && !linkEmpty(edit.link) ? edit.link : undefined;
      next.items.push(item({ id: next.nextId, text: edit.text, state: edit.state ?? "todo", link, updatedAt: at } as TodoItem));
      next.nextId += 1;
      continue;
    }
    const at_ = next.items.findIndex((i) => i.id === edit.id);
    if (at_ < 0) throw new ToolError("not_found", `No item ${edit.id} on this project's checklist.`, idsFix(next));
    if (edit.remove === true) {
      next.items.splice(at_, 1);
      continue;
    }
    const before = next.items[at_] as TodoItem;
    const after: TodoItem = { ...before };
    if (edit.text !== undefined) after.text = edit.text;
    if (edit.state !== undefined) after.state = edit.state;
    if (edit.link !== undefined) {
      if (linkEmpty(edit.link)) delete after.link;
      else after.link = edit.link;
    }
    if (JSON.stringify(item(after)) !== JSON.stringify(item(before))) {
      after.updatedAt = at;
      delete after.person;
    }
    next.items[at_] = item(after);
  }
  if (next.items.length > CHECKLIST_MAX) {
    throw new ToolError(
      "invalid",
      `The checklist holds ${CHECKLIST_MAX} items; this would make it ${next.items.length}.`,
      "Remove done items, or merge small ones into one.",
    );
  }
  return next;
}

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

function linkWords(link: TodoLink | undefined): string {
  if (!link) return "";
  const words: string[] = [];
  if (link.workstreamId !== undefined) words.push(link.workstreamId);
  if (link.taskId !== undefined) words.push(link.taskId);
  if (link.pr !== undefined) {
    const at = link.pr.lastIndexOf("/pull/");
    words.push(at < 0 ? link.pr : `PR #${link.pr.slice(at + 6)}`);
  }
  return ` (${words.join(", ")})`;
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
  if (list.items.length === 0) return undefined;
  const lines = [`${doneCount(list)} of ${list.items.length} done; keep it current with \`checklist\``];
  for (const i of list.items.filter((i) => i.state !== "done")) {
    lines.push(`- ${i.id} ${i.state === "doing" ? "doing" : "todo"}: ${i.text}${linkWords(i.link)}`);
  }
  return lines;
}

/** A project's list, for other areas (the Navi bridge). */
export const checklistRead = (hub: Hub, r: ProjectRef) => read(hub.db, r);
