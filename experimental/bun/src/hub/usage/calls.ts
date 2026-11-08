// The lead's `usage_resume` (crates/fleetd/src/hub/usage/calls.rs): the same resume as the MCP tool, scoped to the
// machine its project runs on and at most once per LEAD_RESUME_EVERY_MS per machine, recorded as the lead's.
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { isoMs } from "../store/time.ts";
import { plural } from "./state.ts";
import { usage } from "./wire.ts";

export const OPS = ["usage_resume"] as const;
/** How often a lead may lift one machine's pause. */
export const LEAD_RESUME_EVERY_MS = 10 * 60_000;

export function registerLeadCalls(hub: Hub): void {
  for (const op of OPS) {
    leadCalls(hub).register(op, (caller, call) => {
      if (call.op !== "usage_resume") throw new ToolError("invalid", "The usage area handles only usage_resume.");
      return resume(hub, caller, typeof call.machineId === "string" ? call.machineId : undefined);
    });
  }
}

async function resume(hub: Hub, caller: LeadCaller, machine: string | undefined): Promise<Record<string, unknown>> {
  const own = caller.projectRef.machineId;
  const m = machine ?? own;
  if (m !== own) {
    throw new ToolError(
      "forbidden",
      `A lead resumes only the machine its project runs on (${own}), not ${m}.`,
      `Ask the human to press Resume in the app, or to run fleetd usage resume ${m}.`,
    );
  }
  const before = await usage(hub).status(m, { error: "" });
  const outcome = await usage(hub).resumeAsLead(m, caller.by, LEAD_RESUME_EVERY_MS);
  if ("refused" in outcome) {
    const [who, at] = outcome.refused;
    const whose = who === caller.by ? "You" : `The lead ${who}`;
    throw new ToolError(
      "invalid",
      `${whose} resumed ${m} at ${isoMs(at)}; the leads on a machine may once every ${LEAD_RESUME_EVERY_MS / 60_000} minutes between them.`,
      `If the login is still limited, the agents parked again with its reset: wait for it. To go on sooner, ask the human to press Resume in the app (or run fleetd usage resume ${m}); you may again from ${isoMs(at + LEAD_RESUME_EVERY_MS)}.`,
    );
  }
  const open = before.breaker.state === "open";
  const next =
    !open && outcome.resumed === 0
      ? `Nothing was paused on ${m}.`
      : `Resumed ${m}: sent "continue" to ${plural(outcome.resumed, "parked agent")}. If its login is still limited, they park again on their next turn with the real reset.`;
  return { machineId: own, resumed: outcome.resumed, breakerCleared: open, next };
}
