// A task's launch as the hub asks a node for it, without the hub (ports.ts and index.ts make the calls): the request
// and its worktree, the session's workspace, why a start failed, and its request ids.
import type { MachineId, ProjectRef, RepoId, TaskKind, Task, WorkstreamId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { SessionWorkspace } from "../../shared/sessions.ts";
import { ExecutorError } from "../executor/error.ts";
import { parseMs } from "../store/time.ts";

/** How an executor call failed: the machine is not connected, or anything else (ports.rs `PortError`). */
export class PortError extends Error {
  constructor(
    readonly offline: boolean,
    message: string,
  ) {
    super(message);
    this.name = "PortError";
  }

  static offline(machineId: MachineId): PortError {
    return new PortError(true, `machine ${machineId} is not connected`);
  }

  /** The refusal a lead's call answers with. */
  toToolError(machineId: MachineId): ToolError {
    return this.offline
      ? new ToolError(
          "machine_offline",
          `Machine ${machineId} has no live node link.`,
          "Wait for the machine to come back online (fleetd_status shows it), then retry.",
        )
      : new ToolError("failed", this.message, "Retry; if it keeps failing, check the machine with fleetd_status.");
  }
}

/** Any error from the executor as a port's: not connected is offline (wire.rs `port_error`). */
export function portError(error: unknown): PortError {
  if (error instanceof PortError) return error;
  if (error instanceof ExecutorError && error.kind === "not_connected") return new PortError(true, error.message);
  return new PortError(false, error instanceof Error ? error.message : String(error));
}

/** A task's thread launch (runtime mode full-access). */
export type LaunchRequest = {
  /** The node checkout it runs in: the project's own directory, or its repo's (W79). */
  projectId: string;
  /** The task's project and repo, whose setup commands a new worktree runs. */
  projectRef: ProjectRef;
  repoId?: RepoId;
  prompt: string;
  /** Its brief's rules and the human's custom instructions and memory. */
  systemPrompt?: string;
  profile: string;
  title: string;
  clientRequestId: string;
  /** Which MCP servers its agent gets: a writer's, or a reviewer's for a read or review task. */
  kind: TaskKind;
  /** Write tasks: on its branch; read and review tasks: detached (`branch` undefined). */
  worktree?: Worktree;
  /** The task's order: its session gets the variables delivered for it. */
  orderId?: WorkstreamId;
};

export type Worktree = {
  baseRef: string;
  /** Undefined: a detached worktree, for a read or review task. */
  branch?: string;
  /** A review's PR, whose head its detached worktree is at. */
  pr?: string;
  /** The task's earlier thread, whose worktree a fresh restart takes over. */
  from?: string;
};

/** The session's workspace for a task's worktree; `headOf` gives the head a review's PR is at, when known. */
export function workspaceOf(w: Worktree, headOf: (pr: string) => string | undefined): SessionWorkspace {
  if (w.baseRef === "") throw new PortError(false, "a worktree needs a base ref");
  if (w.branch !== undefined) {
    if (w.branch === "") throw new PortError(false, "a worktree needs a branch");
    return { type: "worktree", baseRef: w.baseRef, branch: w.branch, ...(w.from !== undefined ? { fromSession: w.from } : {}) };
  }
  const pr = w.pr !== undefined && w.pr !== "" ? w.pr : undefined;
  const head = pr !== undefined ? headOf(pr) : undefined;
  return { type: "detached", baseRef: w.baseRef, ...(pr !== undefined ? { pr } : {}), ...(head ? { head } : {}) };
}

/** Why a launch or continuation did not go out: the machine went offline (the task queues), or anything else. */
export class StartError extends Error {
  constructor(
    readonly offline: boolean,
    message: string,
  ) {
    super(message);
  }
  static of(error: unknown): StartError {
    if (error instanceof StartError) return error;
    if (error instanceof PortError) return new StartError(error.offline, error.message);
    // The policy read at launch: a node gone since the start's check queues the task, like the launch itself.
    if (error instanceof ToolError) return new StartError(error.code === "machine_offline", error.message);
    return new StartError(false, error instanceof Error ? error.message : String(error));
  }
}

/** A request id for one of the task's writes; it carries the task's creation time (a fresh database numbers from T1). */
export function requestId(task: Task, parts: string[]): string {
  const created = parseMs(task.createdAt);
  return ["fleetd-task", task.taskId, created === undefined ? "NaN" : String(created), ...parts].join(":");
}


/** A start's text with the message that waited for it after, when one did. */
export const withPending = (text: string | undefined, pending: string | undefined) =>
  [text, pending].filter((t): t is string => t !== undefined).join("\n\n");
