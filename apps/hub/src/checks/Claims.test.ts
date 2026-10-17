import type { CheckSpec, HubEventType, MachineId, ProjectId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Incidents } from "../incidents/Incidents.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import { Asks } from "../ledger/Asks.ts";
import { Inbox } from "../ledger/Inbox.ts";
import * as EventLog from "../store/EventLog.ts";
import { Claims, INLINE_WAIT } from "./Claims.ts";
import { makeChecksKit, runChecksKit } from "./testKit.ts";

const W1 = "W1" as WorkstreamId;
const LEAD_BY = "lead:lab-a/p1";
const DOC_CHECK: CheckSpec = { type: "cmd", machineId: "lab-a" as MachineId, argv: ["test", "-f", "docs/x.md"], expectExit: 0 };
const missing = { exitCode: 1, outputTail: "", timedOut: false } as const;
const present = { exitCode: 0, outputTail: "", timedOut: false } as const;

const eventsOf = (types: ReadonlyArray<HubEventType>) =>
  Effect.map(
    Effect.flatMap(EventLog.EventLog, (e) => e.wait({ cursor: 0, types, timeoutSec: 0 })),
    (page) => page.events.map((e) => ({ type: e.type, summary: e.summary, data: e.data })),
  );
const stateOf = Effect.map(
  Effect.flatMap(LeadRecords.LeadRecords, (r) => r.workstreams.get(W1)),
  (s) => s?.workstream.state,
);

describe("claim done", () => {
  it("fails while the file is missing, wakes the lead with the evidence, then passes and marks the workstream done", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([DOC_CHECK]);
        const claims = yield* Claims;
        kit.setNode(() => ({ ...missing, outputTail: "checked /w/p1\n" }));

        const failed = yield* claims.claimDone(W1, LEAD_BY);
        expect(failed).toMatchObject({ claimId: "C1", workstreamId: "W1", state: "verifying", claim: { claimId: "C1", by: LEAD_BY, outcome: "fail" } });
        expect(failed.claim!.results).toMatchObject([{ checkIndex: 0, result: "fail", exitCode: 1, ranBy: "node" }]);
        expect(failed.next).toContain("done:0 did not pass");
        expect(yield* stateOf).toBe("verifying");
        expect(yield* eventsOf(["workstream.state", "claim.failed", "claim.passed", "workstream.done"])).toEqual([
          { type: "workstream.state", summary: "W1 is verifying (C1)", data: { workstreamId: "W1", state: "verifying", claimId: "C1" } },
          { type: "claim.failed", summary: "C1 on W1 failed: 1 of 1 checks did not pass", data: { claimId: "C1", workstreamId: "W1", failing: [0] } },
        ]);

        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        const wake = kit.tasksKit.sends.at(-1)!;
        expect(wake.threadId).toBe("t1");
        expect(wake.message).toContain(
          [
            "- Claim C1 on W1 failed; W1 stays verifying. Checks that did not pass:",
            "  done:0 (on lab-a: `test -f docs/x.md` exits 0): fail, exit 1",
            "    > `test -f docs/x.md` in /w/p1 exited 1 (expected 0)",
            "    > checked /w/p1",
            "  next: fix what failed (e.g. a task with --serves done:0), then `fleetd claim done --workstream W1` again.",
          ].join("\n"),
        );

        kit.setNode(() => present);
        const passed = yield* claims.claimDone(W1, LEAD_BY);
        expect(passed).toMatchObject({ claimId: "C2", state: "done", claim: { outcome: "pass", results: [{ result: "pass", exitCode: 0 }] } });
        expect(yield* stateOf).toBe("done");
        expect((yield* eventsOf(["claim.passed", "workstream.done"])).map((e) => e.type)).toEqual(["claim.passed", "workstream.done"]);
        expect(kit.done).toEqual(["W1"]);
        expect((yield* claims.list({ workstreamId: W1, limit: 10 })).map((c) => [c.claimId, c.outcome])).toEqual([
          ["C2", "pass"],
          ["C1", "fail"],
        ]);
        expect(yield* Effect.flip(claims.claimDone(W1, LEAD_BY))).toMatchObject({ code: "invalid", message: "W1 is already done." });
      }),
    );
  });

  it("records one false-claim incident at the third failed claim", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([DOC_CHECK]);
        const claims = yield* Claims;
        kit.setNode(() => missing);
        const incidents = Effect.flatMap(Incidents, (i) => i.list({ limit: 10 }));
        for (let i = 0; i < 2; i++) yield* claims.claimDone(W1, LEAD_BY);
        expect(yield* incidents).toEqual([]);
        yield* claims.claimDone(W1, LEAD_BY);
        expect(yield* incidents).toMatchObject([
          {
            incidentId: "I1",
            class: "false_claim",
            projectRef: { machineId: "lab-a", projectId: "p1" },
            workstreamId: "W1",
            evidence: [1, 2, 3].map((n) => `C${n} failed: done:0 fail (exit 1): \`test -f docs/x.md\` in /w/p1 exited 1 (expected 0)`),
          },
        ]);
        yield* claims.claimDone(W1, LEAD_BY);
        expect(yield* incidents).toHaveLength(1);
        expect(yield* stateOf).toBe("verifying");
      }),
    );
  });

  it("asks the human only once the automatic checks pass, and reports a slow pass through a wake", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([DOC_CHECK, { type: "human", question: "Does the page read well?" }]);
        const claims = yield* Claims;
        const asks = yield* Asks;

        kit.setNode(() => missing);
        const skipped = yield* claims.claimDone(W1, LEAD_BY);
        expect(skipped.claim!.results[1]).toMatchObject({
          result: "error",
          ranBy: "human",
          evidence: "not run: a judge or the human is asked only once every earlier check passes",
        });
        expect(yield* asks.list({})).toEqual([]);

        kit.setNode(() => present);
        const call = yield* Effect.forkChild(claims.claimDone(W1, LEAD_BY));
        yield* TestClock.adjust(INLINE_WAIT);
        const returned = yield* Fiber.join(call);
        expect(returned).toMatchObject({ claimId: "C2", state: "verifying" });
        expect(returned.claim).toBeUndefined();
        expect(returned.next).toContain("its outcome arrives in a wake");
        expect(yield* asks.list({ state: "open" })).toMatchObject([{ key: "w1.c2.done-1", kind: "do" }]);

        const cursor = yield* Effect.flatMap(EventLog.EventLog, (e) => e.head());
        yield* (yield* Inbox).reply({ raw: "1 done" }, { source: "human", by: "human:phone" });
        yield* (yield* EventLog.EventLog).wait({ cursor, types: ["workstream.done"], timeoutSec: 3600 });
        expect(yield* stateOf).toBe("done");
        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.tasksKit.sends.at(-1)!.message).toContain("- Claim C2 on W1 passed: every done-when check passed, so W1 is done.");
      }),
    );
  });

  it("supersedes a claim still waiting on the human", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([{ type: "human", question: "Looks right?" }]);
        const claims = yield* Claims;
        const first = yield* Effect.forkChild(claims.claimDone(W1, LEAD_BY));
        yield* TestClock.adjust(INLINE_WAIT);
        expect((yield* Fiber.join(first)).claimId).toBe("C1");

        const second = yield* Effect.forkChild(claims.claimDone(W1, LEAD_BY));
        yield* TestClock.adjust(INLINE_WAIT);
        expect((yield* Fiber.join(second)).claimId).toBe("C2");
        // C1 never finishes, so it is never listed or counted.
        expect(yield* claims.list({ workstreamId: W1, limit: 10 })).toEqual([]);
      }),
    );
  });

  it("refuses drafts, other projects' workstreams and unknown ones", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        yield* kit.setup([DOC_CHECK]);
        const claims = yield* Claims;
        const records = yield* LeadRecords.LeadRecords;
        const { workstream } = yield* records.workstreams.create({
          ref: { machineId: "lab-a" as MachineId, projectId: "p1" as ProjectId },
          title: "draft",
          source: { text: "later", channel: "app", by: "human", at: "1970-01-01T00:00:00.000Z" },
        });
        expect(yield* Effect.flip(claims.claimDone(workstream.workstreamId, LEAD_BY))).toMatchObject({
          code: "invalid",
          message: "W2 has no frozen brief, so it has no done-when checks to run.",
        });
        const other = { machineId: "lab-b" as MachineId, projectId: "p9" as ProjectId };
        expect(yield* Effect.flip(claims.claimDone(W1, "lead:lab-b/p9", { projectRef: other }))).toMatchObject({ code: "not_found" });
        expect(yield* Effect.flip(claims.claimDone("W99" as WorkstreamId, LEAD_BY))).toMatchObject({ code: "not_found" });
        expect(kit.commands).toEqual([]);
      }),
    );
  });
});
