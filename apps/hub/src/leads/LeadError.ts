import { ErrorCode } from "@fleetd/contracts";
import * as Schema from "effect/Schema";
import type * as Executors from "../executor/Executors.ts";

/** A refusal in the `{ code, message, fix }` shape of McpToolError, for MCP tools and lead-side calls alike. */
export class LeadError extends Schema.TaggedError<LeadError>()("LeadError", {
  code: ErrorCode,
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
}) {}

export const fromExecutor = (error: Executors.ExecutorError) =>
  error._tag === "MachineNotConnected"
    ? new LeadError({
        code: "machine_offline",
        message: `Machine ${error.machineId} has no live T3 connection.`,
        fix: "Wait for the machine to come back online (fleetd_status shows it), then retry.",
      })
    : new LeadError({ code: "t3_error", message: error.message, fix: "Retry; if it keeps failing, check the machine's T3 with fleetd_status." });
