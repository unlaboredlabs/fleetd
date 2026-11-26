// `audit_list`: the workspace's audit log, newest first, a page at a time, for an owner's or admin's device only
// (Settings › Workspace › Audit log, `fleetd audit`). A member's device and every other key are refused. Also adds the
// registry's observer that writes the rows of tool calls (record.ts).
import { ToolError } from "../../shared/errors.ts";
import { settingsPath } from "../../shared/settings_path.ts";
import type { Registry } from "../api/registry.ts";
import { administrator } from "../people/tools.ts";
import { observeCall } from "./record.ts";
import { auditLog } from "./store.ts";

export function register(tools: Registry): void {
  tools.observe(observeCall);
  tools.add("audit_list", (hub, caller, input) => {
    if (!administrator(hub, caller)) {
      throw new ToolError(
        "forbidden",
        "Only the workspace's owners and admins see its audit log.",
        `Ask an owner or admin of the workspace: it is in the app's ${settingsPath("Audit log")}, and \`fleetd audit\` on the workspace's machine.`,
      );
    }
    for (const [name, at] of [
      ["since", input.since],
      ["until", input.until],
    ] as const) {
      if (at !== undefined && Number.isNaN(Date.parse(at))) throw new ToolError("invalid", `${name} is a time, like 2026-11-26T12:00:00Z.`);
    }
    return auditLog(hub).list(input);
  });
}
