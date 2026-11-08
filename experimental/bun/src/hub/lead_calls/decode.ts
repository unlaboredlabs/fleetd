// A node's lead_call frame decoded before anything acts on it, as the Rust link's serde decode of `LeadCallFrame`
// does: the call against its contract (schema/LeadCall.json, through src/hub/api/decode.ts: types, bounds, brand
// patterns, defaults, unnamed fields dropped), then the `checked!` rules crates/fleetd-contracts/src/lead_calls.rs
// adds to its own calls. The Rust hub closes a link whose frame doesn't decode; the Bun hub answers that one call
// `invalid` instead, so the node hears why.
import { DecodeError, decodeLeadCall } from "../api/decode.ts";
import { clip } from "../mcp/endpoint.ts";
import { ToolError } from "../../shared/errors.ts";
import type { LeadCall, LeadCallFrame } from "./types.ts";

/** `checked!` on BriefCreateCall, RequestSecretCall and TaskSpawnCall: what the schema can't say. */
function rules(call: Record<string, unknown>): string | undefined {
  switch (call.op) {
    case "brief_create":
      if (call.workstreamId === undefined && call.text === undefined) {
        return "give workstreamId to brief an open workstream, or text to open one";
      }
      if (call.workstreamId !== undefined && call.text !== undefined) return "text opens a workstream; leave it out with workstreamId";
      return undefined;
    case "request_secret": {
      const sink = String(call.sink);
      if (call.envName !== undefined && !sink.startsWith("env:") && !sink.startsWith("order:")) {
        return "only an env: or order: sink has an env name";
      }
      return undefined;
    }
    case "task_spawn":
      // tasks.rs `task_spawn_rule`.
      if (call.kind === "review" && call.pr === undefined) return "a review task needs --pr <PR URL>";
      if (call.qa === true && call.kind !== "review") return "--qa applies only to --kind review";
      if (call.notDuplicateOf !== undefined && call.notDuplicateWhy === undefined) {
        return "notDuplicateOf needs notDuplicateWhy: one line on why it is different work";
      }
      return undefined;
    default:
      return undefined;
  }
}

const refuse = (detail: string) =>
  new ToolError(
    "invalid",
    clip(`Invalid lead call: ${detail}`, 1000),
    "Send the call as its contract has it (crates/fleetd-contracts/src/lead_calls.rs); a node on another fleetd than the hub's may need updating.",
  );

/** `frame` with its call decoded; throws the `invalid` refusal. */
export function decodeFrame(frame: LeadCallFrame): LeadCallFrame {
  if (typeof frame.cwd !== "string" || !frame.cwd.startsWith("/")) throw refuse("cwd must be an absolute path");
  if (frame.threadId !== undefined && frame.threadId !== null && typeof frame.threadId !== "string") {
    throw refuse("threadId must be a string");
  }
  let call: Record<string, unknown>;
  try {
    call = decodeLeadCall(frame.call) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DecodeError) throw refuse(error.message);
    throw error;
  }
  const broken = rules(call);
  if (broken) throw refuse(broken);
  const decoded: LeadCallFrame = { id: frame.id, cwd: frame.cwd, call: call as LeadCall };
  if (typeof frame.threadId === "string") decoded.threadId = frame.threadId;
  return decoded;
}
