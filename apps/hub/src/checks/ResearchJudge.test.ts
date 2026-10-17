// A research workstream's claim, end to end on the checks kit: the hub's judge reports baseline and candidate with its
// verdict, the value bar turns them into the computed research verdict, and the claim that follows leaves it intact.
import type { ReviewVerdict, TaskId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { Playbooks } from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD } from "../tasks/testKit.ts";
import { ValueBar } from "../valuebar/ValueBar.ts";
import { Claims } from "./Claims.ts";
import { JudgeVerdicts } from "./Judges.ts";
import { makeChecksKit, REF, runChecksKit } from "./testKit.ts";

const W1 = "W1" as WorkstreamId;
const SHA = "c".repeat(40);
const verdict = (taskId: TaskId, metricValues?: { baseline: number; candidate: number }): ReviewVerdict => ({
  taskId,
  prHeadSha: SHA,
  blocking: 0,
  nonBlocking: 0,
  summary: "measured both on the same 100 requests",
  ...(metricValues === undefined ? {} : { metricValues }),
});

const untilJudge = Effect.gen(function* () {
  const events = yield* EventLog.EventLog;
  let cursor = 0;
  while (true) {
    const found = (yield* (yield* Tasks.Tasks).list({ limit: 10 })).find((t) => t.kind === "review" && t.pr === undefined && t.threadRef !== undefined);
    if (found !== undefined) return found;
    cursor = (yield* events.wait({ cursor, types: ["task.started"], timeoutSec: 3600 })).cursor;
  }
});

describe("research judge", () => {
  it("turns the judge's baseline and candidate into the computed verdict, refusing a verdict without them", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([{ type: "judge", criteria: "Measure the hit rate with and without the cache." }]);
        const records = yield* LeadRecords.LeadRecords;
        const stored = (yield* records.workstreams.get(W1))!;
        const pinned = yield* (yield* Playbooks).pin("research");
        yield* records.workstreams.put({
          ...stored,
          workstream: {
            ...stored.workstream,
            playbook: pinned.ref,
            brief: {
              ...stored.workstream.brief!,
              baseline: "no cache",
              metric: "hit rate",
              decisionRule: { better: "higher", goAtLeast: 0.1, stopBelow: 0.1 },
              budget: { agentHours: 1 },
            },
          },
        });

        const claim = yield* Effect.forkChild((yield* Claims).claimDone(W1, LEAD.by, { projectRef: REF }));
        const judge = yield* untilJudge;
        const prompt = kit.tasksKit.launches.at(-1)!.input.prompt;
        expect(prompt).toContain('Measure the metric "hit rate" the same way for the baseline and for the candidate.');
        expect(prompt).toContain("--baseline <the baseline's number> --candidate <the candidate's number>");

        const bar = yield* ValueBar;
        expect(yield* Effect.flip(bar.recordVerdict(LEAD, verdict(judge.taskId)))).toMatchObject({
          message: `${judge.taskId} judges research workstream W1, so its verdict must carry the measured numbers.`,
          fix: 'Rerun with --baseline <n> --candidate <n>: "hit rate" measured for the baseline and for the candidate.',
        });
        // A PR reviewer on the same workstream is no judge, so it reports no metric.
        const reviewer = yield* (yield* Tasks.Tasks).spawn(LEAD, {
          workstreamId: W1,
          title: "review",
          kind: "review",
          prompt: "review it",
          areas: [],
          pr: "https://github.com/wynn-dev/lab/pull/7",
        } as unknown as Tasks.SpawnInput);
        expect((yield* Effect.flip(bar.recordVerdict(LEAD, verdict(reviewer.taskId, { baseline: 1, candidate: 2 })))).message).toBe(
          `${reviewer.taskId} is not the judge of a research workstream; only those report --baseline and --candidate.`,
        );

        const recorded = yield* bar.recordVerdict(LEAD, verdict(judge.taskId, { baseline: 0.5, candidate: 0.52 }));
        expect(recorded.research).toBe(
          "W1 research verdict STOP: candidate 0.52 vs baseline 0.5 on hit rate (higher is better): improvement 0.02, below the stop line 0.1. STOP is a success: the question is answered.",
        );
        expect((yield* records.workstreams.get(W1))!.workstream).toMatchObject({ state: "done", outcome: "stop", verdict: { outcome: "stop" } });

        // The judge check resolves (the hook is a no-op in this kit, so it is completed by hand); the claim passes
        // and leaves the workstream as the verdict made it.
        expect(yield* (yield* JudgeVerdicts).complete(recorded.verdict)).toBe(true);
        expect((yield* Fiber.join(claim)).claim?.outcome).toBe("pass");
        expect((yield* records.workstreams.get(W1))!.workstream).toMatchObject({ state: "done", outcome: "stop" });
        const done = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["workstream.done", "research.verdict"], timeoutSec: 0 });
        expect(done.events.map((e) => e.type)).toEqual(["research.verdict", "workstream.done"]);
      }),
    );
  });
});
