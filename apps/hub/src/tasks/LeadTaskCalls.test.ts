import type { LeadCall, MachineId, ProjectId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import * as LeadCallHandler from "../leads/LeadCallHandler.ts";
import { makeKit, REF, runKit } from "./testKit.ts";

const caller = { projectRef: REF, by: "lead:lab-a/p1", cwd: "/w/p1" };
const other = { projectRef: { machineId: "lab-a" as MachineId, projectId: "p2" as ProjectId }, by: "lead:lab-a/p2", cwd: "/w/p2" };

describe("task lead calls", () => {
  it("spawns, lists, steers and cancels the caller's own tasks, and hides them from other projects", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const workstreamId = yield* kit.setup;
        const handler = yield* LeadCallHandler.make;
        const call = (c: Record<string, unknown>, who = caller) => handler.handle(who, c as LeadCall);

        const spawned = yield* call({ op: "task_spawn", workstreamId, title: "add file", kind: "write", prompt: "create docs/x.md", areas: ["docs"], serves: "done:0", effort: "low" });
        expect(spawned).toMatchObject({ op: "task_spawn", task: { taskId: "T1", state: "running", effort: "low", model: "claude-opus-5-5" } });
        const second = yield* call({ op: "task_spawn", workstreamId, title: "more docs", kind: "write", prompt: "create docs/y.md", areas: ["docs"], serves: "done:0" });
        expect(second).toMatchObject({ task: { taskId: "T2", state: "queued", queuedReason: "lease: docs held by T1" } });

        expect(yield* call({ op: "task_list", state: "queued" })).toMatchObject({ op: "task_list", tasks: [{ taskId: "T2" }] });
        expect(yield* call({ op: "task_status", taskId: "T1" })).toMatchObject({ task: { branch: "fleetd/T1-add-file" } });
        yield* call({ op: "task_message", taskId: "T1", message: "also add a title" });
        expect(kit.sends.at(-1)).toMatchObject({ threadId: "t2", message: "also add a title" });

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
});
