// The task lead calls (crates/fleetd/src/hub/tasks/wire.rs `Calls`, tools.rs `lead_call`): the lead's spawn_agent,
// agents, message_agent and stop_agent, and a task's own ask_lead, brief_read and wait_ci.
import type { ProjectRef, Task, TaskState } from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { check } from "../lead_calls/policy.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/types.ts";
import { line as baseLine } from "./base.ts";
import { openCiWaits, waitCi, waitsNote } from "./ci_wait.ts";
import { type SpawnInput, type Tasks, tasks as tasksOf } from "./index.ts";

const TASK_LIST_LIMIT = 50;

export const LEAD_CALL_OPS = ["task_spawn", "task_list", "task_message", "task_cancel", "ask_lead", "brief_read", "wait_ci"] as const;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** What a task's `repoId` names, when the project has several repos: `Repos: R1 api, R4 web.` */
function reposLine(t: Tasks, r: ProjectRef): string | undefined {
  const repos = t.reposOf(r);
  return repos.length > 1 ? `Repos: ${repos.map((repo) => `${repo.repoId} ${repo.name}`).join(", ")}.` : undefined;
}

/** `agents`' next: the project's repos, and each done task's open waits, so the lead leaves its wake to wait_ci. */
function listNext(hub: Hub, t: Tasks, r: ProjectRef, listed: Task[]): string | undefined {
  const open = openCiWaits(hub.db.conn);
  const waits = listed.filter((x) => x.state === "done").flatMap((x) => {
    const urls = open.get(x.taskId);
    return urls ? [waitsNote(x.taskId, urls)] : [];
  });
  const parts = [reposLine(t, r), ...waits].filter((p): p is string => p !== undefined);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** The policy's refusal of a task's own call from no task (the registry checked it already; this is its fallback). */
function refusedFor(agent: LeadCaller["agent"], op: string): never {
  check(agent, op);
  throw new ToolError("forbidden", `${op} comes from a task's own session.`);
}

const frame = (task: Task, next?: string) => ({ task, ...(next !== undefined ? { next } : {}) });

const internal = (error: unknown) => {
  if (error instanceof ToolError) return error;
  console.error("task lead call failed:", error);
  return internalError();
};

/** One task lead call, attributed: the result without its `op`. */
export async function leadCall(hub: Hub, t: Tasks, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  const agent = caller.agent;
  const c = call as Record<string, unknown>;
  switch (call.op) {
    case "ask_lead": {
      if (agent.kind !== "task") return refusedFor(agent, "ask_lead");
      const task = t.askLead(agent.taskId, String(c.question));
      return {
        taskId: task.taskId,
        next: "Asked. Carry on with what you can; your lead's answer arrives as a message. If you can't go on without it, end your turn with what you have: the answer continues this thread.",
      };
    }
    case "brief_read":
      if (agent.kind !== "task") return refusedFor(agent, "brief_read");
      return t.briefRead(agent.taskId);
    case "wait_ci":
      if (agent.kind !== "task") return refusedFor(agent, "wait_ci");
      try {
        return waitCi(t, hub.db.conn, hub.clock.now(), agent.taskId, String(c.url));
      } catch (error) {
        throw internal(error);
      }
  }
  const lead = { projectRef: caller.projectRef, by: caller.by };
  const r = lead.projectRef;
  switch (call.op) {
    case "task_spawn": {
      const { op: _op, ...input } = c;
      const spawn = input as unknown as SpawnInput;
      const asked = spawn.profile;
      const spawned = await t.spawnNoted(lead, spawn);
      const task = spawned.task;
      const based = task.base ? `Its worktree is ${baseLine(task.base, t.nowIso())}.` : undefined;
      const also = await t.alsoWriting(task, spawned.observed);
      // With several repos, which one it works in.
      const repos = t.reposOf(r);
      const repo = repos.length > 1 ? repos.find((x) => x.repoId === task.repoId) : undefined;
      const parts = [repo ? `It works in repo ${repo.name}.` : undefined, based, t.queuedNext(task), also, spawned.note].filter(
        (p): p is string => p !== undefined,
      );
      let next = parts.length > 0 ? parts.join(" ") : undefined;
      if (asked !== undefined && asked !== task.profile) {
        const why = `It runs on ${task.profile}, the default: reviews always do.`;
        next = next !== undefined ? `${why} ${next}` : why;
      }
      return frame(task, next);
    }
    case "task_list": {
      try {
        if (typeof c.taskId === "string") {
          const task = t.get(c.taskId);
          if (!task || !sameProject(task.projectRef, r)) {
            throw new ToolError("not_found", `There is no task ${c.taskId} in your project.`, "Call `agents` without taskId.");
          }
          const next = listNext(hub, t, r, [task]);
          return { tasks: [task], ...(next !== undefined ? { next } : {}) };
        }
        const listed = t.list({
          projectRef: r,
          ...(typeof c.state === "string" ? { state: c.state as TaskState } : {}),
          ...(typeof c.workstreamId === "string" ? { workstreamId: c.workstreamId } : {}),
          limit: TASK_LIST_LIMIT + 1,
        });
        const truncated = listed.length > TASK_LIST_LIMIT;
        const shown = listed.slice(0, TASK_LIST_LIMIT);
        const next = listNext(hub, t, r, shown);
        return { tasks: shown, ...(truncated ? { truncated: true } : {}), ...(next !== undefined ? { next } : {}) };
      } catch (error) {
        throw internal(error);
      }
    }
    case "task_message":
      return frame(await t.message(lead, String(c.taskId), String(c.message)));
    case "task_cancel":
      return frame(await t.cancel(lead, String(c.taskId), typeof c.reason === "string" ? c.reason : undefined));
    default:
      throw new ToolError("invalid", "Not a task call.", "Use spawn_agent, agents, message_agent or stop_agent.");
  }
}

/** Registers the task lead calls on the hub's registry (wire.rs `register_lead_calls`). */
export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  for (const op of LEAD_CALL_OPS) {
    // The steer area's `task_message` goes through its steers, as the Rust hub's steer::wire replaces this one.
    if (op === "task_message" && calls.handler(op)) continue;
    calls.register(op, (caller, call) => leadCall(hub, tasksOf(hub), caller, call));
  }
}
