// The reads lead-call attribution makes, with the Rust hub's SQL: a machine's projects (hub_store.rs
// `projects_list`) and which agent a session is (tasks/wire.rs `Directory::agent_of`, over tasks/records.rs
// `by_thread`, memory/refresh.rs `project_of_thread` and leads/records.rs `leads_list`). Thin stand-ins for the
// store and tasks areas' own reads: swap to `store(hub).projectsList` and the tasks area's directory once they land.
import type { MachineId, ProjectId, ProjectRef, Task, ThreadRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { HubDb } from "../store/db.ts";
import type { CallerAgent } from "./types.ts";

/** What attribution reads of a project: its id and workspace root (a ProjectSummary has both). */
export type WorkspaceProject = { projectId: ProjectId; workspaceRoot: string };

/** Which of fleetd's agents a session is, and the project it works for; throws the refusal. */
export interface Directory {
  agentOf(thread: ThreadRef): { agent: CallerAgent; projectRef: ProjectRef };
}

/** `machineId`'s projects, newest activity first. */
export function projectsOn(hub: Hub, machineId: MachineId): WorkspaceProject[] {
  const rows = hub.db.conn
    .query<{ data: string }, [string]>("SELECT data FROM projects WHERE machine_id = ? ORDER BY last_activity_at DESC")
    .all(machineId);
  return rows.map((row) => JSON.parse(row.data) as WorkspaceProject);
}

const lookupFailed = () =>
  new ToolError("failed", "the hub failed while checking who made this call", "try again shortly");

export function directoryOver(db: HubDb): Directory {
  const one = <R>(sql: string, ...params: string[]): R | null => {
    try {
      return db.conn.query<R, string[]>(sql).get(...params);
    } catch (error) {
      console.error("lead call: agent lookup failed:", error);
      throw lookupFailed();
    }
  };
  const decodeTask = (data: string): Task => {
    try {
      return JSON.parse(data) as Task;
    } catch (error) {
      console.error("lead call: agent lookup failed:", error);
      throw lookupFailed();
    }
  };
  return {
    agentOf(thread) {
      const { machineId, threadId } = thread;
      const task =
        one<{ data: string }>(
          "SELECT data, pending_message FROM tasks WHERE machine_id = ? AND thread_id = ? ORDER BY n DESC LIMIT 1",
          machineId,
          threadId,
        ) ??
        one<{ data: string }>(
          `SELECT t.data, t.pending_message FROM task_threads p JOIN tasks t ON t.n = p.n
             WHERE p.machine_id = ? AND p.thread_id = ?`,
          machineId,
          threadId,
        );
      if (task) {
        const t = decodeTask(task.data);
        return { agent: { kind: "task", taskId: t.taskId }, projectRef: t.projectRef };
      }
      // A nightly memory refresh, whose calls the policy holds to memory.
      const refresh = one<{ project_id: string }>(
        "SELECT project_id FROM memory_refreshes WHERE machine_id = ? AND thread_id = ?",
        machineId,
        threadId,
      );
      if (refresh) return { agent: { kind: "memory_refresh" }, projectRef: { machineId, projectId: refresh.project_id } };
      const lead = one<{ machine_id: string; project_id: string }>(
        "SELECT machine_id, project_id FROM leads WHERE machine_id = ? AND thread_id = ? ORDER BY machine_id, project_id LIMIT 1",
        machineId,
        threadId,
      );
      if (lead) return { agent: { kind: "lead" }, projectRef: { machineId: lead.machine_id, projectId: lead.project_id } };
      throw new ToolError(
        "forbidden",
        `session ${threadId} is neither a project's lead nor a task, so it can't make fleetd's lead calls`,
        "a person runs these commands from their own shell; agents use their fleetd tools",
      );
    },
  };
}
