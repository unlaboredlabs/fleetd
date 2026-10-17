// The gate on the real train (real git in temp repos, fake `gh`): an M-tier PR gets a reviewer, whose clean verdict on
// the head the train read makes the train mark it ready and merge it.
import type { ReviewVerdict, Task } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { GhError, GitHub } from "../checks/GitHub.ts";
import { ProviderList } from "../executor/ProviderList.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, nextEvent } from "../tasks/testKit.ts";
import { makeTrainKit, REF, REPO } from "../train/testKit.ts";
import { Train } from "../train/Train.ts";
import { ValueBar } from "../valuebar/ValueBar.ts";
import { layerBindTrain, layerGate } from "./trainGate.ts";

describe("the train's review gate", () => {
  it("spawns an M reviewer on enqueue and lets the train merge once its clean verdict is in", async () => {
    const gate = layerGate.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(GitHub, GitHub.of({ api: () => Effect.fail(new GhError({ kind: "failed", message: "not needed here" })) })),
          Layer.succeed(ProviderList, ProviderList.of({ instances: () => Effect.succeed([]) })),
        ),
      ),
    );
    const kit = makeTrainKit({ gate });
    const layer = layerBindTrain.pipe(Layer.provideMerge(kit.layer));
    await Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const ws = yield* kit.setup;
            const train = yield* Train;
            const tasks = yield* Tasks.Tasks;
            const cursor = yield* (yield* EventLog.EventLog).head();
            const change = yield* train.enqueue(LEAD, { prUrl: kit.openPr(7, "m", { "a.txt": kit.aWith({ 6: "pr line 6" }) }), workstreamId: ws, tier: "M" });
            expect(change).toMatchObject({ state: "reviewing", tier: "M" });

            const started = yield* nextEvent(cursor, "task.started");
            const reviewer: Task = (yield* tasks.get((started.data as { taskId: Task["taskId"] }).taskId))!;
            expect(reviewer).toMatchObject({ kind: "review", pr: change.prUrl, tier: "M", serves: "done:0" });
            expect(yield* train.step(REPO)).toBe(false);

            yield* (yield* ValueBar).recordVerdict(LEAD, {
              taskId: reviewer.taskId,
              prHeadSha: change.headSha,
              blocking: 0,
              nonBlocking: 0,
              summary: "correct",
            } as ReviewVerdict);
            yield* nextEvent(cursor, "change.ready");
            const ready = (yield* train.get(change.changeId))!;
            expect(ready).toMatchObject({ state: "ready", reviews: [{ taskId: reviewer.taskId, prHeadSha: change.headSha, patchId: change.patchId, blocking: 0 }] });

            expect(yield* train.step(REPO)).toBe(true);
            expect((yield* train.get(change.changeId))?.state).toBe("merged");
            expect(kit.merges.map((m) => m.prNumber)).toEqual([7]);

            // An L PR on a machine without Codex: the note lands on the train's row without touching its state.
            const large = yield* train.enqueue(LEAD, { prUrl: kit.openPr(8, "l", { "b.txt": "b\n" }), workstreamId: ws, tier: "L" });
            expect((yield* train.get(large.changeId))!).toMatchObject({
              state: "reviewing",
              projectRef: REF,
              lastError: "No usable Codex instance on lab-a, so both L reviewers run on Claude.",
            });
          }),
          layer,
        ),
      ),
    ).finally(kit.cleanup);
  });
});
