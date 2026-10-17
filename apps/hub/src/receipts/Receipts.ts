// Receipts for a task, read from its thread's turn items through the executor.
import type { Receipts as ReceiptsData, TaskId, TaskResult, ThreadRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Executors from "../executor/Executors.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { claimsUnverified, countReceipts } from "./count.ts";

/** Every action of a task thread, as far as T3's bounded thread snapshot reaches. */
const MAX_ACTIONS = 1000;

export class Receipts extends Context.Service<
  Receipts,
  {
    /** Counted now from the task's thread; undefined for a task that never got one or whose machine is unreachable. */
    readonly forTask: (taskId: TaskId) => Effect.Effect<ReceiptsData | undefined>;
    /** `result` with its receipts and `claimsUnverified`; unchanged when the thread cannot be read. */
    readonly attach: (ref: ThreadRef, result: TaskResult) => Effect.Effect<TaskResult>;
  }
>()("fleetd/receipts/Receipts") {}

export const make = Effect.gen(function* () {
  const executors = yield* Executors.Executors;
  const tasks = yield* TaskRecords.TaskRecords;

  const count = (ref: ThreadRef) =>
    executors.actions(ref, MAX_ACTIONS).pipe(
      Effect.map(countReceipts),
      Effect.catch((error) => Effect.as(Effect.logWarning("receipts: thread not readable", { threadId: ref.threadId, error: error._tag }), undefined)),
    );

  const forTask: Receipts["Service"]["forTask"] = (taskId) =>
    Effect.flatMap(tasks.get(taskId), (stored) => (stored?.task.threadRef === undefined ? Effect.succeed(undefined) : count(stored.task.threadRef)));

  const attach: Receipts["Service"]["attach"] = (ref, result) =>
    Effect.map(count(ref), (receipts) =>
      receipts === undefined ? result : { ...result, receipts, claimsUnverified: claimsUnverified(result.tail, receipts) },
    );

  return Receipts.of({ forTask, attach });
});

/** Needs Executors and TaskRecords. */
export const layer = Layer.effect(Receipts, make);
