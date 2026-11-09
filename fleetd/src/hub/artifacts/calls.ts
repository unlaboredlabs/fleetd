// `artifact_publish`, a lead's, task's or Navi's report for the person, and `artifact_read`, one of its own project's
// read back (crates/fleetd/src/hub/artifacts/mod.rs).
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../leads/seams.ts";
import { publish, read } from "./index.ts";

export function registerLeadCalls(hub: Hub): void {
  leadCalls(hub).register("artifact_publish", (caller, call) => {
    if (call.op !== "artifact_publish") throw new ToolError("invalid", `${call.op} is not an artifact call.`);
    return publish(hub, caller, call);
  });
  leadCalls(hub).register("artifact_read", (caller, call) => {
    if (call.op !== "artifact_read") throw new ToolError("invalid", `${call.op} is not an artifact call.`);
    return read(hub, caller, call);
  });
}
