// artifacts_list and artifact_get: the chat's Artifacts tab (crates/fleetd/src/hub/artifacts/mod.rs).
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { ofChat } from "../intake/attachments.ts";
import { ARTIFACTS_LISTED, get, list, versions } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("artifacts_list", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    const artifacts = list(hub.db, r);
    return {
      artifacts,
      files: ofChat(hub, r),
      ...(artifacts.length >= ARTIFACTS_LISTED ? { truncated: true } : {}),
    };
  });

  tools.add("artifact_get", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    const found = get(hub.db, r, input.name, input.version);
    if (!found) {
      throw new ToolError(
        "not_found",
        input.version === undefined ? `No artifact ${input.name} here.` : `${input.name} has no version ${input.version}.`,
        "Pick one from the chat's Artifacts.",
      );
    }
    return { name: input.name, artifact: found.artifact, content: found.content, versions: versions(hub.db, r, input.name) };
  });
}
