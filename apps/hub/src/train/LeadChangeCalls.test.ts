import type { LeadCall, MachineId, ProjectId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { Claims } from "../checks/Claims.ts";
import * as LeadCallHandler from "../leads/LeadCallHandler.ts";
import { makeTrainKit, REF, REPO, runTrainKit } from "./testKit.ts";
import { Train } from "./Train.ts";

const caller = { projectRef: REF, by: "lead:lab-a/p1", cwd: "/w/p1" };
const other = { projectRef: { machineId: "lab-a" as MachineId, projectId: "p2" as ProjectId }, by: "lead:lab-a/p2", cwd: "/w/p2" };

describe("change lead calls", () => {
  it("enqueues a PR on the train, refuses one without Source: with the fix, and shows a Change only to its project", async () => {
    const kit = makeTrainKit();
    await runTrainKit(
      kit,
      Effect.gen(function* () {
        const workstreamId = yield* kit.setup;
        const handler = yield* LeadCallHandler.make.pipe(
          Effect.provideService(Claims, Claims.of({ claimDone: () => Effect.die("no claims here"), get: () => Effect.succeed(undefined), list: () => Effect.succeed([]) })),
        );
        const call = (c: Record<string, unknown>, who = caller) => handler.handle(who, c as LeadCall);

        const bare = kit.openPr(3, "no-source", { "b.txt": "b\n" }, "Adds b.");
        const refused = yield* Effect.flip(call({ op: "change_enqueue", prUrl: bare, workstreamId }));
        expect(refused).toMatchObject({ code: "invalid", fix: "add 'Source: done:0' to the PR body" });

        const pr = kit.openPr(7, "docs", { "docs.md": "docs\n" });
        const queued = yield* call({ op: "change_enqueue", prUrl: pr, workstreamId });
        // Tier S needs no review, so it is ready at once and first in line.
        expect(queued).toMatchObject({ op: "change_enqueue", change: { changeId: "X1", state: "ready", position: 0, serves: "done:0" } });
        expect(queued.next).toContain("don't merge it yourself");

        expect((yield* Effect.flip(call({ op: "change_status", changeId: "X1" }, other))).code).toBe("not_found");
        expect(yield* (yield* Train).step(REPO)).toBe(true);
        expect(yield* call({ op: "change_status", changeId: "X1" })).toMatchObject({ change: { state: "merged" }, next: "nothing; it is merged." });
      }),
    );
  });
});
