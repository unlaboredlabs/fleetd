// status_get: the projects' rows, or one project's row.
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { status } from "./index.ts";

const unread = (error: unknown) => new ToolError("failed", `The status rows were not read: ${(error as Error).message ?? error}`);

export function register(tools: Registry): void {
  tools.add("status_get", (hub, caller, input) => {
    const r = input.projectRef;
    if (!r) {
      let rows;
      try {
        rows = status(hub).projectRows(caller);
      } catch (error) {
        throw unread(error);
      }
      return { rows: rows.slice(0, 200), ...(rows.length > 200 ? { truncated: true } : {}) };
    }
    requireRole(caller, "read", r.machineId);
    let row;
    try {
      row = status(hub).project(caller, r);
    } catch (error) {
      throw unread(error);
    }
    if (!row) {
      throw new ToolError("not_found", `There is no project ${r.machineId}/${r.projectId}.`, "status_get without a projectRef lists them.");
    }
    return { row };
  });
}
