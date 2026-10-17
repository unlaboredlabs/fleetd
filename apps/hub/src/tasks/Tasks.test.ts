import type { TaskId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "./Tasks.ts";
import { LEAD, leaseOwners, makeKit, nextEvent, REF, runKit, slotsUsed } from "./testKit.ts";

const T = (n: number) => `T${n}` as TaskId;
const spawnInput = (workstreamId: string, over: Partial<Tasks.SpawnInput> = {}): Tasks.SpawnInput =>
  ({
    workstreamId,
    title: "add file",
    kind: "write",
    prompt: "create docs/x.md with one line 'hi', commit it on your branch",
    areas: ["docs"],
    serves: "done:0",
    ...over,
  }) as Tasks.SpawnInput;
const head = Effect.flatMap(EventLog.EventLog, (e) => e.head());

describe("Tasks", () => {
  it("launches a writer in a new worktree on its branch with explicit model and effort, then wakes the lead with the result inline", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const cursor = yield* head;
        const task = yield* tasks.spawn(LEAD, spawnInput(ws));

        expect(task).toMatchObject({ taskId: "T1", state: "running", model: "claude-opus-5-5", effort: "high", branch: "fleetd/T1-add-file" });
        const launch = kit.launches[1]!;
        expect(launch.options).toEqual({ workspace: { type: "worktree", baseRef: "main", branch: "fleetd/T1-add-file" } });
        expect(launch.input).toMatchObject({ model: "claude-opus-5-5", effort: "high", runtimeMode: "full-access", title: "T1: add file", clientRequestId: "fleetd-task:T1:0:1" });
        expect(launch.input.prompt).toContain("Only change files in these areas: docs (docs/**).");
        expect(launch.input.prompt).toContain("Goal: a docs page");
        expect((yield* nextEvent(cursor, "task.started")).data).toMatchObject({ taskId: "T1", branch: "fleetd/T1-add-file" });
        expect(yield* leaseOwners).toEqual({ docs: "T1" });
        expect(yield* slotsUsed).toBe(1);

        kit.changes.set("t2", { branch: "fleetd/T1-add-file", worktreePath: "/w/p1/.t3/worktrees/T1", paths: ["docs/x.md"], pullRequestUrls: [] });
        const before = yield* head;
        yield* kit.threadEvent("t2", "thread.completed", "Created docs/x.md and committed it.\n\nResult: done, nothing left.");
        yield* nextEvent(before, "task.completed");

        const done = (yield* tasks.get(T(1)))!;
        expect(done).toMatchObject({ state: "done", worktreePath: "/w/p1/.t3/worktrees/T1" });
        expect(done.result).toMatchObject({
          status: "done",
          tail: "Created docs/x.md and committed it.\n\nResult: done, nothing left.",
          branch: "fleetd/T1-add-file",
          prUrl: "https://github.com/wynn-dev/lab/pull/7",
          receipts: { commands: 1, commandsFailed: 0, filesChanged: 0, toolCalls: 0 },
          claimsUnverified: false,
        });
        expect(yield* slotsUsed).toBe(0);
        expect(yield* leaseOwners).toEqual({});
        // In area: no out_of_area event.
        expect((yield* (yield* EventLog.EventLog).wait({ cursor: before, types: ["task.out_of_area"], timeoutSec: 0 })).events).toEqual([]);

        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.sends).toHaveLength(1);
        const wake = kit.sends[0]!;
        expect(wake.threadId).toBe("t1");
        expect(wake.message).toContain("## Tasks\n- T1 done since your last wake: add file → Created docs/x.md");
        expect(wake.message).toContain(
          [
            "- T1 completed: add file (branch fleetd/T1-add-file, PR https://github.com/wynn-dev/lab/pull/7)",
            "  receipts: 1 command (0 failed), 0 files changed, 0 tool calls",
            "  result:",
            "  > Created docs/x.md and committed it.",
            "  >",
            "  > Result: done, nothing left.",
          ].join("\n"),
        );
      }),
    );
  });

  it("flags files outside the leased globs when a writer ends, and fails on a failed thread", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, spawnInput(ws));
        kit.changes.set("t2", { paths: ["README.md", "docs/x.md", "src/a.ts"], pullRequestUrls: [] });
        const before = yield* head;
        yield* kit.threadEvent("t2", "thread.failed", "I edited the README too.", { class: "provider", message: "exit 1" });
        const flagged = yield* nextEvent(before, "task.out_of_area");
        expect(flagged.data).toMatchObject({ taskId: "T1", paths: ["README.md", "src/a.ts"] });
        yield* nextEvent(before, "task.failed");
        const failed = (yield* tasks.get(T(1)))!;
        expect(failed.state).toBe("failed");
        expect(failed.result?.tail).toBe("I edited the README too.\n\n[provider] exit 1");
      }),
    );
  });

  it("queues past the cap and starts the next task when the running one ends", async () => {
    const kit = makeKit({ cap: 1 });
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, spawnInput(ws));
        const cursor = yield* head;
        const second = yield* tasks.spawn(LEAD, spawnInput(ws, { title: "read the code", kind: "read", areas: [] }));
        expect(second).toMatchObject({ taskId: "T2", state: "queued", queuedReason: "slots: 1/1 in use" });
        expect((yield* nextEvent(cursor, "task.queued")).data).toMatchObject({ taskId: "T2", queuedReason: "slots: 1/1 in use" });
        expect(kit.launches).toHaveLength(2);

        const before = yield* head;
        yield* kit.threadEvent("t2", "thread.completed", "done");
        yield* nextEvent(before, "task.started", "T2");
        expect(kit.launches).toHaveLength(3);
        // Readers get the project root and no lease.
        expect(kit.launches[2]!.options).toBeUndefined();
        expect(kit.launches[2]!.input.prompt).toContain("This is a read-only task");
        expect((yield* tasks.get(T(2)))).toMatchObject({ state: "running", threadRef: { threadId: "t3" } });
        expect((yield* tasks.get(T(2)))?.queuedReason).toBeUndefined();
      }),
    );
  });

  it("queues a second writer on a leased area with the holder named, and starts it when the holder is cancelled", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, spawnInput(ws));
        const second = yield* tasks.spawn(LEAD, spawnInput(ws, { title: "more docs" }));
        expect(second).toMatchObject({ state: "queued", queuedReason: "lease: docs held by T1" });

        const before = yield* head;
        const cancelled = yield* tasks.cancel(LEAD, T(1), "superseded");
        expect(cancelled).toMatchObject({ state: "cancelled", result: { status: "cancelled", tail: "superseded", branch: "fleetd/T1-add-file" } });
        expect(kit.interrupts).toEqual(["t2"]);
        yield* nextEvent(before, "task.cancelled");
        expect((yield* tasks.get(T(2)))).toMatchObject({ state: "running", branch: "fleetd/T2-more-docs" });
        expect(yield* leaseOwners).toEqual({ docs: "T2" });
        expect(yield* slotsUsed).toBe(1);

        // The interrupt's own thread event changes nothing and wakes nobody.
        yield* kit.threadEvent("t2", "thread.interrupted");
        yield* kit.threadEvent("t3", "thread.completed", "T2 done");
        yield* nextEvent(before, "task.completed", "T2");
        expect((yield* tasks.get(T(1)))?.state).toBe("cancelled");
        yield* TestClock.adjust(Duration.seconds(10));
        expect(kit.sends).toHaveLength(1);
        expect(kit.sends[0]!.message).not.toContain("- T1 failed");
        expect(kit.sends[0]!.message).toContain("- T2 completed: more docs");
      }),
    );
  });

  it("continues an ended task in the same thread, re-taking its slot and leases, and steers a running one", async () => {
    const kit = makeKit({ cap: 1 });
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, spawnInput(ws));
        yield* tasks.message(LEAD, T(1), "also add a title");
        expect(kit.sends.at(-1)).toEqual({ threadId: "t2", message: "also add a title" });

        let before = yield* head;
        yield* kit.threadEvent("t2", "thread.completed", "first pass");
        yield* nextEvent(before, "task.completed");
        // A reader takes the only slot meanwhile.
        yield* tasks.spawn(LEAD, spawnInput(ws, { title: "look", kind: "read", areas: [] }));

        const queued = yield* tasks.message(LEAD, T(1), "now fix the typo");
        expect(queued).toMatchObject({ state: "queued", attempt: 2, queuedReason: "slots: 1/1 in use" });
        expect(yield* leaseOwners).toEqual({ docs: "T1" });
        // A second message while it waits joins the first.
        yield* tasks.message(LEAD, T(1), "and the link");
        expect(kit.sends).toHaveLength(1);

        before = yield* head;
        yield* kit.threadEvent("t3", "thread.completed", "looked");
        yield* nextEvent(before, "task.started", "T1");
        expect(kit.sends.at(-1)).toEqual({ threadId: "t2", message: "now fix the typo\n\nand the link" });
        expect(kit.launches).toHaveLength(3);
        expect((yield* tasks.get(T(1)))).toMatchObject({ state: "running", attempt: 2, threadRef: { threadId: "t2" } });
        expect(yield* slotsUsed).toBe(1);
      }),
    );
  });

  it("resolves model and effort from the policy file, then the project, never defaulting to medium", async () => {
    const kit = makeKit({ policy: "areas:\n  docs: [docs/**]\ndefaults:\n  model: claude-sonnet-5-5\n" });
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        yield* (yield* LeadRecords.LeadRecords).settings.set(REF, { model: "claude-haiku-5-5", effort: "low" });
        const tasks = yield* Tasks.Tasks;
        const fromPolicy = yield* tasks.spawn(LEAD, spawnInput(ws));
        expect(fromPolicy).toMatchObject({ model: "claude-sonnet-5-5", effort: "low" });
        const explicit = yield* tasks.spawn(LEAD, spawnInput(ws, { title: "r", kind: "read", areas: [], model: "claude-opus-5-5", effort: "max" }));
        expect(explicit).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
      }),
    );
  });

  it("refuses unknown areas, workstreams of other projects and other projects' tasks", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        const unknown = yield* Effect.flip(tasks.spawn(LEAD, spawnInput(ws, { areas: ["web"] as never })));
        expect(unknown).toMatchObject({ code: "invalid", message: "Unknown area web.", fix: "Use areas from .fleetd/policy.yaml: docs, hub." });
        const missing = yield* Effect.flip(tasks.spawn(LEAD, spawnInput("W9")));
        expect(missing.code).toBe("not_found");
        yield* tasks.spawn(LEAD, spawnInput(ws));
        const other = { projectRef: { ...REF, projectId: "p2" as never }, by: "lead:lab-a/p2" };
        expect((yield* Effect.flip(tasks.cancel(other, T(1)))).code).toBe("not_found");
        expect((yield* Effect.flip(tasks.message(other, T(1), "hi"))).code).toBe("not_found");
      }),
    );
  });

  it("keeps a task queued while its machine is offline and launches it when the machine is back", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* kit.setOffline(true);
        const task = yield* tasks.spawn(LEAD, spawnInput(ws));
        expect(task).toMatchObject({ state: "queued", queuedReason: "machine lab-a is offline" });
        expect(yield* slotsUsed).toBe(0);
        const before = yield* head;
        yield* kit.setOffline(false);
        yield* nextEvent(before, "task.started");
        expect((yield* tasks.get(T(1)))?.state).toBe("running");
      }),
    );
  });

  it("frees the slot while a task waits for input, keeping its leases", async () => {
    const kit = makeKit({ cap: 1 });
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        const tasks = yield* Tasks.Tasks;
        yield* tasks.spawn(LEAD, spawnInput(ws));
        yield* tasks.spawn(LEAD, spawnInput(ws, { title: "look", kind: "read", areas: [] }));
        const before = yield* head;
        yield* kit.threadEvent("t2", "thread.waiting");
        yield* nextEvent(before, "task.started", "T2");
        // Thread events are handled in order, so once T2's end is handled, so is T1's wait.
        yield* kit.threadEvent("t3", "thread.completed", "looked");
        yield* nextEvent(before, "task.completed", "T2");
        expect((yield* tasks.get(T(1)))?.state).toBe("idle");
        expect(yield* leaseOwners).toEqual({ docs: "T1" });
        expect(yield* slotsUsed).toBe(0);
      }),
    );
  });

  it("wakes the lead with the question inline when a task waits for input", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        const ws = yield* kit.setup;
        yield* (yield* Tasks.Tasks).spawn(LEAD, spawnInput(ws));
        kit.questions.set("t2", "Which name should the file have? (options: x.md | y.md)");
        const before = yield* head;
        yield* kit.threadEvent("t2", "thread.waiting");
        // Handled in order: once the completion is handled, so is the wait before it.
        yield* kit.threadEvent("t2", "thread.completed", "Created docs/x.md.");
        yield* nextEvent(before, "task.completed", "T1");
        yield* TestClock.adjust(LeadWakes.WAKE_DEBOUNCE);
        expect(kit.sends).toHaveLength(1);
        expect(kit.sends[0]!.message).toContain(
          [
            "- T1 is waiting for input: add file",
            "  question:",
            "  > Which name should the file have? (options: x.md | y.md)",
            '  next: answer it with `fleetd task message T1 "<answer>"`',
          ].join("\n"),
        );
      }),
    );
  });
});
