// The lead's `checklist`, scoped to the caller's project by its session.
// A task can't make it (tasks' policy).
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { nowMs } from "../store/time.ts";
import { apply, CHECKLIST_MAX, type ChecklistCall, changed, type TodoEdit } from "./index.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("checklist", (caller, call) => answer(hub, caller, call));
}

const invalid = (why: string) => new ToolError("invalid", `Invalid checklist call: ${why}.`);

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

export function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  if (call.op !== "checklist") throw new ToolError("invalid", `${call.op} is not a checklist call.`);
  const r = caller.projectRef;
  const now = nowMs(hub.clock);
  const { list, changed: changedNow } = apply(hub.db, r, checkCall(call), now);
  let next = "No change: the checklist was already so.";
  if (changedNow) {
    changed(hub, r, list, caller.by, undefined, now);
    next = "The human sees it in the panel's Checklist tab.";
  }
  return { items: list.items, next };
}
