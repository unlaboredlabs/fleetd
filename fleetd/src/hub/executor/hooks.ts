// Where later areas plug into the executor's tools: leads,
// workstreams, tasks and trains add fields to project_get, the slot board to fleetd_status.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { McpStartChange } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";

/** What an area adds to one project's project_get outcome. */
export type ProjectExtra = {
  /** Merged into the outcome (`lead`, `workstreams`, `taskCounts`, `tasks`, `trains`). */
  fields: Record<string, unknown>;
  /** Threads that show elsewhere (task threads show only as tasks), left out of `threads`. */
  excludeThreads?: Set<string>;
  truncated?: boolean;
};

export type ProjectHook = (hub: Hub, r: ProjectRef) => Promise<ProjectExtra> | ProjectExtra;
export type StatusHook = (hub: Hub, caller: Caller) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** A session's finished command named a GitHub PR (executor/mod.rs `pr_sink`). */
export type PrFoundHook = (thread: { machineId: string; threadId: string }) => void;

/** A session's computer went to sleep or woke (its summary's `asleep`), with no change of status to say so. */
export type AsleepHook = (thread: { machineId: string; threadId: string; projectId: string }) => void;

/** What a session's start changed of the MCP servers left out because they didn't answer (its summary's `mcpChange`,
 * node/mcp_reach.ts): told once per start, as its summary first says so, never again for that start's fields carried on. */
export type McpSkippedHook = (thread: { machineId: string; threadId: string }, change: McpStartChange, at: string | undefined) => void;

export class ToolHooks {
  readonly project: ProjectHook[] = [];
  readonly status: StatusHook[] = [];
  readonly prFound: PrFoundHook[] = [];
  readonly asleep: AsleepHook[] = [];
  readonly mcpSkipped: McpSkippedHook[] = [];

  /** Told when a session's start left MCP servers out: a lead's chat says which. */
  onMcpSkipped(hook: McpSkippedHook): void {
    this.mcpSkipped.push(hook);
  }

  /** Each `onMcpSkipped` hook, a throwing one logged. */
  skippedMcp(thread: { machineId: string; threadId: string }, change: McpStartChange, at: string | undefined): void {
    for (const hook of this.mcpSkipped) {
      try {
        hook(thread, change, at);
      } catch (error) {
        console.warn("executor: an MCP skipped hook failed:", error);
      }
    }
  }

  /** Told when a session's computer goes to sleep or wakes: the chat says so in its state. */
  onAsleep(hook: AsleepHook): void {
    this.asleep.push(hook);
  }

  /** Each `onAsleep` hook, a throwing one logged. */
  sleptOrWoke(thread: { machineId: string; threadId: string; projectId: string }): void {
    for (const hook of this.asleep) {
      try {
        hook(thread);
      } catch (error) {
        console.warn("executor: an asleep hook failed:", error);
      }
    }
  }

  /** Told when a session's finished command printed a GitHub PR URL (`gh pr create`): the train reads it at once. */
  onPrFound(hook: PrFoundHook): void {
    this.prFound.push(hook);
  }

  /** Each `onPrFound` hook, a throwing one logged. */
  foundPr(thread: { machineId: string; threadId: string }): void {
    for (const hook of this.prFound) {
      try {
        hook(thread);
      } catch (error) {
        console.warn("executor: a PR hook failed:", error);
      }
    }
  }

  /** Adds fields to project_get (leads, workstreams, tasks, trains). */
  extendProjectGet(hook: ProjectHook): void {
    this.project.push(hook);
  }

  /** Adds fields to fleetd_status (the slot board, filtered to the caller's machines). */
  extendStatus(hook: StatusHook): void {
    this.status.push(hook);
  }
}

/** The hub's executor hooks, `hub.area("executor_hooks")`: areas add theirs when they start. */
export const executorHooks = (hub: Hub) => hub.area("executor_hooks", () => new ToolHooks());
