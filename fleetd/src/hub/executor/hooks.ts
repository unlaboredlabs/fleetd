// Where later areas plug into the executor's tools: leads,
// workstreams, tasks and trains add fields to project_get, the slot board to fleetd_status.
import type { ProjectRef } from "../../shared/contracts.ts";
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

export class ToolHooks {
  readonly project: ProjectHook[] = [];
  readonly status: StatusHook[] = [];
  readonly prFound: PrFoundHook[] = [];

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
