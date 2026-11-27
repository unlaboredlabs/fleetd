// The workspace calls behind an agent's page on the phone, as the desktop makes them: its row (agents_list), its record
// once it ended (task_get), its steps a page at a time (agent_work), its screens (browser_sessions), and Stop
// (task_stop) and Steer (steer_send), with the phone's paired key, which the workspace takes as the person's.
import type { AgentRow, BrowserSession, ProjectRef, Task, ThreadRef, WorkStep } from "../../desktop";
import type { Hub, Result } from "../manage/api";

/** Steps a page reads; earlier ones a page at a time. */
export const STEP_PAGE = 40;

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

export const readRow = async (hub: Hub, p: ProjectRef, laneId: string): Promise<Result<AgentRow | undefined>> => {
  const r = await hub.call("agents_list", { projectRef: ref(p) });
  return r.ok ? { ok: true, value: r.output.agents.find((a) => a.laneId === laneId) } : r;
};

export const readTask = async (hub: Hub, taskId: string): Promise<Result<Task>> => {
  const r = await hub.call("task_get", { taskId });
  return r.ok ? { ok: true, value: r.output.task } : r;
};

/** A page of its steps, oldest first, and the cursor for the page before it. */
export const readSteps = async (hub: Hub, thread: ThreadRef, before?: string): Promise<Result<{ steps: WorkStep[]; before?: string | undefined }>> => {
  const r = await hub.call("agent_work", { machineId: thread.machineId, threadId: thread.threadId, limit: STEP_PAGE, ...(before === undefined ? {} : { before }) });
  return r.ok ? { ok: true, value: { steps: r.output.steps, before: r.output.before } } : r;
};

/** Its screens, newest first. */
export const readScreens = async (hub: Hub, p: ProjectRef, taskId: string): Promise<Result<BrowserSession[]>> => {
  const r = await hub.call("browser_sessions", { projectRef: ref(p) });
  return r.ok ? { ok: true, value: r.output.sessions.filter((s) => s.taskId === taskId) } : r;
};

export const stopAgent = async (hub: Hub, taskId: string): Promise<Result<Task>> => {
  const r = await hub.call("task_stop", { taskId });
  return r.ok ? { ok: true, value: r.output.task } : r;
};

/** A steer it reads at its next step. */
export const steerAgent = async (hub: Hub, taskId: string, text: string, clientRequestId: string): Promise<Result<true>> => {
  const r = await hub.call("steer_send", { target: { taskId }, text, mode: "queue", clientRequestId });
  return r.ok ? { ok: true, value: true } : r;
};
