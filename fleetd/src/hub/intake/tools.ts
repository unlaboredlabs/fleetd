// attachment_part, attachment_put, attachment_get and project_files (crates/fleetd/src/hub/orders/tools.rs's handlers,
// which call into hub/intake). The contracts file them under hub/orders, whose tools.ts calls this `register`.
import type { Registry } from "../api/registry.ts";
import { requireRole } from "../api/grants.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { get, part, put } from "./attachments.ts";

/** A JS string's first `n` UTF-16 units, as js_take cuts the query the node gets. */
const jsTake = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

export function register(tools: Registry): void {
  tools.add("attachment_part", (hub, caller, input) => part(hub, caller, input));
  tools.add("attachment_put", (hub, caller, input) => put(hub, caller, input));
  tools.add("attachment_get", (hub, caller, input) => get(hub, caller, input));
  tools.add("project_files", async (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    let out;
    try {
      out = await executors(hub).call(
        input.machineId,
        "read",
        { op: "list_files", projectId: input.projectId, query: jsTake(input.query ?? "", 200), limit: Math.min(50, Math.max(1, input.limit ?? 20)) },
        15_000,
      );
    } catch (error) {
      throw fromExecutor(error);
    }
    if (out.kind !== "files") throw fromExecutor(ExecutorError.failed(input.machineId, "read", "the node sent no file list"));
    const paths = out.paths.filter((p) => p.length >= 1 && p.length <= 1000).slice(0, 50);
    return { paths, ...(out.truncated ? { truncated: true } : {}) };
  });
}
