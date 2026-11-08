// The projects area's tools (crates/fleetd/src/hub/projects/tools.rs and the modules it registers): profiles, the
// icon and picture so far. project_discover, project_add, project_remove, settings and repos come with their ports.
import { requireRole } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import * as avatar from "./avatar.ts";
import * as icon from "./icon.ts";
import * as lifecycle from "./lifecycle.ts";
import * as profiles from "./profiles.ts";
import * as settings from "./settings.ts";

export function register(tools: Registry): void {
  profiles.register(tools);
  lifecycle.register(tools);
  settings.register(tools);
  tools.add("project_icon_set", (hub, caller, input) => {
    const r = { machineId: input.machineId, projectId: input.projectId };
    requireRole(caller, "operate", r.machineId);
    return { project: icon.set(hub, r, input.icon) };
  });
  tools.add("project_avatar_set", (hub, caller, input) => avatar.set(hub, caller, input));
  tools.add("project_avatar_get", (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    return avatar.get(hub.db.conn, { machineId: input.machineId, projectId: input.projectId });
  });
}
