// `changes_list`.
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { intOr, optionalProjectRef, optionalRepo, optionalState } from "./input.ts";
import { ChangeRecords } from "./records.ts";
import { cap } from "./seams.ts";

/** The train's `{ code, message, fix }` as a tool error. */
export type TrainError = { code: string; message: string; fix?: string };

export function toolError(e: TrainError): ToolError {
  const code = e.code === "not_found" ? "not_found" : e.code === "unavailable" ? "failed" : "invalid";
  return new ToolError(code, e.message, e.fix);
}

export function register(tools: Registry): void {
  tools.add("changes_list", async (hub, caller, raw) => {
    const input = raw as Record<string, unknown>;
    const projectRef = optionalProjectRef(input, "projectRef");
    const repo = optionalRepo(input, "repo");
    const state = optionalState(input, "state");
    const limit = intOr(input, "limit", 1, 100, 50);
    if (projectRef) requireRole(caller, "read", projectRef.machineId);
    const records = new ChangeRecords(hub.db);
    const all = records
      .positioned(records.list({
        limit: projectRef ? limit + 1 : 1000,
        ...(projectRef ? { projectRef } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(state !== undefined ? { state } : {}),
      }))
      .filter((c) => allows(caller, "read", c.projectRef.machineId));
    const shown = cap(all, limit);
    const next = shown.truncated ? "Narrow the list with projectRef, repo or state." : "Only the train merges; events_wait for pr.merged.";
    return { changes: shown.items, next, ...(shown.truncated ? { truncated: true } : {}) };
  });
}
