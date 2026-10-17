// The value bar through Tasks.spawn and recorded verdicts, on the tasks test kit.
import type { ReviewVerdict, TaskId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { Incidents } from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, makeKit, REF, runKit } from "../tasks/testKit.ts";
import { ValueBar } from "./ValueBar.ts";

const PR = "https://github.com/wynn-dev/lab/pull/7";
const A = "a".repeat(40);
const B = "b".repeat(40);

const input = (fields: object) => fields as Tasks.SpawnInput;
const reviewInput = (workstreamId: WorkstreamId, over: object = {}) =>
  input({ workstreamId, title: "review the PR", kind: "review", prompt: "review it", areas: [], pr: PR, ...over });

const verdict = (taskId: TaskId, prHeadSha: string, blocking: number): ReviewVerdict =>
  ({ taskId, prHeadSha, blocking, nonBlocking: 1, summary: "looks fine" }) as ReviewVerdict;

describe("ValueBar", () => {
  it("refuses write spawns without serves, with a dangling done:<n>, or on a done workstream", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const base = input({ workstreamId: ws, title: "add file", kind: "write", prompt: "p", areas: ["docs"] });

        expect(yield* Effect.flip(tasks.spawn(LEAD, base))).toMatchObject({
          code: "invalid",
          fix: "say what this serves: --serves done:<n> | issue:<ref> | defect:<text> | ask:<id>",
        });
        expect((yield* Effect.flip(tasks.spawn(LEAD, { ...base, serves: "done:1" }))).message).toBe(
          "done:1 is not a done-when check of W1; it has 1 (done:0).",
        );
        expect(yield* tasks.spawn(LEAD, { ...base, serves: "done:0" })).toMatchObject({ taskId: "T1", serves: "done:0" });

        const records = yield* LeadRecords.LeadRecords;
        const stored = (yield* records.workstreams.get(ws))!;
        yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, state: "done" } });
        expect((yield* Effect.flip(tasks.spawn(LEAD, { ...base, serves: "done:0" }))).message).toBe(
          "W1 is done; open a new intent if there's more to do",
        );
      }),
    );
  });

  it("stops review after one clean verdict per head, and refuses a third round after two clean ones as a polish loop", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const bar = yield* ValueBar;
        kit.prHeads.set(PR, A);

        expect((yield* Effect.flip(tasks.spawn(LEAD, input({ workstreamId: ws, title: "review the PR", kind: "review", prompt: "review it", areas: [] })))).message).toBe("A review task needs the PR it reviews.");

        const first = yield* tasks.spawn(LEAD, reviewInput(ws));
        expect(first).toMatchObject({ taskId: "T1", kind: "review", pr: PR });
        const cursor = yield* (yield* EventLog.EventLog).head();
        yield* bar.recordVerdict(LEAD, verdict(first.taskId, A, 0));
        const [event] = (yield* (yield* EventLog.EventLog).wait({ cursor, types: ["review.verdict"], timeoutSec: 0 })).events;
        expect(event?.data).toMatchObject({ taskId: "T1", prHeadSha: A, blocking: 0, pr: PR });

        const again = yield* Effect.flip(tasks.spawn(LEAD, reviewInput(ws)));
        expect(again.message).toBe(`already reviewed at ${A} with 0 blocking findings`);
        const qa = yield* Effect.flip(tasks.spawn(LEAD, reviewInput(ws, { qa: true })));
        expect(qa.message).toBe(`already reviewed at ${A} with 0 blocking findings`);

        // A new head gets one more round; once that is clean too, a third round on yet another head is a polish loop.
        kit.prHeads.set(PR, B);
        const second = yield* tasks.spawn(LEAD, reviewInput(ws));
        yield* bar.recordVerdict(LEAD, verdict(second.taskId, B, 0));
        kit.prHeads.set(PR, "c".repeat(40));
        const third = yield* Effect.flip(tasks.spawn(LEAD, reviewInput(ws)));
        expect(third.message).toContain("a third review is a polish loop");

        const incidents = yield* (yield* Incidents).list({ projectRef: REF, limit: 10 });
        expect(incidents).toHaveLength(1);
        expect(incidents[0]).toMatchObject({ incidentId: "I1", class: "polish_loop", workstreamId: ws });
        expect(incidents[0]!.evidence).toEqual([
          `Review requested for ${PR} after two consecutive clean verdicts on different heads.`,
          `T1: 0 blocking at ${A}`,
          `T2: 0 blocking at ${B}`,
        ]);
      }),
    );
  });

  it("lets review through when GitHub cannot say the head and the PR has no polish loop", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const first = yield* tasks.spawn(LEAD, reviewInput(ws));
        yield* (yield* ValueBar).recordVerdict(LEAD, verdict(first.taskId, A, 0));
        // kit.prHeads has no entry: gh fails, so the SHA rule cannot apply.
        expect(yield* tasks.spawn(LEAD, reviewInput(ws))).toMatchObject({ taskId: "T2" });
      }),
    );
  });

  it("records verdicts only from review tasks of the caller's project", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const bar = yield* ValueBar;
        const writer = yield* tasks.spawn(LEAD, input({ workstreamId: ws, title: "w", kind: "write", prompt: "p", areas: ["docs"], serves: "done:0" }));
        expect((yield* Effect.flip(bar.recordVerdict(LEAD, verdict(writer.taskId, A, 0)))).message).toBe(
          "T1 is a write task; only review tasks record verdicts.",
        );
        expect((yield* Effect.flip(bar.recordVerdict(LEAD, verdict("T9" as TaskId, A, 0)))).code).toBe("not_found");
        const other = { projectRef: { ...REF, projectId: "p2" as typeof REF.projectId }, by: "lead:lab-a/p2" };
        const reviewer = yield* tasks.spawn(LEAD, reviewInput(ws));
        expect((yield* Effect.flip(bar.recordVerdict(other, verdict(reviewer.taskId, A, 0)))).code).toBe("not_found");
      }),
    );
  });
});
