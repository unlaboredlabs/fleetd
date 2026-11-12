// The executor's waits and pure rules, with no node link behind them (index.ts makes the calls, tools.ts answers them).
import type { MachineId, ThreadId } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { SessionError, ThreadItem } from "../../shared/sessions.ts";
import { offline, unknownThread } from "../api/refusals.ts";
import { ExecutorError, type NodeOperation } from "./error.ts";

/** A finished command whose output holds a GitHub pull URL, such as `gh pr create`'s (executor/mod.rs `names_a_pr`). */
export function namesAPr(item: { status: string; kind: { type: string; output?: string } }): boolean {
  const output = item.kind.type === "command" ? item.kind.output : undefined;
  return item.status === "completed" && output !== undefined && output.includes("github.com/") && output.includes("/pull/");
}
/** Resubscribe delay: doubles from 1 s to a 30 s cap, ±25 % jitter so machines don't retry in step. */
export function backoffMs(attempt: number, random: number): number {
  const base = 1000 * 2 ** Math.min(attempt, 5) * (0.75 + random * 0.5);
  return Math.min(Math.round(base), 30_000);
}

export const WATCH_IDLE_MS = 60_000;
export const READ_TIMEOUT_MS = 15_000;
/** A launch may create a worktree and spawn claude before the node answers. */
export const LAUNCH_TIMEOUT_MS = 60_000;
/** The node first stops the project's claude processes, then removes its worktrees and a project's sign-ins. */
export const REMOVE_TIMEOUT_MS = 70_000;
/** How long a launch or a send waits on a node that is up but busy (swapping, loaded) before it fails: `callPatient`. */
export const PATIENCE_MS = 120_000;
/** The node's stop waits up to 25 s for claude to exit. */
export const STOP_TIMEOUT_MS = 40_000;
/** The node keeps the last 2000 characters of the assistant's text on the summary. */
export const SUMMARY_TAIL_MAX = 2000;

export function fromSessionError(machineId: MachineId, operation: NodeOperation, session: ThreadId | undefined, error: SessionError): ExecutorError {
  if (error.code === "not_found" && session !== undefined && operation !== "answer" && operation !== "launch") {
    return ExecutorError.threadNotFound(machineId, session);
  }
  return ExecutorError.failed(machineId, operation, error.message, error.fix);
}

/** The skill a finished Skill call ran, as the session lists it. */
export function skillRan(item: ThreadItem): string | undefined {
  if (item.kind.type !== "tool" || item.kind.toolName !== "Skill" || item.status !== "completed") return undefined;
  const input = item.kind.input as Record<string, unknown> | null;
  for (const k of ["skill", "command"]) if (typeof input?.[k] === "string") return input[k] as string;
  return undefined;
}

/** An executor failure as the tools answer it. */
export function fromExecutor(error: unknown): ToolError {
  if (!(error instanceof ExecutorError)) throw error;
  switch (error.kind) {
    case "not_connected":
      return offline(error.machineId);
    case "thread_not_found":
      return unknownThread({ machineId: error.machineId, threadId: error.extra.threadId ?? "" });
    case "node_failed":
      console.warn(`executor: node request failed: ${error.message}`);
      return new ToolError("failed", error.message, error.extra.fix ?? "Retry; if it keeps failing, check the machine with fleetd_status.");
  }
}
