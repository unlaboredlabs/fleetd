// Receipts on the task completion path, on the tasks test kit.
import type { TaskId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, makeKit, nextEvent, runKit } from "../tasks/testKit.ts";
import { Receipts } from "./Receipts.ts";

const at = "1970-01-01T00:00:01.000Z";

describe("Receipts", () => {
  it("marks a result that claims success without running anything as unverified, in the record and the wake", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, { workstreamId: ws, title: "check docs", kind: "read", prompt: "check", areas: [] } as Tasks.SpawnInput);
        kit.actions.set("t2", [{ at, kind: "tool_call", status: "completed", summary: "Read", failed: false }]);
        const cursor = yield* (yield* EventLog.EventLog).head();
        yield* kit.threadEvent("t2", "thread.completed", "Checked the docs. All tests pass.");
        yield* nextEvent(cursor, "task.completed");

        const done = (yield* tasks.get("T1" as TaskId))!;
        expect(done.result).toMatchObject({ receipts: { commands: 0, commandsFailed: 0, filesChanged: 0, toolCalls: 1 }, claimsUnverified: true });
        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.sends.at(-1)!.message).toContain("- T1 completed: check docs\n  receipts: 0 commands run — claims unverified\n  result:");
      }),
    );
  });

  it("counts a task's commands, failures and files on demand", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        yield* (yield* Tasks.Tasks).spawn(LEAD, { workstreamId: ws, title: "w", kind: "write", prompt: "p", areas: ["docs"], serves: "done:0" } as object as Tasks.SpawnInput);
        kit.actions.set("t2", [
          { at, kind: "command", status: "completed", summary: "pnpm test", failed: false },
          { at, kind: "command", status: "failed", summary: "pnpm lint", exitCode: 1, failed: true },
          { at, kind: "file_change", status: "completed", summary: "docs/x.md", failed: false },
        ]);
        const receipts = yield* Receipts;
        expect(yield* receipts.forTask("T1" as TaskId)).toEqual({ commands: 2, commandsFailed: 1, filesChanged: 1, toolCalls: 0 });
        expect(yield* receipts.forTask("T9" as TaskId)).toBeUndefined();
      }),
    );
  });
});
