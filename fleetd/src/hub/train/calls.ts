// The lead's `change_enqueue`, and the review calls `review_verdict` and
// `review_read` (serve/wire.rs `CheckCalls`), registered in the lead-call registry.
import type { Change } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/index.ts";
import { reviewRead } from "../reviews/read.ts";
import { leadReviewVerdict } from "../reviews/verdicts.ts";
import { trainArea } from "./index.ts";
import { parsePrUrl } from "./records.ts";
import { CI_WATCHED, type EnqueueCall, timedOut } from "./service.ts";
import { toolError, type TrainError } from "./tools.ts";

/** What the lead does next about a Change: almost always nothing, since the train and reviews move it on. */
export function changeNext(change: Change): string {
  switch (change.state) {
    case "merged":
      return "nothing; it is merged.";
    case "ci_failed":
    case "needs_rebase":
      if (change.state === "ci_failed" && timedOut(change)) return `nothing: its CI timed out, and ${CI_WATCHED}.`;
      return `nothing unless its author is gone: the train told ${change.taskId ?? "you"} what to fix, and it retries the new head by itself.`;
    case "refused":
    case "abandoned":
      return "fix what it says and enqueue the PR again, or drop it.";
    default:
      return "don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.";
  }
}

const isTrainError = (e: unknown): e is TrainError => typeof e === "object" && e !== null && "code" in e && "message" in e && !(e instanceof Error);

/** `change_enqueue`'s input, as the contracts check it. */
function enqueueCall(call: LeadCall): EnqueueCall {
  const prUrl = call.prUrl;
  if (typeof prUrl !== "string" || !parsePrUrl(prUrl)) throw new ToolError("invalid", "prUrl: expected a PR URL https://github.com/<owner>/<name>/pull/<n>");
  const out: EnqueueCall = { prUrl };
  if (call.taskId != null) {
    if (typeof call.taskId !== "string" || !/^T[1-9]\d*$/.test(call.taskId)) throw new ToolError("invalid", "taskId: expected T<n>");
    out.taskId = call.taskId;
  }
  if (call.workstreamId != null) {
    if (typeof call.workstreamId !== "string" || !/^W[1-9]\d*$/.test(call.workstreamId)) throw new ToolError("invalid", "workstreamId: expected W<n>");
    out.workstreamId = call.workstreamId;
  }
  if (call.after != null) {
    if (!Array.isArray(call.after) || !call.after.every((u) => typeof u === "string" && parsePrUrl(u))) {
      throw new ToolError("invalid", "after: expected PR URLs https://github.com/<owner>/<name>/pull/<n>");
    }
    out.after = call.after as string[];
  }
  return out;
}

/** `change_enqueue`: the Change and what the lead does next. */
export async function changeEnqueue(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  try {
    const change = await trainArea(hub).train.enqueue(caller.projectRef, enqueueCall(call));
    return { change, next: changeNext(change) };
  } catch (error) {
    if (isTrainError(error)) throw toolError(error);
    throw error;
  }
}

/** Registers the train's and the reviews' lead calls. */
export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("change_enqueue", (caller, call) => changeEnqueue(hub, caller, call));
  calls.register("review_verdict", (caller, call) =>
    leadReviewVerdict(hub, { projectRef: caller.projectRef, by: caller.by, ...(caller.agent.kind === "task" ? { task: caller.agent.taskId } : {}) }, call),
  );
  calls.register("review_read", (caller, call) => reviewRead(hub, caller, call as { pr?: unknown }));
}
