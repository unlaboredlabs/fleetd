// The review gate on the tasks test kit (real Tasks and value bar), with the train played by the test: Changes in a
// Map, handed over on entering `reviewing` and marked ready the way the train does it. GitHub, patch ids and the
// provider list are faked.
import type { Change, ChangeId, ReviewVerdict, Task, TaskId, Tier, WorkstreamId } from "@fleetd/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { GitHub } from "../checks/GitHub.ts";
import { type ProviderInstance, ProviderList } from "../executor/ProviderList.ts";
import * as EventLog from "../store/EventLog.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { LEAD, makeKit, nextEvent, REF } from "../tasks/testKit.ts";
import { ValueBar } from "../valuebar/ValueBar.ts";
import { PatchIdError, PatchIds } from "./PatchIds.ts";
import { ReviewChanges } from "./ReviewChanges.ts";
import * as Reviews from "./Reviews.ts";

const PR = "https://github.com/wynn-dev/lab/pull/7";
const [H1, H2, H3, H4] = ["a", "b", "c", "d"].map((c) => c.repeat(40)) as [string, string, string, string];
const [P1, P2, P3] = ["1", "2", "3"].map((c) => c.repeat(40)) as [string, string, string];
const AT = "1970-01-01T00:00:00.000Z";
const X1 = "X1" as ChangeId;

const CLAUDE: ProviderInstance = { instanceId: "fleetd", driver: "claudeAgent", usable: true, models: ["claude-opus-5-5"] };
const CODEX: ProviderInstance = { instanceId: "fleetd-codex", driver: "codex", usable: true, models: ["gpt-6-astra"], defaultModel: "gpt-6-astra" };

const makeReviewKit = (options: { readonly providers?: ReadonlyArray<ProviderInstance> } = {}) => {
  const kit = makeKit();
  const changes = new Map<string, Change>();
  /** Head SHA → patch id, as the node would compute it for heads the train did not hand over. */
  const patches = new Map<string, string>();
  /** Completed with the first SHA the node is asked about; the gate's lock is held while it binds that verdict. */
  const computed = Deferred.makeUnsafe<string>();

  // The train's side: `change.ready` is what it emits when it marks a Change ready.
  const trainSide = Layer.effect(
    ReviewChanges,
    Effect.map(EventLog.EventLog, (log) =>
      ReviewChanges.of({
        get: (changeId) => Effect.sync(() => changes.get(changeId)),
        note: (changeId, text) =>
          Effect.sync(() => {
            const c = changes.get(changeId);
            if (c !== undefined) changes.set(changeId, { ...c, lastError: text });
          }),
        markReady: (changeId, reviews) =>
          Effect.gen(function* () {
            const c = changes.get(changeId);
            if (c?.state !== "reviewing") return yield* Effect.fail({ message: `${changeId} is not reviewing` });
            changes.set(changeId, { ...c, state: "ready", reviews: [...c.reviews, ...reviews] });
            yield* log.append({ at: AT, type: "change.ready", machineId: REF.machineId, projectId: REF.projectId, summary: `${changeId} ready`, data: { changeId } });
          }),
      }),
    ),
  );
  const fakes = Layer.mergeAll(
    Layer.succeed(
      PatchIds,
      PatchIds.of({
        compute: ({ sha }) => {
          const id = patches.get(sha);
          return Effect.andThen(
            Deferred.succeed(computed, sha),
            id === undefined ? Effect.fail(new PatchIdError({ message: `no patch id for ${sha}` })) : Effect.succeed(id),
          );
        },
      }),
    ),
    Layer.succeed(GitHub, GitHub.of({ api: () => Effect.succeed({ base: { ref: "main" } }) })),
    Layer.succeed(ProviderList, ProviderList.of({ instances: () => Effect.succeed(options.providers ?? [CLAUDE]) })),
  );
  const layer = Reviews.layer.pipe(Layer.provideMerge(Layer.merge(fakes, trainSide)), Layer.provideMerge(kit.layer));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)));

  /** What the train does when the Change enters `reviewing` at `head` with `patchId`: store it, ask the gate. */
  const handOver = (fields: { readonly ws: WorkstreamId; readonly tier?: Tier; readonly author?: Task; readonly head?: string; readonly patchId?: string }) =>
    Effect.gen(function* () {
      const previous = changes.get(X1);
      const change = {
        changeId: X1,
        projectRef: REF,
        repo: "wynn-dev/lab",
        prNumber: 7,
        prUrl: PR,
        branch: fields.author?.branch ?? "fleetd/T1-docs",
        ...(fields.author === undefined ? {} : { taskId: fields.author.taskId }),
        workstreamId: fields.ws,
        serves: "done:0",
        tier: fields.tier ?? previous?.tier ?? "M",
        headSha: fields.head ?? H1,
        patchId: fields.patchId ?? P1,
        state: "reviewing",
        reviews: previous?.reviews ?? [],
        createdAt: AT,
        updatedAt: AT,
      } as Change;
      changes.set(X1, change);
      const answer = yield* (yield* Reviews.Reviews).review(change);
      if (answer === "ready") changes.set(X1, { ...changes.get(X1)!, state: "ready" });
      return answer;
    });

  /** The next `n` tasks started after `cursor`. */
  const started = (cursor: number, n: number) =>
    Effect.gen(function* () {
      const tasks = yield* Tasks.Tasks;
      const found: Array<Task> = [];
      let after = cursor;
      while (found.length < n) {
        const event = yield* nextEvent(after, "task.started");
        after = event.seq;
        found.push((yield* tasks.get((event.data as { taskId: TaskId }).taskId))!);
      }
      return found;
    });

  const reviewTasks = (ws: WorkstreamId) =>
    Effect.map(Effect.flatMap(Tasks.Tasks, (t) => t.list({ ref: REF, workstreamId: ws, limit: 50 })), (list) => list.filter((t) => t.kind === "review").reverse());

  const verdict = (task: Task, sha: string, blocking: number, summary = "fine") =>
    Effect.flatMap(ValueBar, (bar) => bar.recordVerdict(LEAD, { taskId: task.taskId, prHeadSha: sha, blocking, nonBlocking: 1, summary } as ReviewVerdict));

  const complete = (task: Task, text = "done") => kit.threadEvent(task.threadRef!.threadId, "thread.completed", text);
  const head = () => Effect.flatMap(EventLog.EventLog, (log) => log.head());
  const change = () => changes.get(X1)!;

  return { kit, patches, computed, run, handOver, started, reviewTasks, verdict, complete, head, change };
};

type ReviewKit = ReturnType<typeof makeReviewKit>;

/** A write task that opened the PR and has ended, as the Change's author. */
const author = (r: ReviewKit, ws: WorkstreamId) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks.Tasks;
    const task = yield* tasks.spawn(LEAD, { workstreamId: ws, title: "docs page", kind: "write", prompt: "write it", areas: ["docs"] as never, serves: "done:0" });
    const cursor = yield* r.head();
    yield* r.complete(task, "I wrote a lovely docs page and opened the PR.");
    yield* nextEvent(cursor, "task.completed", task.taskId);
    return (yield* tasks.get(task.taskId))!;
  });

describe("Reviews", () => {
  it("lets tier S through at once and gives tier M one reviewer that sees the diff ref and the brief, not the author", async () => {
    const r = makeReviewKit();
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        const writer = yield* author(r, ws);
        expect(yield* r.handOver({ ws, tier: "S", author: writer })).toBe("ready");
        expect(yield* r.reviewTasks(ws)).toEqual([]);

        const cursor = yield* r.head();
        expect(yield* r.handOver({ ws, tier: "M", author: writer })).toBe("pending");
        const [reviewer] = yield* r.started(cursor, 1);
        expect(reviewer).toMatchObject({ kind: "review", pr: PR, serves: "done:0", tier: "M", model: "claude-opus-5-5" });
        expect(reviewer!.prompt).toContain("gh pr diff 7 --repo wynn-dev/lab");
        expect(reviewer!.prompt).toContain(H1);
        expect(reviewer!.prompt).not.toContain("lovely docs page");

        const before = yield* r.head();
        yield* r.verdict(reviewer!, H1, 0);
        yield* nextEvent(before, "change.ready");
        expect(r.change()).toMatchObject({ state: "ready", reviews: [{ taskId: reviewer!.taskId, prHeadSha: H1, patchId: P1, blocking: 0 }] });
      }),
    );
  });

  it("gives tier L two reviewers, the second on Codex, and a verifier whose verdict counts once its receipts are in", async () => {
    const r = makeReviewKit({ providers: [CLAUDE, CODEX] });
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        const cursor = yield* r.head();
        expect(yield* r.handOver({ ws, tier: "L" })).toBe("pending");
        const [first, second, verifier] = yield* r.started(cursor, 3);
        expect([first, second, verifier].map((t) => `${t!.title.split(" ")[0]} ${t!.model}`)).toEqual([
          "Review claude-opus-5-5",
          "Review gpt-6-astra",
          "Verify claude-opus-5-5",
        ]);
        expect(r.change().lastError).toBeUndefined();

        yield* r.verdict(first!, H1, 0);
        yield* r.verdict(second!, H1, 0);
        // The verifier tested a cleanly rebased head; the node says it is the same patch.
        r.patches.set(H2, P1);
        yield* r.verdict(verifier!, H2, 0, "pnpm test exited 0");
        expect(yield* Deferred.await(r.computed)).toBe(H2);
        // Three clean verdicts on the patch, but the verifier's task has not ended with its receipts yet.
        expect(yield* r.handOver({ ws })).toBe("pending");

        const before = yield* r.head();
        yield* r.complete(verifier!);
        yield* nextEvent(before, "change.ready");
        expect(r.change().reviews.map((v) => `${v.taskId}@${v.patchId[0]}`)).toEqual([`${first!.taskId}@1`, `${second!.taskId}@1`, `${verifier!.taskId}@1`]);
      }),
    );
  });

  it("falls back to two Claude reviewers and notes it on the Change when the machine has no usable fleetd Codex instance", async () => {
    const r = makeReviewKit({ providers: [CLAUDE, { ...CODEX, usable: false }, { ...CODEX, instanceId: "codex" }] });
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        const cursor = yield* r.head();
        yield* r.handOver({ ws, tier: "L" });
        const spawned = yield* r.started(cursor, 3);
        expect(spawned.map((t) => t.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
        expect(r.change().lastError).toBe(
          'Codex codex on lab-a is not fleetd\'s (ids must start with "fleetd"; others could reach T3\'s spawn tools), so both L reviewers run on Claude.',
        );
      }),
    );
  });

  it("carries reviews over a head with the same patch id, re-reviews a changed one, and stops at the polish-loop rule", async () => {
    const r = makeReviewKit();
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        let cursor = yield* r.head();
        yield* r.handOver({ ws });
        const [first] = yield* r.started(cursor, 1);
        cursor = yield* r.head();
        yield* r.verdict(first!, H1, 0);
        yield* nextEvent(cursor, "change.ready");

        // A clean rebase: new head, same patch id. Its review still counts and nobody is spawned.
        expect(yield* r.handOver({ ws, head: H2, patchId: P1 })).toBe("ready");
        expect(yield* r.reviewTasks(ws)).toHaveLength(1);

        // A changed patch: the earlier review counts for nothing and a fresh reviewer gets the new head.
        cursor = yield* r.head();
        expect(yield* r.handOver({ ws, head: H3, patchId: P2 })).toBe("pending");
        const [second] = yield* r.started(cursor, 1);
        expect(second!.prompt).toContain(H3);
        cursor = yield* r.head();
        yield* r.verdict(second!, H3, 0);
        yield* nextEvent(cursor, "change.ready");
        expect(r.change().reviews.map((v) => `${v.taskId}@${v.patchId[0]}`)).toEqual([`${first!.taskId}@1`, `${second!.taskId}@2`]);

        // Two clean rounds on different heads: a third patch rides on them instead of a third round.
        expect(yield* r.handOver({ ws, head: H4, patchId: P3 })).toBe("ready");
        expect(yield* r.reviewTasks(ws)).toHaveLength(2);
        expect(r.change().lastError).toContain("review waived by the polish-loop rule");
      }),
    );
  });

  it("sends blocking findings to the author task and holds the patch until the train brings a new one", async () => {
    const r = makeReviewKit();
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        const writer = yield* author(r, ws);
        let cursor = yield* r.head();
        yield* r.handOver({ ws, author: writer });
        const [reviewer] = yield* r.started(cursor, 1);

        cursor = yield* r.head();
        yield* r.verdict(reviewer!, H1, 2, "docs/a.md:3 links to a page that does not exist; docs/a.md:9 wrong flag");
        yield* nextEvent(cursor, "task.started", writer.taskId);
        const sent = r.kit.sends.at(-1)!;
        expect(sent.threadId).toBe(writer.threadRef!.threadId);
        expect(sent.message).toContain(`Review ${reviewer!.taskId} of ${PR} at ${H1.slice(0, 12)} found 2 blocking findings`);
        expect(sent.message).toContain("docs/a.md:3 links to a page that does not exist");
        expect(r.change()).toMatchObject({
          state: "reviewing",
          lastError: `waiting for a new head: ${reviewer!.taskId} found 2 blocking at ${H1.slice(0, 12)}; sent to ${writer.taskId}`,
        });
        // Asked again about the same patch, the gate keeps waiting instead of reviewing it again.
        expect(yield* r.handOver({ ws, author: writer })).toBe("pending");
        expect(yield* r.reviewTasks(ws)).toHaveLength(1);

        // The author pushed a fix; the train hands over its new patch, which gets a fresh reviewer.
        cursor = yield* r.head();
        expect(yield* r.handOver({ ws, author: writer, head: H2, patchId: P2 })).toBe("pending");
        const [again] = yield* r.started(cursor, 1);
        expect(again).toMatchObject({ kind: "review", pr: PR });
        expect(again!.taskId).not.toBe(reviewer!.taskId);
        expect(again!.prompt).toContain(H2);
      }),
    );
  });

  it("binds a verdict on a head the train never handed over to that head's own patch id", async () => {
    const r = makeReviewKit();
    await r.run(
      Effect.gen(function* () {
        const ws = yield* r.kit.setup;
        let cursor = yield* r.head();
        yield* r.handOver({ ws });
        const [reviewer] = yield* r.started(cursor, 1);
        // The reviewer looked at a newer push, whose diff differs: the node says it is another patch.
        r.patches.set(H2, P2);
        yield* r.verdict(reviewer!, H2, 0);
        expect(yield* Deferred.await(r.computed)).toBe(H2);
        // Its clean verdict is bound to P2, so it does not count for the Change at P1 once the gate is asked again.
        expect(yield* r.handOver({ ws })).toBe("pending");
        expect(r.change().state).toBe("reviewing");
        expect(yield* r.handOver({ ws, head: H2, patchId: P2 })).toBe("ready");
      }),
    );
  });
});
