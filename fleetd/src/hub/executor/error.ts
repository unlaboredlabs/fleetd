// Why a node request produced no answer, as the executor raises it and the areas that call nodes map it to a tool's
// error (link/node_errors.ts).
import type { MachineId, ThreadId } from "../../shared/contracts.ts";

export type NodeOperation = "launch" | "send" | "interrupt" | "stop" | "answer" | "read" | "project";

/** Why a node request produced no answer (executor/mod.rs `ExecutorError`). */
export class ExecutorError extends Error {
  constructor(
    readonly kind: "not_connected" | "thread_not_found" | "node_failed",
    readonly machineId: MachineId,
    message: string,
    readonly extra: { threadId?: ThreadId; operation?: NodeOperation; nodeMessage?: string; fix?: string } = {},
  ) {
    super(message);
    this.name = "ExecutorError";
  }

  static notConnected(machineId: MachineId): ExecutorError {
    return new ExecutorError("not_connected", machineId, `machine ${machineId} has no live node link`);
  }

  static threadNotFound(machineId: MachineId, threadId: ThreadId): ExecutorError {
    return new ExecutorError("thread_not_found", machineId, `thread ${threadId} is not known on machine ${machineId}`, { threadId });
  }

  /** `message` is the node's own words (or why no answer came); safe to show. */
  static failed(machineId: MachineId, operation: NodeOperation, message: string, fix?: string): ExecutorError {
    return new ExecutorError("node_failed", machineId, `the node on ${machineId} refused or failed the ${operation} request: ${message}`, {
      operation,
      nodeMessage: message,
      ...(fix !== undefined ? { fix } : {}),
    });
  }
}
