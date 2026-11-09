// The lead's calls that open and withdraw requests:
// `gated_run`, `request_secret` and `request_withdraw`, through the lead-call registry.
import type { HumanRequest } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { type LeadCaller, leadCalls } from "../lead_calls/index.ts";
import { approvals, GATED_DEFAULT_TIMEOUT_SEC, type GatedRunInput, type RequestSecretCall } from "./index.ts";

const resultOf = (r: HumanRequest, next: string) => ({ requestId: r.requestId, state: r.state, next });

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The workstream a call names must be its caller's project's. */
function checkWorkstream(hub: Hub, caller: LeadCaller, workstreamId: string | undefined): void {
  if (workstreamId === undefined) return;
  const n = /^W([1-9][0-9]{0,9})$/.exec(workstreamId)?.[1];
  const row =
    n === undefined
      ? undefined
      : hub.db.conn
          .query<{ machine_id: string; project_id: string }, [number]>("SELECT machine_id, project_id FROM workstreams WHERE n = ?")
          .get(Number(n));
  if (!row || row.machine_id !== caller.projectRef.machineId || row.project_id !== caller.projectRef.projectId) {
    throw new ToolError(
      "not_found",
      `There is no workstream ${workstreamId} in your project.`,
      "Use a workstream id from the digest at the top of your last wake.",
    );
  }
}

/** The `gated_run` lead call: opens the approval holding exactly the lead's command. */
export async function gatedRunCall(hub: Hub, caller: LeadCaller, call: Record<string, unknown>) {
  const input: GatedRunInput = {
    argv: Array.isArray(call.argv) ? (call.argv as string[]) : [],
    cwd: str(call.cwd),
    class: str(call.class) ?? "",
    reason: str(call.reason) ?? "",
    secretEnv: Array.isArray(call.secretEnv) ? (call.secretEnv as GatedRunInput["secretEnv"]) : undefined,
    timeoutSec: typeof call.timeoutSec === "number" ? call.timeoutSec : GATED_DEFAULT_TIMEOUT_SEC,
    workstreamId: str(call.workstreamId),
  };
  const r = await approvals(hub).gatedRun(caller.projectRef, input);
  return resultOf(
    r,
    "carry on with other work: the person approves or denies it in chat, and the exit code and output tail arrive in a wake.",
  );
}

/** Registers the request calls, checking a named workstream belongs to the caller's project. */
export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("gated_run", async (caller, call) => {
    checkWorkstream(hub, caller, str(call.workstreamId));
    return gatedRunCall(hub, caller, call);
  });
  calls.register("request_secret", async (caller, call) => {
    checkWorkstream(hub, caller, str(call.workstreamId));
    const secret: RequestSecretCall = {
      key: str(call.key) ?? "",
      sink: str(call.sink) ?? "",
      text: str(call.text) ?? "",
      envName: str(call.envName),
      workstreamId: str(call.workstreamId),
    };
    if (!(secret.key.length <= 80 && /^[a-z0-9]+(\.[a-z0-9_-]+)*$/.test(secret.key)) || secret.text.length === 0) {
      throw new ToolError("invalid", "request_secret takes a key (a dotted slug), a sink and a text.");
    }
    const r = await approvals(hub).requestSecret(caller.projectRef, secret);
    return resultOf(r, "carry on: the person enters it in chat, and only its fingerprint arrives in a wake.");
  });
  calls.register("request_withdraw", async (caller, call) => {
    const r = await approvals(hub).withdraw(caller.projectRef, caller.by, str(call.requestId) ?? "");
    return resultOf(r, "withdrawn.");
  });
}
