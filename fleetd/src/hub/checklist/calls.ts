// The lead's `checklist`, scoped to the caller's project by its session.
// A task can't make it (tasks' policy).
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { nowMs } from "../store/time.ts";
import { apply, changed } from "./index.ts";
import { checkCall } from "./list.ts";

export { checkCall } from "./list.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("checklist", (caller, call) => answer(hub, caller, call));
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
