// Who may start and steer agents: enforced on every lead call by the hub,
// whatever a prompt says or a tool list offers. A lead is depth 0 and its tasks depth 1; nothing goes deeper, so a
// task's agent never starts another agent. A lead has at most `maxOpenTasks` tasks open at once.
import { ToolError } from "../../shared/errors.ts";
import type { CallerAgent, LeadCall } from "./types.ts";

/** A lead's tasks are depth 1; a call that would start an agent below that is refused. */
export const MAX_DEPTH = 1;
/** Open (queued, running or idle) tasks per project, the fan-out of its one lead, at least. */
export const MAX_OPEN_TASKS = 32;

/** The open tasks a project's lead may have: MAX_OPEN_TASKS, or twice its max agents on a machine that runs more. */
export const maxOpenTasks = (maxAgents: number) => Math.max(MAX_OPEN_TASKS, 2 * Math.max(maxAgents, 0));

/** The calls a task's agent makes. Only a lead closes work. */
export const WORKER_OPS: readonly string[] = [
  "review_verdict",
  "ask_lead",
  "task_list",
  "agent_message",
  "brief_read",
  "decisions_search",
  "review_read",
  "wait_ci",
  "chat_file",
  "artifact_publish",
  "artifact_read",
  "vault_items",
];
/** The calls a task's node makes for it: its browser sessions (node/browser), and a project's purchases in them. */
export const NODE_OPS: readonly string[] = [
  "browser_session",
  "browser_recording_part",
  "browser_takeover",
  "purchase_open",
  "purchase_claim",
  "purchase_filled",
  "secure_input_open",
  "secure_input_claim",
  "secure_input_filled",
  "vault_fill",
  "vault_filled",
  "vault_items",
  "session_route",
  "session_step",
  "mac_where",
  "mac_send",
];
/** The calls that start an agent. */
export const SPAWN_OPS: readonly string[] = ["task_spawn"];
/** The only calls of a nightly memory refresh's session (hub/memory/refresh). */
export const MEMORY_REFRESH_OPS: readonly string[] = ["memory_read", "remember", "forget"];

export const depth = (agent: CallerAgent) => (agent.kind === "task" ? 1 : 0);

/** Whether `agent` may make the call `op`; the refusal's `fix` says why and what to do instead. Throws the refusal. */
export function check(agent: CallerAgent, op: string): void {
  switch (agent.kind) {
    case "task": {
      const task = agent.taskId;
      if (SPAWN_OPS.includes(op) && depth(agent) + 1 > MAX_DEPTH) {
        throw new ToolError(
          "forbidden",
          `${task} is a task, and a task's agent can't start agents: fleetd runs one level, a lead and its tasks.`,
          "Do this work yourself. If it is too big for one task, say so with ask_lead: your lead decides whether to split it.",
        );
      }
      if (!WORKER_OPS.includes(op) && !NODE_OPS.includes(op)) {
        throw new ToolError(
          "forbidden",
          `${op} is a lead's call, and ${task} is a task.`,
          "A task reports its review verdict (report), asks its lead (ask_lead), reads its brief (brief_read), " +
            "decisions (decisions_search), its PRs' reviews (review_read) and its project's agents (agents), writes to another agent (agent_message), and may upload an image or file for your " +
            "lead to show (chat_file), publish a report (publish_artifact), read one of your project's (artifact_read) or " +
            "wait on CI (wait_ci). Put anything else in your result or ask your lead.",
        );
      }
      return;
    }
    case "memory_refresh":
      if (!MEMORY_REFRESH_OPS.includes(op)) {
        throw new ToolError(
          "forbidden",
          `${op} isn't a call of the nightly memory refresh, which only reads and writes memory.`,
          "Use memory_read, remember and forget only, then end your turn.",
        );
      }
      return;
    case "person":
    case "lead":
      if (op === "ask_lead") {
        throw new ToolError(
          "invalid",
          "ask_lead is a task's question for its lead, and this call comes from no task.",
          "A lead asks the human with ask.",
        );
      }
      // A verdict binds the train's review of the lead's own work: only the review task records it.
      if (agent.kind === "lead" && op === "review_verdict") {
        throw new ToolError(
          "forbidden",
          "review_verdict is a review task's own verdict, and a lead records none: the train's review checks the " +
            "lead's own work.",
          "Let the review task report its verdict. To act on its findings, have a writer fix them, or resolve them " +
            "with change_enqueue.",
        );
      }
      if (op === "brief_read") {
        throw new ToolError(
          "invalid",
          "brief_read reads a task's own brief, and this call comes from no task.",
          "A lead reads its workstreams' briefs in its state block.",
        );
      }
      if (op === "wait_ci") {
        throw new ToolError(
          "invalid",
          "wait_ci wakes the task that asked, and this call comes from no task.",
          "A lead hears of its PRs' CI from the train; to watch another run, spawn a read task that waits on it.",
        );
      }
      if (op === "agent_message") {
        throw new ToolError(
          "invalid",
          "agent_message is one agent's message to another, and this call comes from no task.",
          "A lead steers its agents with message_agent.",
        );
      }
  }
}

/** `check`, and what only the call itself says. */
export function checkCall(agent: CallerAgent, call: LeadCall): void {
  check(agent, call.op);
  // The refresh adds to a person's own memory, but never changes or removes what is there.
  const userMdChanged =
    (call.op === "remember" && call.scope === "user" && call.replaces != null) ||
    (call.op === "forget" && call.scope === "user");
  if (agent.kind === "memory_refresh" && userMdChanged) {
    throw new ToolError(
      "forbidden",
      "The nightly refresh only adds to user memory: it never replaces or removes an entry there.",
      "Add the lesson as a new user memory entry, or leave user memory as it is.",
    );
  }
}

/** A spawn with `open` tasks already open in the project, whose max agents is `maxAgents`. */
export function checkFanOut(open: number, maxAgents: number): void {
  const most = maxOpenTasks(maxAgents);
  if (open < most) return;
  throw new ToolError(
    "forbidden",
    `This project already has ${open} open tasks, the most one lead may have at once (${most}).`,
    "End your turn: results arrive in wakes and free room. Or stop a task you no longer need with stop_agent.",
  );
}
