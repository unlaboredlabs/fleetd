import type { TaskState, ThreadId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import * as HubDb from "../store/HubDb.ts";
import * as TaskRecords from "./TaskRecords.ts";
import { REF } from "./testKit.ts";

const run = <A>(effect: Effect.Effect<A, never, TaskRecords.TaskRecords>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, TaskRecords.layer.pipe(Layer.provide(HubDb.layerMemory)))));

const input = (state: TaskState, endedAt?: string) => ({
  projectRef: REF,
  workstreamId: "W1" as WorkstreamId,
  title: `a ${state} task`,
  kind: "read" as const,
  prompt: "look",
  areas: [],
  model: "claude-haiku-5-5",
  effort: "low" as const,
  state,
  attempt: 1,
  createdAt: "2026-10-17T10:00:00.000Z",
  ...(endedAt === undefined ? {} : { endedAt }),
});

describe("TaskRecords", () => {
  it("numbers tasks, finds them by thread, lists the queue oldest first and the digest's tasks since a wake", async () => {
    await run(
      Effect.gen(function* () {
        const records = yield* TaskRecords.TaskRecords;
        const q1 = yield* records.create(input("queued"));
        const running = yield* records.create(input("running"));
        yield* records.create(input("done", "2026-10-17T09:00:00.000Z"));
        const recent = yield* records.create(input("failed", "2026-10-17T11:00:00.000Z"));
        const q2 = yield* records.create(input("queued"));
        expect([q1.taskId, running.taskId, recent.taskId, q2.taskId]).toEqual(["T1", "T2", "T4", "T5"]);

        yield* records.put({ task: { ...running, threadRef: { machineId: REF.machineId, threadId: "t9" as ThreadId } }, pendingMessage: "more" });
        expect(yield* records.byThread({ machineId: REF.machineId, threadId: "t9" as ThreadId })).toMatchObject({
          task: { taskId: "T2" },
          pendingMessage: "more",
        });
        expect((yield* records.queued()).map((s) => s.task.taskId)).toEqual(["T1", "T5"]);
        expect((yield* records.forDigest(REF, "2026-10-17T10:00:00.000Z", 50)).map((t) => t.taskId)).toEqual(["T5", "T4", "T2", "T1"]);
        expect((yield* records.forDigest(REF, undefined, 50)).map((t) => t.taskId)).toEqual(["T5", "T4", "T3", "T2", "T1"]);
        expect((yield* records.list({ ref: REF, state: "queued", limit: 1 })).map((t) => t.taskId)).toEqual(["T5"]);
      }),
    );
  });
});
