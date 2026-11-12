// What erasing a project deletes, by table, and the guard that keeps a hub-wide key from being erased as a project's
// (erase.ts deletes).
import type { ProjectRef } from "../../shared/contracts.ts";

/** Tables with the project's rows by `machine_id` and `project_id`. */
export const BY_PROJECT = [
  "chat_messages", "chat_projects", "checklists", "leads", "lead_mcp", "approval_checks", "memory_imports",
  "memory_refreshes", "memory_refresh_lines", "project_auto_approved", "project_approvals", "project_sites", "skill_versions",
  "skill_uses", "browser_sessions", "screen_waits", "session_prompts", "tasks", "slot_claims", "workstreams", "hub_links",
];

/** Tables with rows of the project's sessions, by `machine_id` and `thread_id`. */
export const BY_THREAD = ["threads", "wakes", "queued_writes", "steers", "thread_accounts", "task_threads", "time_lead_runs", "time_wakes"];

/** Tables with the project's rows by `project_key` (`<machine>/<project>`). */
export const BY_KEY = ["requests", "legacy_asks", "decisions"];

/**
 * A hub-wide row's key, which no project has: a hub-wide MCP server's and skill's are an empty machine and project.
 * Erasing it as a project's would delete every hub-wide server and skill.
 */
export const hubWide = (machineId: string, projectId: string) => machineId === "" || projectId === "";

/** Refuses a hub-wide key where a project's is meant. */
export function aProject(r: ProjectRef): void {
  if (hubWide(r.machineId, r.projectId)) {
    throw new Error("an empty machine or project id is the hub's own, not a project's: nothing was erased");
  }
}
