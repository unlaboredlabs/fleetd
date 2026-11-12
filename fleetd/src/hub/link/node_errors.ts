// A node that can't be reached, and a session call's failure, in a tool's words (node_port.ts sends the calls).
import { ToolError } from "../../shared/errors.ts";
import { ExecutorError } from "../executor/error.ts";

/** api/grants.rs `offline`. */
export const offline = (m: string) =>
  new ToolError("machine_offline", `Machine ${m} is offline.`, `Start the node on ${m} or check its network, then retry.`);

/** executor/tools.rs `from_executor`: an executor failure as the tool's error. */
export function fromExecutor(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const fix = "Retry; if it keeps failing, check the machine with fleetd_status.";
  if (e instanceof ExecutorError) return e.kind === "not_connected" ? offline(e.machineId) : new ToolError("failed", e.message, e.extra.fix ?? fix);
  return new ToolError("failed", e instanceof Error ? e.message : String(e), fix);
}
