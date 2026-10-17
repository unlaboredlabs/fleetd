// The merge train's review gate. Each time a Change enters `reviewing` the train hands it over with its current patch
// id; the gate spawns the tier's review tasks through Tasks and answers "pending", or "ready" when that patch needs
// nothing more. Every verdict is bound to the patch id of the head it reviewed, and only verdicts bound to the Change's
// current patch id count. Blocking findings go back to the author task and the Change waits for a new head, which the
// train brings back here with its new patch id; M6's polish-loop rule caps those rounds.
import type { Change, ChangeId, ChangeReview, HubEvent, HubEventType, Task, TaskId } from "@fleetd/contracts";
import { ReviewVerdict } from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitHub } from "../checks/GitHub.ts";
import { codexInstance, ProviderList } from "../executor/ProviderList.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { prKey, reviewRefusal } from "../valuebar/rules.ts";
import { PatchIds } from "./PatchIds.ts";
import { ReviewChanges } from "./ReviewChanges.ts";
import { findingsMessage, gate, hasReceipts, missingReviews, oneLine, reviewPlan, reviewPrompt, type ReviewRole, type RoleReview } from "./rules.ts";

/** Recorded as the spawner of review tasks and the sender of findings. */
export const REVIEWS_BY = "hub:reviews";

export class Reviews extends Context.Service<
  Reviews,
  {
    /**
     * The train's ReviewGate: called whenever a Change enters `reviewing`, with its current head and patch id. "ready"
     * when the tier needs nothing more for that patch; otherwise "pending", and `ReviewChanges.markReady` follows once
     * the reviews are in.
     */
    readonly review: (change: Change) => Effect.Effect<"ready" | "pending">;
  }
>()("fleetd/reviews/Reviews") {}

const FOLLOWED: ReadonlyArray<HubEventType> = ["review.verdict", "task.completed", "task.failed", "task.cancelled"];

const PullBase = Schema.Struct({ base: Schema.Struct({ ref: Schema.String }) });
const decodePull = Schema.decodeUnknownOption(PullBase);
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewVerdict));

class ReviewFailure extends Schema.TaggedError<ReviewFailure>()("ReviewFailure", { message: Schema.String }) {}

const dataOf = (event: HubEvent) => (event.data ?? {}) as Record<string, unknown>;

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const events = yield* EventLog.EventLog;
  const store = yield* HubStore.HubStore;
  const tasks = yield* Tasks.Tasks;
  const github = yield* GitHub;
  const patchIds = yield* PatchIds;
  const providers = yield* ProviderList;
  const changes = yield* ReviewChanges;
  const lock = Semaphore.makeUnsafe(1);

  const sql = {
    putTask: db.prepare("INSERT OR IGNORE INTO review_tasks (task_id, change_id, role, patch_id) VALUES (?, ?, ?, ?)"),
    task: db.prepare("SELECT change_id, role FROM review_tasks WHERE task_id = ?"),
    rolesFor: db.prepare("SELECT role FROM review_tasks WHERE change_id = ? AND patch_id = ?"),
    bind: db.prepare(
      "INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking) VALUES (?, ?, ?, ?, ?)",
    ),
    bound: db.prepare(
      `SELECT b.task_id, b.pr_head_sha, b.patch_id, b.blocking, b.non_blocking, t.role
       FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id WHERE t.change_id = ? AND b.patch_id = ?`,
    ),
    boundTask: db.prepare("SELECT 1 FROM review_bindings WHERE task_id = ? LIMIT 1"),
    patchOf: db.prepare("SELECT patch_id FROM review_patch_ids WHERE change_id = ? AND head_sha = ?"),
    putPatch: db.prepare("INSERT OR REPLACE INTO review_patch_ids (change_id, head_sha, patch_id) VALUES (?, ?, ?)"),
    waiver: db.prepare("SELECT reason FROM review_waivers WHERE change_id = ? AND patch_id = ?"),
    putWaiver: db.prepare("INSERT OR IGNORE INTO review_waivers (change_id, patch_id, reason) VALUES (?, ?, ?)"),
    // The value bar's table: a verdict's full text, and the PR's verdict history its rules read.
    verdict: db.prepare("SELECT data FROM review_verdicts WHERE task_id = ? AND sha = ? ORDER BY n DESC LIMIT 1"),
    prVerdicts: db.prepare("SELECT task_id, sha, blocking FROM review_verdicts WHERE pr_key = ? ORDER BY n DESC LIMIT 200"),
  };

  const reviewerTask = (taskId: string) => {
    const row = sql.task.get(taskId);
    return row === undefined ? undefined : { changeId: String(row.change_id) as ChangeId, role: String(row.role) as ReviewRole };
  };

  /** The patch id of `sha`: known from the train for heads it handed over, else computed on the project's machine. */
  const patchFor = (change: Change, sha: string) =>
    Effect.gen(function* () {
      const known = sql.patchOf.get(change.changeId, sha);
      if (known !== undefined) return String(known.patch_id);
      const project = yield* store.projects.get(change.projectRef);
      if (project === undefined) return yield* new ReviewFailure({ message: `the hub has no record of project ${change.projectRef.projectId}` });
      const pull = yield* github.api(`repos/${change.repo}/pulls/${change.prNumber}`).pipe(Effect.mapError((e) => new ReviewFailure({ message: e.message })));
      const base = decodePull(pull);
      if (base._tag === "None") return yield* new ReviewFailure({ message: `GitHub returned no base branch for ${change.prUrl}` });
      const patchId = yield* patchIds
        .compute({ machineId: change.projectRef.machineId, cwd: project.workspaceRoot, base: base.value.base.ref, prNumber: change.prNumber, sha })
        .pipe(Effect.mapError((e) => new ReviewFailure({ message: e.message })));
      sql.putPatch.run(change.changeId, sha, patchId);
      return patchId;
    });

  /** The verdicts bound to `patchId`, with their roles, as the gate and `markReady` take them. */
  const boundTo = (change: Change, patchId: string) =>
    Effect.forEach(sql.bound.all(change.changeId, patchId), (row) =>
      Effect.gen(function* () {
        const role = String(row.role) as ReviewRole;
        const taskId = String(row.task_id) as TaskId;
        const review: ChangeReview = {
          taskId,
          prHeadSha: String(row.pr_head_sha),
          patchId,
          blocking: Number(row.blocking),
          nonBlocking: Number(row.non_blocking),
        };
        const receipts = role === "verifier" && hasReceipts(yield* tasks.get(taskId));
        return { review, role: { taskId, role, patchId, blocking: review.blocking, receipts } satisfies RoleReview };
      }),
    );

  const gateFor = (change: Change, patchId: string) =>
    Effect.gen(function* () {
      const bound = yield* boundTo(change, patchId);
      const waived = sql.waiver.get(change.changeId, patchId);
      const g = gate(change.tier, patchId, bound.map((b) => b.role), waived === undefined ? undefined : String(waived.reason));
      return { gate: g, reviews: bound.map((b) => b.review) };
    });

  const spawnReview = (change: Change, role: ReviewRole, model: string | undefined) =>
    tasks.spawn(
      { projectRef: change.projectRef, by: REVIEWS_BY },
      {
        workstreamId: change.workstreamId,
        title: oneLine(`${role === "verifier" ? "Verify" : "Review"} ${change.repo}#${change.prNumber} for ${change.changeId}`, 80),
        kind: "review",
        prompt: reviewPrompt(change, role),
        areas: [],
        serves: change.serves,
        pr: change.prUrl,
        tier: change.tier,
        ...(model === undefined ? {} : { model }),
      },
    );

  /** Spawns what the tier still needs for this patch. Idempotent per patch; a waived patch needs nothing. */
  const ensureRound = (change: Change, patchId: string) =>
    Effect.gen(function* () {
      const codex =
        change.tier === "L"
          ? yield* providers.instances(change.projectRef.machineId).pipe(Effect.map(codexInstance), Effect.orElseSucceed(() => undefined))
          : undefined;
      const spawned = sql.rolesFor.all(change.changeId, patchId).map((r) => String(r.role) as ReviewRole);
      const missing = missingReviews(reviewPlan(change.tier, codex !== undefined), spawned);
      if (missing.length === 0) return;

      // The hub's rounds are held to M6's review rules like anyone's. When the polish-loop rule says review is over for
      // this PR, this patch rides on the earlier clean rounds instead of getting a third.
      const verdicts = sql.prVerdicts.all(prKey(change.prUrl)).map((r) => ({ taskId: String(r.task_id), sha: String(r.sha), blocking: Number(r.blocking) }));
      const refusal = reviewRefusal({ workstreamId: change.workstreamId, kind: "review", pr: change.prUrl }, REVIEWS_BY, change.headSha, verdicts);
      if (refusal?.polishLoop !== undefined) {
        const reason = `review waived by the polish-loop rule: ${refusal.message}`;
        sql.putWaiver.run(change.changeId, patchId, reason);
        return yield* changes.note(change.changeId, reason);
      }
      if (refusal !== undefined) return yield* changes.note(change.changeId, `no review round for patch ${patchId.slice(0, 12)}: ${refusal.message}`);

      if (change.tier === "L" && codex === undefined) {
        yield* changes.note(change.changeId, `No usable Codex instance on ${change.projectRef.machineId}, so both L reviewers run on Claude.`);
      }
      for (const planned of missing) {
        const started = yield* Effect.result(spawnReview(change, planned.role, planned.provider === "codex" ? codex?.defaultModel : undefined));
        if (started._tag === "Failure") {
          yield* changes.note(change.changeId, `could not spawn the ${planned.role}: ${started.failure.message}`);
          continue;
        }
        const task: Task = started.success;
        // A task T3 refused to launch is not counted, so the next review of this patch tries that role again.
        if (task.state === "failed") {
          yield* changes.note(change.changeId, `the ${planned.role} ${task.taskId} failed to start: ${task.result?.tail ?? ""}`);
          continue;
        }
        sql.putTask.run(task.taskId, change.changeId, planned.role, patchId);
      }
    });

  const review: Reviews["Service"]["review"] = (change) =>
    Effect.gen(function* () {
      if (change.tier === "S") return "ready" as const;
      const patchId = change.patchId ?? (yield* patchFor(change, change.headSha));
      sql.putPatch.run(change.changeId, change.headSha, patchId);
      const before = yield* gateFor(change, patchId);
      // Ready on this patch already (a carried-over patch), or held by its blocking findings until the head moves.
      if (before.gate.ready) return "ready" as const;
      if (before.gate.waitingForHead) return "pending" as const;
      yield* ensureRound(change, patchId);
      return (yield* gateFor(change, patchId)).gate.ready ? ("ready" as const) : ("pending" as const);
    }).pipe(
      Effect.catchTag("ReviewFailure", (e) => Effect.as(changes.note(change.changeId, `reviews: ${e.message}`), "pending" as const)),
      lock.withPermit,
    );

  /** Marks the Change ready once its current patch satisfies the tier. */
  const evaluate = (changeId: ChangeId) =>
    Effect.gen(function* () {
      const change = yield* changes.get(changeId);
      if (change === undefined || change.state !== "reviewing" || change.patchId === undefined) return;
      const { gate: g, reviews } = yield* gateFor(change, change.patchId);
      if (!g.ready) return;
      const marked = yield* Effect.result(changes.markReady(changeId, reviews));
      if (marked._tag === "Failure") yield* Effect.logWarning("reviews: mark ready refused", { changeId, error: marked.failure.message });
    });

  const onVerdict = (event: HubEvent) =>
    Effect.gen(function* () {
      const data = dataOf(event);
      const taskId = String(data.taskId) as TaskId;
      const row = reviewerTask(taskId);
      if (row === undefined) return;
      const change = yield* changes.get(row.changeId);
      if (change === undefined) return;
      const sha = String(data.prHeadSha);
      const blocking = Number(data.blocking);
      const nonBlocking = Number(data.nonBlocking);
      const patchId = yield* patchFor(change, sha);
      sql.bind.run(taskId, sha, patchId, blocking, nonBlocking);
      // Findings on an older patch were already overtaken by a new head.
      if (blocking > 0 && patchId === change.patchId) {
        const stored = sql.verdict.get(taskId, sha);
        const verdict = stored === undefined ? undefined : decodeVerdict(String(stored.data));
        const summary = verdict?._tag === "Some" ? verdict.value.summary : "(the verdict had no summary)";
        const waiting = `waiting for a new head: ${taskId} found ${blocking} blocking at ${sha.slice(0, 12)}`;
        const author = change.taskId;
        if (author === undefined) return yield* changes.note(row.changeId, `${waiting}; no author task to send them to: ${summary}`);
        yield* changes.note(row.changeId, `${waiting}; sent to ${author}`);
        const sent = yield* Effect.result(
          tasks.message({ projectRef: change.projectRef, by: REVIEWS_BY }, author, findingsMessage(change, { taskId, prHeadSha: sha, blocking, nonBlocking, summary })),
        );
        if (sent._tag === "Failure") yield* changes.note(row.changeId, `${waiting}; sending them to ${author} failed: ${sent.failure.message}`);
        return;
      }
      yield* evaluate(row.changeId);
    }).pipe(Effect.catchTag("ReviewFailure", (e) => Effect.logWarning("reviews: verdict not bound", { seq: event.seq, error: e.message })));

  /** A review task ended: a verifier's receipts are now in, or it ended without the verdict it owed. */
  const onTaskEnded = (event: HubEvent) =>
    Effect.gen(function* () {
      const taskId = String(dataOf(event).taskId);
      const row = reviewerTask(taskId);
      if (row === undefined) return;
      if (sql.boundTask.get(taskId) === undefined) {
        yield* changes.note(row.changeId, `the ${row.role} ${taskId} ended (${event.type.slice("task.".length)}) without a review verdict`);
      }
      yield* evaluate(row.changeId);
    });

  const handle = (event: HubEvent) =>
    (event.type === "review.verdict" ? onVerdict(event) : onTaskEnded(event)).pipe(
      lock.withPermit,
      Effect.catchCause((cause) => Effect.logWarning("reviews: event not handled", { seq: event.seq, cause: Cause.pretty(cause) })),
    );

  const follow = (from: number) =>
    Effect.gen(function* () {
      let cursor = from;
      while (true) {
        const page = yield* events.wait({ cursor, types: FOLLOWED, timeoutSec: 300 });
        cursor = page.cursor;
        for (const event of page.events) yield* handle(event);
      }
    });

  // Read here, not in the fiber, so nothing appended before the fiber first runs is missed.
  yield* Effect.forkScoped(follow(yield* events.head()));

  return Reviews.of({ review });
});

/** Needs HubDb, EventLog, HubStore, Tasks, GitHub, PatchIds, ProviderList and ReviewChanges. */
export const layer = Layer.effect(Reviews, make);
