import { type CheckSpec, type LeadCall, type MachineId, type ProjectId, SERVES_FIX } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeChecksKit, runChecksKit } from "../checks/testKit.ts";
import * as LeadCallHandler from "../leads/LeadCallHandler.ts";
import * as EventLog from "../store/EventLog.ts";
import { REF } from "./testKit.ts";

const caller = { projectRef: REF, by: "lead:lab-a/p1", cwd: "/w/p1" };
const other = { projectRef: { machineId: "lab-a" as MachineId, projectId: "p2" as ProjectId }, by: "lead:lab-a/p2", cwd: "/w/p2" };

describe("task lead calls", () => {
  it("spawns, lists, steers and cancels the caller's own tasks, and hides them from other projects", async () => {
    const kit = makeChecksKit();
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        const workstreamId = yield* kit.tasksKit.setup;
        const handler = yield* LeadCallHandler.make;
        const call = (c: Record<string, unknown>, who = caller) => handler.handle(who, c as LeadCall);

        const spawned = yield* call({ op: "task_spawn", workstreamId, title: "add file", kind: "write", prompt: "create docs/x.md", areas: ["docs"], serves: "done:0", effort: "low" });
        expect(spawned).toMatchObject({ op: "task_spawn", task: { taskId: "T1", state: "running", effort: "low", model: "claude-opus-5-5" } });
        const second = yield* call({ op: "task_spawn", workstreamId, title: "more docs", kind: "write", prompt: "create docs/y.md", areas: ["docs"], serves: "done:0" });
        expect(second).toMatchObject({ task: { taskId: "T2", state: "queued", queuedReason: "lease: docs held by T1" } });

        expect(yield* call({ op: "task_list", state: "queued" })).toMatchObject({ op: "task_list", tasks: [{ taskId: "T2" }] });
        expect(yield* call({ op: "task_status", taskId: "T1" })).toMatchObject({ task: { branch: "fleetd/T1-add-file" } });
        yield* call({ op: "task_message", taskId: "T1", message: "also add a title" });
        expect(kit.tasksKit.sends.at(-1)).toMatchObject({ threadId: "t2", message: "also add a title" });

        expect((yield* Effect.flip(call({ op: "task_status", taskId: "T1" }, other))).code).toBe("not_found");
        expect((yield* Effect.flip(call({ op: "task_cancel", taskId: "T1" }, other))).code).toBe("not_found");
        expect(yield* call({ op: "task_list" }, other)).toMatchObject({ tasks: [] });

        expect(yield* call({ op: "task_cancel", taskId: "T1", reason: "not needed" })).toMatchObject({ task: { state: "cancelled", result: { tail: "not needed" } } });
        // The cancelled writer's lease went to the queued one.
        expect(yield* call({ op: "task_status", taskId: "T2" })).toMatchObject({ task: { state: "running" } });
        const refused = yield* Effect.flip(call({ op: "task_spawn", workstreamId, title: "x", kind: "write", prompt: "y", areas: ["nope"], serves: "done:0" }));
        expect(refused).toMatchObject({ code: "invalid", fix: expect.stringContaining("docs, hub") });
      }),
    );
  });

  it("claims done through fleetd's own checks, and records review verdicts that end review of that commit", async () => {
    const kit = makeChecksKit();
    const docCheck: CheckSpec = { type: "cmd", machineId: "lab-a" as MachineId, argv: ["test", "-f", "docs/x.md"], expectExit: 0 };
    const pr = "https://github.com/wynn-dev/lab/pull/7";
    const sha = "a".repeat(40);
    await runChecksKit(
      kit,
      Effect.gen(function* () {
        const workstreamId = yield* kit.setup([docCheck]);
        const handler = yield* LeadCallHandler.make;
        const call = (c: Record<string, unknown>, who = caller) => handler.handle(who, c as LeadCall);

        // A writer without --serves is refused with the fix.
        const unserved = yield* Effect.flip(call({ op: "task_spawn", workstreamId, title: "x", kind: "write", prompt: "y", areas: ["docs"] }));
        expect(unserved).toMatchObject({ code: "invalid", message: "A write task must say what it serves.", fix: SERVES_FIX });

        // A review records one verdict; a clean one ends review of that head.
        const review = yield* call({ op: "task_spawn", workstreamId, title: "review", kind: "review", prompt: "review it", areas: [], pr });
        expect(review).toMatchObject({ task: { taskId: "T1", kind: "review" } });
        kit.tasksKit.prHeads.set(pr, sha);
        const verdict = { op: "review_verdict", taskId: "T1", prHeadSha: sha, blocking: 0, nonBlocking: 1, summary: "reads well" };
        expect((yield* Effect.flip(call(verdict, other))).code).toBe("not_found");
        expect(yield* call(verdict)).toMatchObject({ op: "review_verdict", verdict: { taskId: "T1", blocking: 0 }, next: expect.stringContaining("will not be reviewed again") });
        const again = yield* Effect.flip(call({ op: "task_spawn", workstreamId, title: "review again", kind: "review", prompt: "review it", areas: [], pr }));
        expect(again).toMatchObject({ code: "invalid", message: `already reviewed at ${sha} with 0 blocking findings` });

        // The node says the file is missing: the claim fails and the workstream stays verifying.
        kit.setNode(() => ({ exitCode: 1, outputTail: "", timedOut: false }));
        const failed = yield* call({ op: "claim_done", workstreamId });
        expect(failed).toMatchObject({ op: "claim_done", claimId: "C1", state: "verifying", claim: { outcome: "fail", by: caller.by } });
        expect((yield* Effect.flip(call({ op: "claim_done", workstreamId }, other))).code).toBe("not_found");

        kit.setNode(() => ({ exitCode: 0, outputTail: "", timedOut: false }));
        const passed = yield* call({ op: "claim_done", workstreamId });
        expect(passed).toMatchObject({ op: "claim_done", claimId: "C2", state: "done", claim: { outcome: "pass", results: [{ result: "pass", exitCode: 0 }] } });
        const done = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["workstream.done"], timeoutSec: 0 });
        expect(done.events.map((e) => e.summary)).toEqual([`${workstreamId} is done: docs`]);
        const late = yield* Effect.flip(call({ op: "task_spawn", workstreamId, title: "more", kind: "write", prompt: "y", areas: ["docs"], serves: "done:0" }));
        expect(late.message).toBe(`${workstreamId} is done; open a new intent if there's more to do`);
      }),
    );
  });
});
