// A project's checklist as the lead keeps it, without the database (index.ts stores it): an edit and a call checked
// as the contracts do, the list after an edit, and its lines in the lead's digest.
import type { TodoItem, TodoLink, TodoState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { LeadCall } from "../lead_calls/types.ts";

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

export const linkEmpty = (l: TodoLink) => l.pr === undefined && l.taskId === undefined && l.workstreamId === undefined;

/** Keys in the Rust struct's order, absent fields left out, so stored rows read the same. */
export function item(i: TodoItem): TodoItem {
  const out: Record<string, unknown> = { id: i.id, text: i.text, state: i.state };
  if (i.link !== undefined) out.link = i.link;
  out.updatedAt = i.updatedAt;
  if (i.person !== undefined) out.person = i.person;
  return out as TodoItem;
}

export function idsFix(list: Checklist): string {
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

export function linkWords(link: TodoLink | undefined): string {
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

/** The digest's Checklist section of `list`: how far along it is, then every item not done, in order. Undefined while empty. */
export function digestOf(list: Checklist): string[] | undefined {
  if (list.items.length === 0) return undefined;
  const lines = [`${doneCount(list)} of ${list.items.length} done; keep it current with \`checklist\``];
  for (const i of list.items.filter((i) => i.state !== "done")) {
    lines.push(`- ${i.id} ${i.state === "doing" ? "doing" : "todo"}: ${i.text}${linkWords(i.link)}`);
  }
  return lines;
}

export const invalid = (why: string) => new ToolError("invalid", `Invalid checklist call: ${why}.`);

/** The contracts' checks on a `checklist` call. */
export function checkCall(call: LeadCall): ChecklistCall {
  const items = (call.items ?? []) as TodoEdit[];
  const replace = call.replace as boolean | undefined;
  if (!Array.isArray(items) || items.length > CHECKLIST_MAX) throw invalid(`items holds at most ${CHECKLIST_MAX}`);
  for (const edit of items) {
    const removing = edit.remove === true;
    if (edit.id === undefined && removing) throw invalid("remove needs the item's id");
    if (edit.id === undefined && edit.text === undefined) throw invalid("a new item needs text");
    if (edit.id !== undefined && removing && (edit.text !== undefined || edit.state !== undefined || edit.link !== undefined)) {
      throw invalid("remove takes only the id");
    }
    if (edit.text !== undefined && (edit.text.length < 1 || edit.text.length > 200 || /[\r\n]/.test(edit.text))) {
      throw invalid("an item's text is one line of 1 to 200 characters");
    }
  }
  if (replace === true) {
    if (items.some((e) => e.id !== undefined)) throw invalid("replace sets the whole list: leave ids out");
  } else if (items.length === 0) {
    throw invalid("give items to change, or replace to set the whole list");
  }
  return { items, ...(replace === undefined ? {} : { replace }) };
}
