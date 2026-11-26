// The lead's `checklist`, scoped to the caller's project by its session, and with it the bot's status line (`status`,
// chat/status_line.ts), its standing beside the chat. A task can't make it (tasks' policy).
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../leads/seams.ts";
import { nowMs } from "../store/time.ts";
import { state } from "../chat/flow.ts";
import { chat } from "../chat/index.ts";
import { statusLineProblem } from "../chat/status_line.ts";
import { apply, changed } from "./index.ts";
import { checkCall } from "./list.ts";

export { checkCall } from "./list.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("checklist", (caller, call) => answer(hub, caller, call));
}

export function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  if (call.op !== "checklist") throw new ToolError("invalid", `${call.op} is not a checklist call.`);
  const r = caller.projectRef;
  const status = call.status;
  if (status !== undefined) {
    const problem = statusLineProblem(status);
    if (problem !== undefined) throw new ToolError("invalid", problem);
  }
  // A status line alone leaves the list as it is: agent-mcp fills in `items` as [] when the lead leaves it out.
  const items = call.items;
  const listed = status === undefined || (Array.isArray(items) && items.length > 0) || call.replace !== undefined;
  let out: Record<string, unknown> = {};
  if (listed) {
    const now = nowMs(hub.clock);
    const { list, changed: changedNow } = apply(hub.db, r, checkCall(call), now);
    let next = "No change: the checklist was already so.";
    if (changedNow) {
      changed(hub, r, list, caller.by, undefined, now);
      next = "The human sees it in the panel's Checklist tab.";
    }
    out = { items: list.items, next };
  }
  if (status !== undefined) {
    chat(hub).setStatus(r, (status as string).trim());
    state(hub, r);
    const kept = "Status kept: the chat list shows it under your bot's name until you write another, or the person writes.";
    out = { ...out, next: listed ? `${String(out.next)} ${kept}` : kept };
  }
  return out;
}
