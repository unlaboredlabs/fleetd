import type { ChangeId, DecisionKey, HubEventType, TaskId, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import * as Incidents from "../incidents/Incidents.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, nextEvent } from "../tasks/testKit.ts";
import { makeTrainKit, REF, REPO, runTrainKit, type TrainKit } from "./testKit.ts";
import { Train } from "./Train.ts";

const events = (type: HubEventType) =>
  Effect.map(
    Effect.flatMap(EventLog.EventLog, (log) => log.wait({ cursor: 0, types: [type], timeoutSec: 0 })),
    (page) => page.events,
  );

const withKit = <A, E>(f: (kit: TrainKit, ws: WorkstreamId) => Effect.Effect<A, E, Layer.Success<TrainKit["layer"]>>) => {
  const kit = makeTrainKit();
  return runTrainKit(kit, Effect.flatMap(kit.setup, (ws) => f(kit, ws)));
};

/** A write task that opened the kit's default PR (#7): spawned, completed, and so auto-enqueued. */
const authorTask = (ws: WorkstreamId) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.Tasks;
    const log = yield* EventLog.EventLog;
    const task = yield* tasks.spawn(LEAD, { workstreamId: ws, title: "write docs", kind: "write", prompt: "write it", areas: ["docs"] as never, serves: "done:0" });
    return { task, cursor: yield* log.head() };
  });

describe("Train", () => {
  it("refuses a PR without a valid Source: line with the fix, writing a refused row only when the serves is known", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        const noSource = kit.openPr(3, "no-source", { "b.txt": "b\n" }, "Adds b.");
        const refused = yield* Effect.flip(train.enqueue(LEAD, { prUrl: noSource, workstreamId: ws }));
        expect(refused).toMatchObject({ code: "invalid", fix: "add 'Source: done:0' to the PR body" });
        expect(yield* train.list({ limit: 10 })).toEqual([]);

        const wrong = kit.openPr(4, "wrong-source", { "c.txt": "c\n" }, "Source: done:5");
        const mismatch = yield* Effect.flip(train.enqueue(LEAD, { prUrl: wrong, workstreamId: ws, serves: "done:0" }));
        expect(mismatch.fix).toBe("change the PR body's line to 'Source: done:0'");
        expect(yield* train.list({ limit: 10 })).toMatchObject([{ prNumber: 4, state: "refused", serves: "done:0" }]);

        expect((yield* events("change.refused")).map((e) => (e.data as { fix: string }).fix)).toEqual([
          "add 'Source: done:0' to the PR body",
          "change the PR body's line to 'Source: done:0'",
        ]);
      }),
    ));

  it("auto-enqueues a write task's PR, rebases it onto the moved base, waits for CI and merges pinned with fleetd/train", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        kit.openPr(7, "docs", { "docs.md": "docs\n" });
        const { task, cursor } = yield* authorTask(ws);
        yield* kit.tasksKit.threadEvent("t2", "thread.completed", "Opened https://github.com/wynn-dev/lab/pull/7");
        // Enqueued from the task's completion; ready once its patch id is read, since tier S needs no review.
        const changeId = ((yield* nextEvent(cursor, "change.ready")).data as { changeId: ChangeId }).changeId;
        const before = (yield* train.get(changeId))!;
        expect(before).toMatchObject({ state: "ready", taskId: task.taskId, tier: "S", serves: "done:0", position: 0, branch: "docs" });

        // main moves on in another file: a clean rebase that keeps the patch id.
        kit.commit("main", { "other.txt": "other\n" });
        expect(yield* train.step(REPO)).toBe(true);

        const merged = (yield* train.get(changeId))!;
        expect(merged.state).toBe("merged");
        expect(merged.patchId).toBe(before.patchId);
        expect(merged.headSha).not.toBe(before.headSha);
        expect(kit.merges).toEqual([{ prNumber: 7, sha: merged.headSha }]);
        expect(kit.statuses).toEqual([{ sha: merged.headSha, context: "fleetd/train", state: "success" }]);
        expect(merged.mergedSha).toBe(kit.headOf("main"));
        expect(kit.mainFile("docs.md")).toBe("docs");
        expect(kit.mainFile("other.txt")).toBe("other");
        expect((yield* events("pr.merged")).map((e) => e.data)).toEqual([{ changeId, repo: REPO, prNumber: 7, mergedSha: merged.mergedSha }]);
        expect(yield* train.state(REPO)).toEqual({ repo: REPO, frozen: false, queue: [] });
      }),
    ));

  it("sends a conflicting PR back to its author with the paths, moves on, and merges it after the author pushes", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        kit.openPr(7, "edit-a", { "a.txt": kit.aWith({ 5: "author's line 5" }) });
        const { task, cursor } = yield* authorTask(ws);
        yield* kit.tasksKit.threadEvent("t2", "thread.completed", "done");
        const first = (yield* nextEvent(cursor, "change.ready")).data as { changeId: ChangeId };
        const other = yield* train.enqueue(LEAD, { prUrl: kit.openPr(8, "other", { "b.txt": "b\n" }), workstreamId: ws });
        kit.commit("main", { "a.txt": kit.aWith({ 5: "main's line 5" }) });

        expect(yield* train.step(REPO)).toBe(true);
        expect(yield* train.get(first.changeId)).toMatchObject({ state: "needs_rebase", lastError: "conflicts with origin/main in a.txt" });
        expect((yield* events("change.needs_rebase")).map((e) => e.data)).toEqual([{ changeId: first.changeId, paths: ["a.txt"] }]);
        const told = kit.tasksKit.sends.at(-1)!;
        expect(told.threadId).toBe("t2");
        expect(told.message).toContain("conflicts with origin/main in a.txt");
        expect((yield* (yield* Tasks.Tasks).get(task.taskId as TaskId))?.state).toBe("running");

        // The train moves on to the next ready PR.
        expect(yield* train.step(REPO)).toBe(true);
        expect((yield* train.get(other.changeId))?.state).toBe("merged");

        // The author resolves onto the new main and pushes; the train takes the new head.
        kit.commit("edit-a", { "a.txt": kit.aWith({ 5: "both line 5" }) }, "origin/main");
        expect(yield* train.step(REPO)).toBe(true);
        expect(yield* train.get(first.changeId)).toMatchObject({ state: "merged" });
        expect(kit.mainFile("a.txt")).toContain("both line 5");
        expect((yield* events("pr.merged")).map((e) => (e.data as { changeId: string }).changeId)).toEqual([other.changeId, first.changeId]);
      }),
    ));

  it("parks a PR whose CI is red, wakes its author with the failing check and log, and never merges it", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        kit.openPr(7, "red", { FAIL: "x\n" });
        const { cursor } = yield* authorTask(ws);
        yield* kit.tasksKit.threadEvent("t2", "thread.completed", "done");
        const { changeId } = (yield* nextEvent(cursor, "change.ready")).data as { changeId: ChangeId };

        expect(yield* train.step(REPO)).toBe(true);
        expect(yield* train.get(changeId)).toMatchObject({ state: "ci_failed" });
        const logUrl = `https://github.com/${REPO}/actions/runs/1`;
        expect((yield* events("change.ci_failed")).map((e) => e.data)).toEqual([{ changeId, checks: ["ci"], logUrl }]);
        expect(kit.tasksKit.sends.at(-1)?.message).toContain(`ci (failure) (log: ${logUrl})`);
        expect(kit.statuses).toEqual([]);
        expect(kit.merges).toEqual([]);
        // Nothing new pushed: it stays parked.
        expect(yield* train.step(REPO)).toBe(false);
        expect(kit.merges).toEqual([]);
      }),
    ));

  it("re-queues at the front when GitHub refuses the pinned merge with 409, then merges", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        const a = yield* train.enqueue(LEAD, { prUrl: kit.openPr(7, "a", { "b.txt": "b\n" }), workstreamId: ws });
        const b = yield* train.enqueue(LEAD, { prUrl: kit.openPr(8, "b", { "c.txt": "c\n" }), workstreamId: ws });
        kit.mergeReplies.push({ exitCode: 1, stdout: "{}", stderr: "gh: Head branch was modified. (HTTP 409)\n" });

        expect(yield* train.step(REPO)).toBe(true);
        expect(yield* train.get(a.changeId)).toMatchObject({ state: "ready", position: 0, lastError: "GitHub refused the merge (HTTP 409): Head branch was modified. (HTTP 409)" });
        expect(yield* train.state(REPO)).toEqual({ repo: REPO, frozen: false, queue: [a.changeId, b.changeId] });

        expect(yield* train.step(REPO)).toBe(true);
        expect((yield* train.get(a.changeId))?.state).toBe("merged");
        expect(kit.merges.map((m) => m.prNumber)).toEqual([7]);
      }),
    ));

  it("holds while policy.freeze.<owner>.<name> is true and resumes when the decision goes", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        const decisions = yield* Decisions;
        const change = yield* train.enqueue(LEAD, { prUrl: kit.openPr(7, "a", { "b.txt": "b\n" }), workstreamId: ws });
        const freeze = yield* decisions.record(
          { key: "policy.freeze.wynn-dev.lab" as DecisionKey, scope: { kind: "project", projectRef: REF }, value: "true", why: "release week" },
          { source: "human", by: "human:test" },
        );

        expect(yield* train.step(REPO)).toBe(false);
        expect(yield* train.step(REPO)).toBe(false);
        expect((yield* events("train.frozen")).map((e) => e.data)).toEqual([{ repo: REPO, reason: "release week" }]);
        expect(yield* train.state(REPO)).toMatchObject({ frozen: true, queue: [change.changeId] });
        expect(kit.merges).toEqual([]);

        yield* decisions.retire(freeze.decisionId);
        expect(yield* train.step(REPO)).toBe(true);
        expect((yield* events("train.resumed")).map((e) => e.data)).toEqual([{ repo: REPO }]);
        expect((yield* train.get(change.changeId))?.state).toBe("merged");
      }),
    ));

  it("sends a Change back to reviewing when a clean rebase changes its patch id, and refuses reviews of the old patch", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        const change = yield* train.enqueue(LEAD, { prUrl: kit.openPr(7, "m", { "a.txt": kit.aWith({ 6: "pr line 6" }) }), workstreamId: ws, tier: "M" });
        expect(change).toMatchObject({ state: "reviewing", tier: "M" });
        expect(kit.reviewed.map((c) => c.changeId)).toEqual([change.changeId]);
        const review = { taskId: "T9" as TaskId, prHeadSha: change.headSha, patchId: change.patchId!, blocking: 0, nonBlocking: 1 };
        expect(yield* train.markReady(change.changeId, [review])).toMatchObject({ state: "ready", reviews: [review] });

        // main edits a line inside the PR hunk's context: the rebase is clean but the patch differs.
        kit.commit("main", { "a.txt": kit.aWith({ 4: "main line 4" }) });
        expect(yield* train.step(REPO)).toBe(true);
        const after = (yield* train.get(change.changeId))!;
        expect(after.state).toBe("reviewing");
        expect(after.patchId).not.toBe(change.patchId);
        expect(after.headSha).toBe(kit.headOf("m"));
        expect(kit.reviewed.map((c) => c.patchId)).toEqual([change.patchId, after.patchId]);
        expect(kit.merges).toEqual([]);

        const stale = yield* Effect.flip(train.markReady(change.changeId, [review]));
        expect(stale.message).toContain("T9 reviewed patch");
        yield* train.markReady(change.changeId, [{ ...review, taskId: "T10" as TaskId, prHeadSha: after.headSha, patchId: after.patchId! }]);
        expect(yield* train.step(REPO)).toBe(true);
        expect((yield* train.get(change.changeId))?.state).toBe("merged");
      }),
    ));

  it("records a policy_bypass incident, once, for a merge on a watched repo the train did not do", () =>
    withKit((kit, ws) =>
      Effect.gen(function* () {
        const train = yield* Train;
        const ours = yield* train.enqueue(LEAD, { prUrl: kit.openPr(7, "a", { "b.txt": "b\n" }), workstreamId: ws });
        kit.openPr(9, "sneaky", { "c.txt": "c\n" });
        Object.assign(kit.pulls.get(9)!, { state: "closed", merged: true, mergeSha: "f".repeat(40), mergedAt: "2026-10-17T12:30:00Z" });

        expect(yield* train.step(REPO)).toBe(true);
        expect((yield* train.get(ours.changeId))?.state).toBe("merged");
        yield* train.step(REPO);
        const incidents = yield* (yield* Incidents.Incidents).list({ class: "policy_bypass", limit: 10 });
        expect(incidents).toHaveLength(1);
        expect(incidents[0]).toMatchObject({ projectRef: REF });
        expect(incidents[0]!.evidence[0]).toBe(`${REPO}#9 was merged at 2026-10-17T12:30:00Z without the merge train (ffffffffffff).`);
      }),
    ));
});
