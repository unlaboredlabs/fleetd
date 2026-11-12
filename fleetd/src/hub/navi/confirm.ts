// `confirm_step` (W239): a Navi's lead calls it right before the final Confirm
// or Submit click on a site that doesn't pay or order: booking a table, cancelling a subscription, sending a form, an
// expense, a return, a post. Its lead is always asked for the call (the node's `LEAD_ASK`), so the call is a
// permission prompt the approvals relay decides by the Navi's approval mode like a send: the checker's go, the
// person's approval on a card (with the page's screenshot) or YOLO let it run, and running it only answers "click it
// now". A payment, a trade or an order never goes through here: `refused` denies it, and the Navi hands it to the
// person.
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/types.ts";
import { mayUse } from "./bridge.ts";
import { decodeCall } from "./confirm_rules.ts";

export { type ConfirmStepCall, decodeCall, preview, refused, TOOL } from "./confirm_rules.ts";

export const OPS = ["confirm_step"] as const;

export function start(hub: Hub): void {
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller, call));
}

/** The call ran: it was let through (by the checker, the person or YOLO), so the Navi clicks. */
export function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  mayUse(hub.db.conn, caller.projectRef);
  if (caller.agent.kind !== "lead") throw new ToolError("forbidden", "Only a project confirms a step on a site.");
  if (call.op !== "confirm_step") throw new ToolError("invalid", `${call.op} is not a confirm step call.`);
  const step = decodeCall(call);
  if (!step) throw new ToolError("invalid", "This confirm_step can't be read. Give site, button and does.");
  return {
    next: `Let through: click "${step.button}" now, once, on ${step.site}. Then say in the chat what the page answered.`,
    button: step.button,
  };
}
