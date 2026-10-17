// The merge train: only fleetd merges. One serial train per repo takes the oldest ready Change, rebases it onto the
// latest base in a hub-owned worktree on the project's machine, waits for CI on that exact head, posts
// `fleetd/train=success` and squash-merges pinned to the head. Conflicts and red CI go back to the task that wrote
// the code; a merge goes to the lead inline. A freeze decision holds the train; merges it did not do are incidents.
import {
  type Change,
  type ChangeEnqueueCall,
  type ChangeId,
  type ChangeReview,
  type ChangeState,
  type DecisionKey,
  type HubEvent,
  type HubEventType,
  type ProjectRef,
  type TaskId,
  type TrainState,
  parsePrUrl,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { NodeCommands } from "../checks/NodeCommands.ts";
import * as Incidents from "../incidents/Incidents.ts";
import { LeadError } from "../leads/LeadError.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as Tasks from "../tasks/Tasks.ts";
import { ChangeRecords, HEAD_STATES, QUEUED_STATES, trainState } from "./ChangeRecords.ts";
import { ReviewGate } from "./ReviewGate.ts";
import { checkSource, checkTier, freezeKey, isFrozenValue, type Refusal } from "./rules.ts";
import * as TrainGit from "./TrainGit.ts";
import { type CheckRun, type Pull, TrainGitHub } from "./TrainGitHub.ts";

/** Recorded as the sender of the train's task messages. */
export const TRAIN_BY = "hub:train";

export type EnqueueInput = Omit<typeof ChangeEnqueueCall.Type, "op">;

export interface TrainOptions {
  /** Between CI polls and between idle passes. Default 15 s. */
  readonly pollInterval?: Duration.Input;
  /** How long CI may take on a rebased head. Default 30 min. */
  readonly ciTimeout?: Duration.Input;
  /** How often merged PRs are checked for bypasses. Default 60 s. */
  readonly bypassEvery?: Duration.Input;
  /** Merges GitHub refuses (405/409) before the train gives up on a Change. Default 3. */
  readonly mergeAttempts?: number;
  /** Run each repo's loop in the background. Default true; tests drive `step` themselves. */
  readonly autoRun?: boolean;
  /** Where a project's train worktree lives, from its checkout. */
  readonly worktreeFor?: (root: string) => string;
}

export class Train extends Context.Service<
  Train,
  {
    /** Validates the PR (`Source:`, tier) and puts it on its repo's train; the same open PR returns its Change. */
    readonly enqueue: (caller: Tasks.TaskCaller, input: EnqueueInput) => Effect.Effect<Change, LeadError>;
    /** Reviews satisfied the tier for the Change's current patch id; it may be taken. For the ReviewGate. */
    readonly markReady: (changeId: ChangeId, reviews: ReadonlyArray<ChangeReview>) => Effect.Effect<Change, LeadError>;
    readonly get: (changeId: ChangeId) => Effect.Effect<Change | undefined>;
    /** Newest first. */
    readonly list: (filter: {
      readonly projectRef?: ProjectRef;
      readonly repo?: string;
      readonly state?: ChangeState;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Change>>;
    readonly state: (repo: string) => Effect.Effect<TrainState>;
    /**
     * One pass of the repo's loop: refresh waiting Changes, check bypasses and the freeze, then take one ready
     * Change through to merged or parked. True when it took one.
     */
    readonly step: (repo: string) => Effect.Effect<boolean>;
  }
>()("fleetd/train/Train") {}

const GREEN = ["success", "neutral", "skipped"];
const isRed = (run: CheckRun) => run.status === "completed" && !GREEN.includes(run.conclusion ?? "");

const short = (sha: string) => sha.slice(0, 12);

const without = <A extends object, K extends keyof A>(a: A, ...keys: ReadonlyArray<K>): Omit<A, K> =>
  Object.fromEntries(Object.entries(a).filter(([k]) => !keys.includes(k as K))) as Omit<A, K>;

const errorText = (text: string) => (text.length > 2000 ? `${text.slice(0, 1999)}…` : text);

export const make = (options: TrainOptions = {}) =>
  Effect.gen(function* () {
    const records = yield* ChangeRecords;
    const tasks = yield* Tasks.Tasks;
    const leadRecords = yield* LeadRecords.LeadRecords;
    const decisions = yield* Decisions;
    const incidents = yield* Incidents.Incidents;
    const events = yield* EventLog.EventLog;
    const store = yield* HubStore.HubStore;
    const wakes = yield* LeadWakes.LeadWakes;
    const commands = yield* NodeCommands;
    const github = yield* TrainGitHub;
    const gate = yield* ReviewGate;
    const scope = yield* Effect.scope;

    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? Duration.seconds(15));
    const ciTimeoutMs = Duration.toMillis(Duration.fromInputUnsafe(options.ciTimeout ?? Duration.minutes(30)));
    const bypassEveryMs = Duration.toMillis(Duration.fromInputUnsafe(options.bypassEvery ?? Duration.seconds(60)));
    const mergeAttempts = options.mergeAttempts ?? 3;
    const worktreeFor = options.worktreeFor ?? TrainGit.defaultWorktree;

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    // Row updates re-read the Change under this lock, so a slow pass never overwrites a newer state.
    const rows = Semaphore.makeUnsafe(1);
    const perRepo = (map: Map<string, Semaphore.Semaphore>) => (repo: string) => {
      let lock = map.get(repo);
      if (lock === undefined) map.set(repo, (lock = Semaphore.makeUnsafe(1)));
      return lock;
    };
    /** One user of a repo's train worktree at a time: the loop's rebase, an enqueue's patch id. */
    const gitLock = perRepo(new Map());
    /** One pass of a repo's loop at a time. */
    const stepLock = perRepo(new Map());
    const kicks = new Map<string, Deferred.Deferred<void>>();
    const loops = new Set<string>();
    const recovered = new Set<string>();
    const lastBypassCheck = new Map<string, number>();
    const mergeRefusals = new Map<ChangeId, number>();

    const emit = (ref: ProjectRef, type: HubEventType, summary: string, data: Record<string, unknown>) =>
      Effect.flatMap(nowIso, (at) => events.append({ at, type, machineId: ref.machineId, projectId: ref.projectId, summary, data }));

    const wakeLead = (ref: ProjectRef, line: string) => wakes.trigger(ref, { kind: "train", line });

    /** Applies `next` to the stored Change if it is still in one of `from` (any state when absent); else does nothing. */
    const update = (changeId: ChangeId, from: ReadonlyArray<ChangeState> | undefined, next: (c: Change) => Change) =>
      rows.withPermit(
        Effect.gen(function* () {
          const current = yield* records.get(changeId);
          if (current === undefined || (from !== undefined && !from.includes(current.state))) return undefined;
          const changed: Change = { ...next(current), updatedAt: yield* nowIso };
          yield* records.put(changed);
          return changed;
        }),
      );

    const positioned = (changes: ReadonlyArray<Change>) =>
      Effect.gen(function* () {
        const queues = new Map<string, ReadonlyArray<ChangeId>>();
        for (const repo of new Set(changes.map((c) => c.repo))) {
          queues.set(repo, (yield* records.inTrain(repo, QUEUED_STATES)).map((c) => c.changeId));
        }
        return changes.map((c): Change => {
          const at = queues.get(c.repo)?.indexOf(c.changeId) ?? -1;
          return at === -1 ? without(c, "position") : { ...c, position: at };
        });
      });

    const gitFor = (change: Change) =>
      Effect.gen(function* () {
        const ref = (yield* records.train(change.repo))?.projectRef ?? change.projectRef;
        const project = yield* store.projects.get(ref);
        if (project === undefined) return yield* new TrainGit.GitError({ message: `no project ${ref.projectId} on ${ref.machineId} to run git in` });
        const lock = gitLock(change.repo);
        const git = TrainGit.make(commands, { machineId: ref.machineId, root: project.workspaceRoot, worktree: worktreeFor(project.workspaceRoot) });
        return { git, lock: <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermit(effect) };
      });

    const kick = (repo: string) =>
      Effect.suspend(() => {
        const waiting = kicks.get(repo);
        return waiting === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(waiting, undefined));
      });

    /** The author task gets it as a task message; without one, or if that fails, the lead gets it. */
    const tellAuthor = (change: Change, text: string) =>
      Effect.gen(function* () {
        if (change.taskId !== undefined) {
          const sent = yield* Effect.result(tasks.message({ projectRef: change.projectRef, by: TRAIN_BY }, change.taskId, text));
          if (sent._tag === "Success") return;
          yield* Effect.logWarning("train: author not messaged", { changeId: change.changeId, taskId: change.taskId, error: sent.failure.message });
        }
        yield* wakeLead(change.projectRef, `${change.changeId} (${change.prUrl}): ${text}`);
      });

    const setReady = (change: Change, reviews: ReadonlyArray<ChangeReview>) =>
      Effect.gen(function* () {
        const ready = yield* update(change.changeId, ["queued", "reviewing", "needs_rebase", "ci_failed"], (c) => ({
          ...without(c, "lastError"),
          state: "ready",
          reviews: [...c.reviews, ...reviews],
        }));
        if (ready === undefined) return undefined;
        yield* emit(ready.projectRef, "change.ready", `${ready.changeId} ready for the train: ${ready.repo}#${ready.prNumber}`, { changeId: ready.changeId });
        yield* kick(ready.repo);
        return ready;
      });

    /** Hands a Change in `reviewing` to the gate; the tier may need nothing more, making it ready at once. */
    const toGate = (change: Change) =>
      Effect.flatMap(gate.review(change), (verdict) => (verdict === "ready" ? Effect.asVoid(setReady(change, [])) : Effect.void));

    /**
     * Reads the PR branch's head and patch id. A new Change goes to the gate. A parked one (needs_rebase, ci_failed)
     * whose patch is unchanged keeps its reviews and goes back on the queue; a new patch is reviewed again.
     */
    const admit = (change: Change, pull: Pull) =>
      Effect.gen(function* () {
        const { git, lock } = yield* gitFor(change);
        const seen = yield* lock(git.inspect(pull.base.ref, change.branch));
        const samePatch = change.patchId === seen.patchId;
        if (samePatch && change.state !== "queued") {
          const moved = yield* update(change.changeId, [change.state], (c) => ({ ...c, headSha: seen.headSha }));
          if (moved !== undefined && moved.state !== "reviewing" && moved.state !== "ready") yield* setReady(moved, []);
          return;
        }
        const reviewing = yield* update(change.changeId, [change.state], (c) => ({
          ...without(c, "lastError"),
          headSha: seen.headSha,
          patchId: seen.patchId,
          state: "reviewing",
        }));
        if (reviewing !== undefined) yield* toGate(reviewing);
      });

    const abandon = (change: Change, why: string) =>
      Effect.gen(function* () {
        const done = yield* update(change.changeId, [change.state], (c) => ({ ...c, state: "abandoned", lastError: why }));
        if (done !== undefined) yield* wakeLead(change.projectRef, `${change.changeId} left the train: ${change.prUrl} ${why}.`);
      });

    const finishMerged = (change: Change, mergedSha: string | null) =>
      Effect.gen(function* () {
        const sha = mergedSha?.toLowerCase();
        const merged = yield* update(change.changeId, undefined, (c) => ({
          ...without(c, "lastError"),
          state: "merged",
          ...(sha === undefined ? {} : { mergedSha: sha }),
        }));
        if (merged === undefined) return;
        mergeRefusals.delete(change.changeId);
        yield* emit(merged.projectRef, "pr.merged", `${merged.changeId} merged: ${merged.repo}#${merged.prNumber}${sha === undefined ? "" : ` as ${short(sha)}`}`, {
          changeId: merged.changeId,
          repo: merged.repo,
          prNumber: merged.prNumber,
          ...(sha === undefined ? {} : { mergedSha: sha }),
        });
        yield* wakeLead(
          merged.projectRef,
          `${merged.changeId} merged by the train: ${merged.prUrl}${sha === undefined ? "" : ` as ${short(sha)}`} (tier ${merged.tier}, serves ${merged.serves}${merged.taskId === undefined ? "" : `, by ${merged.taskId}`}).`,
        );
      });

    const needsRebase = (change: Change, base: string, paths: ReadonlyArray<string>, output: string) =>
      Effect.gen(function* () {
        const why = paths.length > 0 ? `conflicts with origin/${base} in ${paths.join(", ")}` : `does not rebase onto origin/${base}: ${output}`;
        const parked = yield* update(change.changeId, ["rebasing"], (c) => ({ ...c, state: "needs_rebase", lastError: errorText(why) }));
        if (parked === undefined) return;
        yield* emit(change.projectRef, "change.needs_rebase", `${change.changeId} needs a rebase: ${why}`, { changeId: change.changeId, paths: paths.slice(0, 50) });
        yield* tellAuthor(
          parked,
          `The merge train could not rebase your PR ${change.prUrl} (${change.changeId}): it ${why}. Rebase ${change.branch} onto origin/${base}, resolve the conflicts, push, and stop; the train takes the new head by itself.`,
        );
      });

    const ciFailed = (change: Change, failing: ReadonlyArray<CheckRun>, timedOut: boolean) =>
      Effect.gen(function* () {
        const names = failing.map((r) => `${r.name} (${r.conclusion ?? r.status})`);
        const logUrl = failing.find((r) => r.html_url !== null)?.html_url ?? undefined;
        const why = timedOut
          ? `CI on ${short(change.headSha)} did not finish within ${Math.round(ciTimeoutMs / 60_000)} min`
          : `CI failed on ${short(change.headSha)}: ${names.join(", ")}${logUrl === undefined ? "" : ` (log: ${logUrl})`}`;
        const parked = yield* update(change.changeId, ["ci"], (c) => ({ ...c, state: "ci_failed", lastError: errorText(why) }));
        if (parked === undefined) return;
        yield* emit(change.projectRef, "change.ci_failed", `${change.changeId} ${why}`, {
          changeId: change.changeId,
          checks: failing.map((r) => r.name),
          ...(logUrl === undefined ? {} : { logUrl }),
        });
        yield* tellAuthor(
          parked,
          `The merge train did not merge your PR ${change.prUrl} (${change.changeId}): ${why}. Fix it on ${change.branch}, push, and stop; the train retries the new head by itself.`,
        );
      });

    /** Polls the head's check runs until all are done, one is red, or the timeout passes. */
    const waitCi = (repo: string, sha: string) =>
      Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        while (true) {
          const runs = yield* github.checkRuns(repo, sha).pipe(
            Effect.catchTag("GhError", (e) => Effect.as(Effect.logWarning("train: check runs not read", { repo, sha, error: e.message }), [])),
          );
          const red = runs.filter(isRed);
          if (red.length > 0) return { _tag: "red" as const, failing: red };
          if (runs.length > 0 && runs.every((r) => r.status === "completed")) return { _tag: "green" as const };
          if ((yield* Clock.currentTimeMillis) - start >= ciTimeoutMs) return { _tag: "timeout" as const };
          yield* Effect.sleep(pollInterval);
        }
      });

    /** A pass that could not finish: the Change goes back first in line with the reason, and the loop retries later. */
    const putBack = (change: Change, why: string) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("train: pass failed", { changeId: change.changeId, why });
        const back = yield* update(change.changeId, ["ready", ...HEAD_STATES], (c) => ({ ...c, state: "ready", lastError: errorText(why) }));
        if (back !== undefined) yield* records.toFront(change.changeId);
      });

    /** The head of a ready Change moved: the same patch stays ready, a new one goes back to review. */
    const readyMoved = (change: Change, pull: Pull) =>
      Effect.gen(function* () {
        const { git, lock } = yield* gitFor(change);
        const seen = yield* lock(git.inspect(pull.base.ref, change.branch));
        if (seen.patchId === change.patchId) {
          yield* update(change.changeId, ["ready"], (c) => ({ ...c, headSha: seen.headSha }));
          return;
        }
        const reviewing = yield* update(change.changeId, ["ready"], (c) => ({ ...c, headSha: seen.headSha, patchId: seen.patchId, state: "reviewing" }));
        if (reviewing !== undefined) yield* toGate(reviewing);
      });

    /** Rebase, push, CI, status, pinned merge: one ready Change. */
    const take = (change: Change) =>
      Effect.gen(function* () {
        const repo = change.repo;
        const pull = yield* github.pull(repo, change.prNumber);
        if (pull.merged) return yield* abandon(change, "was merged outside the train");
        if (pull.state !== "open") return yield* abandon(change, "was closed");
        if (pull.head.sha.toLowerCase() !== change.headSha) return yield* readyMoved(change, pull);
        const rebasing = yield* update(change.changeId, ["ready"], (c) => ({ ...c, state: "rebasing" }));
        if (rebasing === undefined) return;
        const base = pull.base.ref;

        const { git, lock } = yield* gitFor(change);
        const outcome = yield* lock(
          Effect.gen(function* () {
            const rebased = yield* git.rebase(base, change.branch);
            if (rebased._tag === "conflict" || rebased.headSha === rebased.remoteHead) return rebased;
            const pushed = yield* git.push(change.branch, rebased.remoteHead);
            return pushed.pushed ? rebased : { _tag: "push_rejected" as const, output: pushed.output };
          }),
        );
        if (outcome._tag === "conflict") return yield* needsRebase(rebasing, base, outcome.paths, outcome.output);
        if (outcome._tag === "push_rejected") return yield* putBack(rebasing, `push refused, the branch moved: ${outcome.output}`);
        if (outcome.patchId !== rebasing.patchId) {
          // Reviews are bound to the patch id; a rebase that changed it needs them again.
          const reviewing = yield* update(change.changeId, ["rebasing"], (c) => ({
            ...c,
            headSha: outcome.headSha,
            patchId: outcome.patchId,
            state: "reviewing",
            lastError: `the rebase onto origin/${base} changed the patch id; it needs review again`,
          }));
          if (reviewing !== undefined) yield* toGate(reviewing);
          return;
        }

        const inCi = yield* update(change.changeId, ["rebasing"], (c) => ({ ...c, headSha: outcome.headSha, state: "ci" }));
        if (inCi === undefined) return;
        const ci = yield* waitCi(repo, outcome.headSha);
        if (ci._tag !== "green") return yield* ciFailed(inCi, ci._tag === "red" ? ci.failing : [], ci._tag === "timeout");

        const merging = yield* update(change.changeId, ["ci"], (c) => ({ ...c, state: "merging" }));
        if (merging === undefined) return;
        yield* github.postTrainStatus(repo, outcome.headSha, `${change.changeId}: rebased onto ${base}, CI green`);
        const merged = yield* github.merge(repo, change.prNumber, outcome.headSha);
        if (merged.merged) return yield* finishMerged(merging, merged.sha);

        const refusals = (mergeRefusals.get(change.changeId) ?? 0) + 1;
        mergeRefusals.set(change.changeId, refusals);
        const why = `GitHub refused the merge (HTTP ${merged.status}): ${merged.message}`;
        if (refusals < mergeAttempts) {
          // Usually the base moved between CI and the merge: rebase again, first in line.
          yield* update(change.changeId, ["merging"], (c) => ({ ...c, state: "ready", lastError: errorText(why) }));
          return yield* records.toFront(change.changeId);
        }
        mergeRefusals.delete(change.changeId);
        yield* update(change.changeId, ["merging"], (c) => ({ ...c, state: "ci_failed", lastError: errorText(`${why}; gave up after ${refusals} tries`) }));
        yield* wakeLead(change.projectRef, `${change.changeId} (${change.prUrl}) was not merged: ${why}. The train gave up after ${refusals} tries; check the repo's merge settings.`);
      }).pipe(
        Effect.catchTags({
          GhError: (e) => putBack(change, `GitHub: ${e.message}`),
          GitError: (e) => putBack(change, `git: ${e.message}`),
        }),
      );

    /** Changes waiting on something outside the train: a patch id to read, reviews, or the author's next push. */
    const refresh = (repo: string) =>
      Effect.gen(function* () {
        for (const change of yield* records.inTrain(repo, ["queued", "reviewing", "needs_rebase", "ci_failed"])) {
          yield* Effect.gen(function* () {
            const pull = yield* github.pull(repo, change.prNumber);
            if (pull.merged) return yield* abandon(change, "was merged outside the train");
            if (pull.state !== "open") return yield* abandon(change, "was closed");
            if (change.state === "queued" || pull.head.sha.toLowerCase() !== change.headSha) yield* admit(change, pull);
          }).pipe(
            Effect.catchTags({
              GhError: (e) => Effect.logWarning("train: refresh failed", { changeId: change.changeId, error: e.message }),
              GitError: (e) => Effect.asVoid(update(change.changeId, [change.state], (c) => ({ ...c, lastError: errorText(`git: ${e.message}`) }))),
            }),
          );
        }
      });

    /** After a restart: a Change the train was merging is finished if GitHub merged it, else put back first in line. */
    const recover = (repo: string) =>
      Effect.gen(function* () {
        for (const change of yield* records.inTrain(repo, HEAD_STATES)) {
          const pull = yield* Effect.option(github.pull(repo, change.prNumber));
          if (pull._tag === "Some" && pull.value.merged && change.state === "merging") yield* finishMerged(change, pull.value.merge_commit_sha);
          else yield* putBack(change, "the hub restarted while the train worked on it");
        }
        recovered.add(repo);
      });

    const checkBypasses = (repo: string, watchSinceMs: number, ref: ProjectRef) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = lastBypassCheck.get(repo);
        if (last !== undefined && now - last < bypassEveryMs) return;
        lastBypassCheck.set(repo, now);
        for (const pr of yield* github.mergedPulls(repo)) {
          if (Date.parse(pr.mergedAt) < watchSinceMs) continue;
          const change = yield* records.latestFor(repo, pr.number);
          if (change?.state === "merged") continue;
          if (!(yield* records.markBypass(repo, pr.number))) continue;
          yield* incidents.record({
            class: "policy_bypass",
            projectRef: change?.projectRef ?? ref,
            ...(change === undefined ? {} : { workstreamId: change.workstreamId }),
            ...(change?.taskId === undefined ? {} : { taskId: change.taskId }),
            evidence: [
              `${repo}#${pr.number} was merged at ${pr.mergedAt} without the merge train${pr.mergeSha === null ? "" : ` (${short(pr.mergeSha)})`}.`,
              change === undefined ? "No Change was ever enqueued for it." : `Its Change ${change.changeId} was ${change.state}.`,
            ],
          });
        }
      }).pipe(Effect.catchTag("GhError", (e) => Effect.logWarning("train: bypass check failed", { repo, error: e.message })));

    /** Holds the train while `policy.freeze.<owner>.<name>` is true; announces each change of that. */
    const frozen = (repo: string, wasFrozen: boolean, ref: ProjectRef) =>
      Effect.gen(function* () {
        const decision = yield* decisions.resolve(freezeKey(repo) as DecisionKey, { projectRef: ref });
        const now = decision !== undefined && isFrozenValue(decision.value);
        if (now !== wasFrozen) {
          yield* records.setFrozen(repo, now);
          if (decision !== undefined && now) {
            const reason = decision.why ?? `${decision.decisionId} ${decision.key} = ${decision.value}`;
            yield* emit(ref, "train.frozen", `Train for ${repo} frozen: ${reason}`, { repo, reason });
          } else {
            yield* emit(ref, "train.resumed", `Train for ${repo} resumed`, { repo });
          }
        }
        return now;
      });

    const step: Train["Service"]["step"] = (rawRepo) => {
      const repo = rawRepo.toLowerCase();
      return Effect.gen(function* () {
        const train = yield* records.train(repo);
        if (train === undefined) return false;
        if (!recovered.has(repo)) yield* recover(repo);
        yield* refresh(repo);
        yield* checkBypasses(repo, train.watchSinceMs, train.projectRef);
        if (yield* frozen(repo, train.frozen, train.projectRef)) return false;
        const [next] = yield* records.inTrain(repo, ["ready"]);
        if (next === undefined) return false;
        yield* take(next);
        return true;
      }).pipe(
        stepLock(repo).withPermit,
        Effect.catchCause((cause) => Effect.as(Effect.logWarning("train: pass failed", { repo, cause: Cause.pretty(cause) }), false)),
      );
    };

    const idle = (repo: string) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        kicks.set(repo, waiting);
        yield* Effect.raceFirst(Effect.sleep(pollInterval), Deferred.await(waiting));
      });

    const ensureLoop = (repo: string) =>
      Effect.suspend(() => {
        if (options.autoRun === false || loops.has(repo)) return Effect.void;
        loops.add(repo);
        return Effect.asVoid(Effect.forkIn(Effect.forever(Effect.flatMap(step(repo), (took) => (took ? Effect.void : idle(repo)))), scope));
      });

    const refuse = (ref: ProjectRef, prUrl: string, refusal: Refusal, row?: Omit<Change, "changeId" | "state" | "createdAt" | "updatedAt">) =>
      Effect.gen(function* () {
        if (row !== undefined) {
          const at = yield* nowIso;
          yield* records.create({ ...row, state: "refused", lastError: errorText(`${refusal.message} Fix: ${refusal.fix}`), createdAt: at, updatedAt: at });
        }
        yield* emit(ref, "change.refused", `Refused ${prUrl}: ${refusal.message}`, { prUrl, fix: refusal.fix });
        return yield* new LeadError({ code: "invalid", message: `The train refused ${prUrl}: ${refusal.message}`, fix: refusal.fix });
      });

    const enqueue: Train["Service"]["enqueue"] = (caller, input) =>
      Effect.gen(function* () {
        const ref = caller.projectRef;
        const parsed = parsePrUrl(input.prUrl);
        if (parsed === undefined) {
          return yield* new LeadError({ code: "invalid", message: `${input.prUrl} is not a github.com pull request URL.`, fix: "Pass https://github.com/<owner>/<name>/pull/<n>." });
        }
        const repo = parsed.repo.toLowerCase();
        const prUrl = `https://github.com/${repo}/pull/${parsed.prNumber}`;
        const task = input.taskId === undefined ? undefined : yield* tasks.get(input.taskId);
        if (input.taskId !== undefined && (task === undefined || task.projectRef.machineId !== ref.machineId || task.projectRef.projectId !== ref.projectId)) {
          return yield* new LeadError({ code: "not_found", message: `No task ${input.taskId} in this project.`, fix: "Run `fleetd task list`." });
        }
        const existing = yield* records.openFor(repo, parsed.prNumber);
        if (existing !== undefined) {
          yield* kick(repo);
          return (yield* positioned([existing]))[0]!;
        }

        const workstreamId = input.workstreamId ?? task?.workstreamId;
        if (workstreamId === undefined) {
          return yield* refuse(ref, prUrl, { message: "It names no workstream.", fix: "pass --task T<n> (the write task that opened it) or --workstream W<n>" });
        }
        const workstream = (yield* leadRecords.workstreams.get(workstreamId))?.workstream;
        if (workstream === undefined || workstream.projectRef.machineId !== ref.machineId || workstream.projectRef.projectId !== ref.projectId) {
          return yield* new LeadError({ code: "not_found", message: `No workstream ${workstreamId} in this project.`, fix: "Use a workstream id from your digest." });
        }
        const brief = workstream.brief;
        if (brief === undefined) {
          return yield* refuse(ref, prUrl, { message: `${workstreamId} has no brief, so it has no tier or done-when.`, fix: `register its brief with \`fleetd brief create --workstream ${workstreamId}\` first` });
        }

        const pull = yield* github.pull(repo, parsed.prNumber).pipe(
          Effect.mapError((e) => new LeadError({ code: "invalid", message: `Could not read ${prUrl} from GitHub: ${e.message}`, fix: "Check the URL; the hub reads PRs with its own `gh` login." })),
        );
        const expected = input.serves ?? task?.serves;
        const source = checkSource(pull.body, expected, workstream);
        const rowOf = (serves: string) => ({
          projectRef: ref,
          repo,
          prNumber: parsed.prNumber,
          prUrl,
          branch: pull.head.ref,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
          workstreamId,
          serves,
          tier: brief.tier,
          headSha: pull.head.sha.toLowerCase(),
          reviews: [],
        });
        // With no serves to record, a refusal writes no row; with one, the refused Change is kept for the record.
        if (!("serves" in source)) return yield* refuse(ref, prUrl, source, expected === undefined ? undefined : rowOf(expected));
        const serves = source.serves;
        const row = rowOf(serves);
        if (pull.merged || pull.state !== "open") {
          return yield* refuse(ref, prUrl, { message: `It is ${pull.merged ? "already merged" : pull.state}.`, fix: "enqueue an open PR" }, row);
        }
        if (pull.head.repo?.full_name.toLowerCase() !== repo) {
          return yield* refuse(ref, prUrl, { message: "Its branch lives in another repository.", fix: `push the branch to ${repo} and open the PR from there` }, row);
        }
        const tier = checkTier(brief.tier, input.tier, task?.tier);
        if (!("tier" in tier)) return yield* refuse(ref, prUrl, tier, row);

        yield* records.ensureTrain(repo, ref, yield* Clock.currentTimeMillis);
        const at = yield* nowIso;
        const change = yield* records.create({ ...row, tier: tier.tier, state: "queued", createdAt: at, updatedAt: at });
        yield* emit(ref, "change.queued", `${change.changeId} queued: ${repo}#${change.prNumber} (tier ${change.tier}, ${serves})`, {
          changeId: change.changeId,
          repo,
          prNumber: change.prNumber,
        });
        // Reading the patch id needs the machine; if that fails, the loop retries it from `queued`.
        yield* admit(change, pull).pipe(
          Effect.catchTag("GitError", (e) => Effect.asVoid(update(change.changeId, ["queued"], (c) => ({ ...c, lastError: errorText(`git: ${e.message}`) })))),
        );
        yield* ensureLoop(repo);
        yield* kick(repo);
        return (yield* positioned([(yield* records.get(change.changeId))!]))[0]!;
      });

    const markReady: Train["Service"]["markReady"] = (changeId, reviews) =>
      Effect.gen(function* () {
        const change = yield* records.get(changeId);
        if (change === undefined) return yield* new LeadError({ code: "not_found", message: `No change ${changeId}.` });
        if (change.state !== "reviewing") return yield* new LeadError({ code: "invalid", message: `${changeId} is ${change.state}, not reviewing.` });
        const stale = reviews.filter((r) => r.patchId !== change.patchId);
        if (stale.length > 0) {
          return yield* new LeadError({
            code: "invalid",
            message: `${stale.map((r) => r.taskId).join(", ")} reviewed patch ${stale[0]!.patchId.slice(0, 12)}, but ${changeId} is at patch ${change.patchId?.slice(0, 12) ?? "(unread)"}.`,
            fix: "Review the current head.",
          });
        }
        const ready = yield* setReady(change, reviews);
        if (ready === undefined) return yield* new LeadError({ code: "invalid", message: `${changeId} changed state while it was marked ready; read it again.` });
        return (yield* positioned([ready]))[0]!;
      });

    // M7 auto-enqueue, hooked onto task completion through the event log: a write task whose result names a PR puts
    // it on the train. A refusal goes to the lead with its fix.
    const onTaskCompleted = (event: HubEvent) =>
      Effect.gen(function* () {
        const taskId = (event.data as { readonly taskId?: TaskId } | undefined)?.taskId;
        const task = taskId === undefined ? undefined : yield* tasks.get(taskId);
        const prUrl = task?.result?.prUrl;
        if (task === undefined || task.kind !== "write" || prUrl === undefined || parsePrUrl(prUrl) === undefined) return;
        yield* enqueue({ projectRef: task.projectRef, by: TRAIN_BY }, { taskId: task.taskId, prUrl }).pipe(
          Effect.catchTag("LeadError", (e) =>
            wakeLead(task.projectRef, `The train refused ${prUrl} from ${task.taskId}: ${e.message}${e.fix === undefined ? "" : ` Fix: ${e.fix}.`}`),
          ),
        );
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("train: auto-enqueue failed", { seq: event.seq, cause: Cause.pretty(cause) })));

    const follow = (from: number) =>
      Effect.gen(function* () {
        let cursor = from;
        while (true) {
          const page = yield* events.wait({ cursor, types: ["task.completed"], timeoutSec: 300 });
          cursor = page.cursor;
          for (const event of page.events) yield* onTaskCompleted(event);
        }
      });

    // The cursor is read here, not in the fiber, so nothing appended before the fiber first runs is missed.
    yield* Effect.forkScoped(follow(yield* events.head()));
    for (const train of yield* records.trains()) yield* ensureLoop(train.repo);

    return Train.of({
      enqueue,
      markReady,
      get: (changeId) => Effect.flatMap(records.get(changeId), (c) => (c === undefined ? Effect.succeed(undefined) : Effect.map(positioned([c]), (p) => p[0]))),
      list: (filter) => Effect.flatMap(records.list(filter), positioned),
      state: (repo) => trainState(records, repo),
      step,
    });
  });

/** Needs ChangeRecords, Tasks, LeadRecords, LeadWakes, Decisions, Incidents, EventLog, HubStore, NodeCommands, TrainGitHub and ReviewGate. */
export const layer = (options?: TrainOptions) => Layer.effect(Train, make(options));
