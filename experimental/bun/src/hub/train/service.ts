// The merge train (crates/fleetd/src/hub/train/service.rs): only fleetd merges. One serial train per repo takes the
// oldest ready Change, has GitHub rebase it onto the latest base (`gh pr update-branch --rebase`), waits for CI on
// that exact head, posts `fleetd/train=success` and squash-merges pinned to the head. Conflicts and red CI go back to
// the task that wrote the code, but a conflict only in generated files, which the train regenerates on a node
// (regen.ts); a merge goes to the lead inline. A PR merged into a guarded base without the train is reported once
// (`pr.merged_outside`). The `hold` label holds one PR. Two or more ready Changes go as one batch (batch.ts).
import type { Change, ChangeReview, ChangeState, CiInfo, ProjectRef } from "../../shared/contracts.ts";
import * as batch from "./batch.ts";
import { prGaveUp, prLeft, prMerged, prNote, prRefused } from "./events.ts";
import { type Flaky, flakyNote, rerunFailed } from "./flaky.ts";
import { type CheckRun, GhError, type Pull, READ_TRIES, TRAIN_CONTEXT, TrainGitHub, batchHeads, conflicts, held as isHeld, latest, NEXT_LABEL, labelled as hasLabel } from "./github.ts";
import type { GhRunner } from "./gh.ts";
import type { TrainHost } from "./host.ts";
import { ciState, GithubSync, type MainCi } from "./main_ci.ts";
import { Locks, Mutex } from "./mutex.ts";
import * as next from "./next.ts";
import { type PromptSetLike, type PromptsLike, SHIPPED_PROMPTS } from "./prompts.ts";
import { ChangeRecords, DRAFT, errorText, HEAD_STATES, isDraft, type ListFilter, parsePrUrl, WAIT_BLOCKED, WAIT_REGEN, WAIT_UNSTARTED, WAITING } from "./records.ts";
import { conflicted, forgetRegens, REGEN_RUNNING, type Regenerate } from "./regen.ts";
import { repoChecks, type Cached as RepoChecksCached } from "./repo_checks.ts";
import * as reverts from "./reverts.ts";
import {
  allCancelled,
  awaitsChecks,
  cancelledRequired,
  CANCELLED_RERUNS,
  type Checks,
  checks,
  Fast,
  gated,
  mustReport,
  type Refusal,
  requiredChecks,
  runningSince,
  short,
  type Stall,
} from "./rules.ts";
import { scheduledPass } from "./scheduled.ts";
import { rerunStale, type StaleHead } from "./stale.ts";
import { type FreshLike, freshGithub, freshTrain, GITHUB_STALE_MS, isoMs, parseMs, sleep, TRAIN_STALE_MS } from "./seams.ts";
import type { TrainError } from "./tools.ts";
import { rerunning, watchMerge, watchPass } from "./watch.ts";
import { Repeats, warnHourly } from "./repeats.ts";
import { openBlocking } from "../reviews/read.ts";
import type { HubDb } from "../store/db.ts";

/** Recorded as the sender of the train's task messages. */
export const TRAIN_BY = "hub:train";

/** The gate's verdict on a Change in review. */
export type Verdict = { kind: "ready"; reviews: ChangeReview[] } | { kind: "pending" } | { kind: "blocked" };

/**
 * The port between the train and reviews. The train calls `review` whenever a Change enters `reviewing`; the gate
 * answers ready when a clean review is already bound to this patch id, or pending and later calls `Train.markReady`.
 */
export interface ReviewGate {
  review(change: Change): Promise<Verdict>;
  /** Each pass over a Change still in `reviewing` at the same head, and the train's reads of a re-review in CI. */
  again(change: Change): Promise<Verdict>;
  /** Whether a reviewer is at work on the Change's current patch and nothing blocks it. */
  rereview(change: Change): boolean;
  /** The lead enqueued the Change again while blocking findings hold its current patch: a fresh full review starts. */
  resolved(change: Change): Promise<boolean>;
}

/** A gate that approves nothing, for a train without reviews. */
export const NO_GATE: ReviewGate = {
  review: async () => ({ kind: "pending" }),
  again: async () => ({ kind: "pending" }),
  rereview: () => false,
  resolved: async () => false,
};

export type TrainOptions = {
  /** Between idle passes, and the longest wait between reads while the train holds a Change. */
  pollIntervalMs: number;
  /** How long a head's CI may run, from when its first check started. */
  ciTimeoutMs: number;
  /** How long a head's checks may all sit queued for runners before any starts. */
  ciQueueCeilingMs: number;
  /** How often merged PRs are checked for merges outside the train. */
  bypassEveryMs: number;
  /** How often a repo's open PRs are read for a writer's ready PR (a slice). */
  readyEveryMs: number;
  /** Merges GitHub refuses (405/409) before the train gives up on a Change. */
  mergeAttempts: number;
  /** How long the train holds a Change whose CI passed for its re-review to finish. */
  reviewWaitMs: number;
  /** How long a waiting Change's head may go without any check before its author and the lead hear of it. */
  checksStartWaitMs: number;
  /** How many batch PRs may be in CI at once; 1 turns overlapping off. */
  pipelineDepth: number;
  /** How long a green batch waits for the batch behind it; undefined: as long as its own CI took. */
  followerWaitMs?: number;
  /** Run each repo's loop in the background; tests drive `step` themselves. */
  autoRun: boolean;
  /** The status view's freshness registry. */
  fresh: FreshLike;
  /** Waits `ms` (tests pass one that moves their clock). */
  sleep: (ms: number) => Promise<void>;
};

/** Batch PRs in CI at once: the one that lands next, and one behind it. */
export const PIPELINE_DEPTH = 2;
export const REVIEW_WAIT_MS = 15 * 60_000;
export const CHECKS_START_WAIT_MS = 15 * 60_000;
export const CI_RUNNING_TIMEOUT_MS = 45 * 60_000;
export const CI_QUEUE_CEILING_MS = 2 * 60 * 60_000;
export const BLOCKED_WAKE_MS = 30 * 60_000;
export const NEVER_RAN_WAIT_MS = 5 * 60_000;

export function defaultOptions(signal?: AbortSignal): TrainOptions {
  return {
    pollIntervalMs: 15_000,
    ciTimeoutMs: CI_RUNNING_TIMEOUT_MS,
    ciQueueCeilingMs: CI_QUEUE_CEILING_MS,
    bypassEveryMs: 60_000,
    readyEveryMs: 60_000,
    mergeAttempts: 3,
    reviewWaitMs: REVIEW_WAIT_MS,
    checksStartWaitMs: CHECKS_START_WAIT_MS,
    pipelineDepth: PIPELINE_DEPTH,
    autoRun: true,
    fresh: { expect() {}, forget() {}, touch() {}, fail() {} },
    sleep: (ms) => sleep(ms, signal),
  };
}

/** The start of `lastError` on a Change whose CI timed out rather than went red. */
export const CI_TIMED_OUT = "CI timed out";
/** The `lastError` of a Change that left the train with its project (`dropRemovedChanges`). */
export const REMOVED_PROJECT = "its project was removed from fleetd";
export const CI_WATCHED = "the train keeps watching its checks: once they finish green it goes back in the queue, with no push needed";
export const CI_SUPERSEDED = "a push to the PR replaced the head its CI ran on; the train takes the new head";
export const CI_CANCELLED = "its CI timed out, then was cancelled, and re-running it didn't finish it";
export const RESOLVED =
  "enqueued again while its review's findings blocked it: they count no more, and a fresh full review of its patch runs";
export const CI_FINISHED_LATE = "CI finished after the timeout; back in the queue";
/** The reviews' note on a Change its findings block (reviews/service.rs `BLOCKED`). */
export const BLOCKED_PREFIX = "waiting for a new head: ";

/** A Change in `ci_failed` because its CI timed out, not because a check went red. */
export const timedOut = (change: Change) => change.state === "ci_failed" && (change.lastError?.startsWith(CI_TIMED_OUT) ?? false);

const CI_CONFIG_TTL_MS = 10 * 60_000;
/** The error code of a task result's PR that already merged: nothing to enqueue, and nothing to tell the lead. */
const MERGED = "merged";
const CI_FIRST_WAIT_MS = 2000;
const MERGE_RETRY_FIRST_MS = 15_000;
const MERGE_RETRY_MAX_MS = 5 * 60_000;
const REBASE_FIRST_WAIT_MS = 1000;

/** How the wait for a re-review alongside CI ended. */
export type ReviewWait = { kind: "clean"; reviews: ChangeReview[] } | { kind: "blocked" } | { kind: "waiting" };

export type CiOutcome = { kind: "green" } | { kind: "red"; runs: CheckRun[] } | { kind: "timeout"; stall: Stall } | { kind: "moved" };

/** What a wait on CI does between its reads of the checks. */
export type Between = () => Promise<void>;

/** One waiter at a time, as tokio's `Notify`: `notified()` resolves at the next `notifyOne`/`notifyWaiters`. */
export class Notify {
  private waiters: (() => void)[] = [];
  private permit = false;

  notified(): Promise<void> {
    if (this.permit) {
      this.permit = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  notifyOne(): void {
    const w = this.waiters.shift();
    if (w) w();
    else this.permit = true;
  }

  notifyWaiters(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

const err = (code: string, message: string, fix?: string): TrainError => (fix === undefined ? { code, message } : { code, message, fix });
const ghMessage = (e: unknown) => (e instanceof GhError ? e.message : (e as Error)?.message ?? String(e));

export class Train {
  readonly records: ChangeRecords;
  readonly github: TrainGitHub;
  gate: ReviewGate = NO_GATE;
  readonly options: TrainOptions;
  /** One pass of a repo's loop at a time. */
  private readonly stepLocks = new Locks();
  /** One enqueue of a PR at a time, from its open check to its row. */
  private readonly enqueueLocks = new Locks();
  private readonly kicks = new Map<string, Notify>();
  private readonly loops = new Set<string>();
  private readonly recovered = new Set<string>();
  private readonly lastBypassCheck = new Map<string, number>();
  /** Per repo, the bases its Changes' PRs target. */
  private readonly bases = new Map<string, Set<string>>();
  readonly lastReadyCheck = new Map<string, number>();
  /** The heads of writers' PRs already sent to review as a ready slice. */
  private readonly readyHeads = new Set<string>();
  /** Enqueues GitHub was unavailable for, by PR URL, with whether each came from a task's result. */
  private readonly unread = new Map<string, [ProjectRef, EnqueueCall, boolean]>();
  private readonly mergeRefusals = new Map<string, number>();
  /** Each verdict the gate records: a train waiting on a re-review reads it at once. */
  private readonly verdicts = new Notify();
  /** The patches whose re-review was still at work `reviewWait` after CI passed. */
  private readonly overdue = new Set<string>();
  /** The upstream failures the lead was told of, each Change's with its hold. */
  readonly afterTold = new Set<string>();
  /** Held by an enqueue with `after` from its loop check until its Change records them. */
  private readonly afterLock = new Mutex();
  /** GitHub's answer for an upstream PR with no open Change, by URL, and when it was read. */
  readonly upstreamReads = new Map<string, [number, next.UpstreamPull]>();
  /** The train's last push per change: the head it pushed and when. */
  readonly pushed = new Map<string, [string, number]>();
  /** Per timed-out Change, the cancelled runs the train re-ran after the timeout. */
  private readonly lateReruns = new Map<string, next.Reruns>();
  /** Per head, what the train read and re-ran of checks GitHub left pending under a finished run (`rerunStale`). */
  readonly staleHeads = new Map<string, StaleHead>();
  /** Each repo and base branch's CI config and when it was read. */
  readonly ciConfigs = new Map<string, [number, CiInfo]>();
  readonly nextLabels = new next.NextLabels();
  readonly sync = new GithubSync();
  readonly scheduledReads = new Map<string, number>();
  readonly scheduledSeen = new Set<string>();
  readonly repoChecks = new Map<string, RepoChecksCached>();
  readonly regenConfigs = new Map<string, [number, Regenerate | undefined]>();
  readonly migrationsRead = new Set<string>();
  readonly regenTasks = new Set<Promise<unknown>>();
  readonly regenTurns = new Locks();
  /** The warnings logged, so one that repeats every pass logs at most hourly (`warnHourly`). */
  readonly repeats = new Repeats();
  private readonly stopped = new AbortController();

  constructor(
    readonly host: TrainHost,
    readonly clock: { now(): number },
    db: HubDb,
    gh: GhRunner,
    options: Partial<TrainOptions> = {},
  ) {
    this.options = { ...defaultOptions(this.stopped.signal), ...options };
    this.records = new ChangeRecords(db);
    // A regeneration running when the hub stopped stopped with it: it is tried again.
    this.records.endWaitsIn(WAIT_REGEN, REGEN_RUNNING);
    this.github = new TrainGitHub(gh, this.options.fresh, () => this.clock.now(), this.options.sleep);
  }

  /** Stops the follower and every repo loop. */
  stop(): void {
    this.stopped.abort();
  }

  /** Waits for every regeneration started so far: tests. */
  async regenerationsDone(): Promise<void> {
    while (this.regenTasks.size > 0) await Promise.all([...this.regenTasks]);
  }

  /** Follows `task.completed` and `project.removed`, and starts the loop of every known train. */
  start(): void {
    const from = this.host.eventsHead();
    void (async () => {
      let cursor = from;
      while (!this.stopped.signal.aborted) {
        let page;
        try {
          page = await this.host.eventsWait(cursor, ["task.completed", "project.removed"], 300, this.stopped.signal);
        } catch (error) {
          console.warn("train: events not read:", error);
          await this.options.sleep(1000);
          continue;
        }
        cursor = page.cursor;
        for (const event of page.events) {
          try {
            if (event.eventType === "project.removed") this.dropRemoved();
            else await this.onTaskCompleted(event.data);
          } catch (error) {
            console.warn("train: event not handled:", error);
          }
        }
      }
    })();
    // Catches up with projects removed while the hub was down.
    this.dropRemoved();
    for (const train of this.records.trains()) this.ensureLoop(train.repo);
  }

  nowMs(): number {
    return this.clock.now();
  }

  private nowIso(): string {
    return isoMs(this.nowMs());
  }

  emit(projectRef: ProjectRef, type: string, summary: string, data: unknown): void {
    this.host.appendEvent(projectRef, type, summary, data);
  }

  wakeLead(projectRef: ProjectRef, line: string): Promise<void> {
    return this.host.wakeLead(projectRef, line);
  }

  /** Applies `nextFn` to the stored Change if it is still in one of `from` (any state when undefined). */
  update(changeId: string, from: ChangeState[] | undefined, nextFn: (c: Change) => Change): Change | undefined {
    const current = this.records.get(changeId);
    if (!current) return undefined;
    if (from && !from.includes(current.state)) return undefined;
    const was = current.state;
    const shown = current.lastError;
    const changed = { ...nextFn({ ...current, reviews: [...current.reviews] }), updatedAt: this.nowIso() };
    this.records.put(changed);
    if (changed.state !== was) {
      this.stateSpan(was, changed);
      const bounced = changed.state === "ready" && HEAD_STATES.includes(was);
      const reason = bounced || changed.lastError !== shown ? changed.lastError : undefined;
      const data: Record<string, unknown> = {
        changeId: changed.changeId,
        workstreamId: changed.workstreamId,
        repo: changed.repo,
        prNumber: changed.prNumber,
        from: was,
        to: changed.state,
      };
      if (reason !== undefined) data.reason = reason;
      this.emit(
        changed.projectRef,
        "change.state",
        `${changed.changeId} ${was} → ${changed.state}: ${changed.repo}#${changed.prNumber}${reason !== undefined ? ` (${reason})` : ""}`,
        data,
      );
    }
    return changed;
  }

  /** The time inspector's change lane: the span of the state the change left closes, and the new state's opens. */
  private stateSpan(left: ChangeState | undefined, change: Change): void {
    const time = this.host.time();
    if (!time) return;
    const now = this.nowMs();
    const prefix = `change/${change.changeId}/`;
    if (left !== undefined) time.close(prefix, now);
    const kinds: Partial<Record<ChangeState, [string, string?]>> = {
      queued: ["change.review"],
      reviewing: ["change.review"],
      ready: ["change.queue"],
      rebasing: ["change.rebase"],
      ci: ["change.ci"],
      merging: ["change.merge"],
      needs_rebase: ["change.blocked", "needs_rebase"],
      ci_failed: ["change.blocked", "ci_failed"],
    };
    const k = kinds[change.state];
    if (!k) return;
    time.span({
      srcKey: `${prefix}${change.state}/${now}`,
      kind: k[0],
      startMs: now,
      ids: changeIds(change),
      lane: changeLane(change),
      label: `${change.repo}#${change.prNumber}`,
      ...(k[1] ? { extra: { reason: k[1] } } : {}),
    });
  }

  private one(change: Change): Change {
    return this.records.positioned([change])[0]!;
  }

  /** The project the repo's train runs in: the one it was created for, or `fallback` once that one is removed. */
  trainProject(repo: string, fallback: ProjectRef): ProjectRef {
    const t = this.records.train(repo);
    if (!t) return fallback;
    const same = t.projectRef.machineId === fallback.machineId && t.projectRef.projectId === fallback.projectId;
    if (same || this.host.projectRoot(t.projectRef) !== undefined) return t.projectRef;
    if (this.host.projectRoot(fallback) !== undefined) {
      this.records.rebindTrain(repo, fallback);
      return fallback;
    }
    return t.projectRef;
  }

  /**
   * Each train whose project was removed goes with it, unless another project has the same repo. Its Changes stay, as
   * history, and its PRs not already on their way in leave the train (`dropRemovedChanges`).
   */
  dropRemoved(): void {
    this.dropRemovedChanges();
    for (const train of this.records.trains()) {
      if (!projectRemoved(this.host, train.projectRef)) continue;
      const other = this.host.repoProjects(train.repo)[0];
      if (other) {
        this.records.rebindTrain(train.repo, other);
        console.info(`train: ${train.repo} moved to ${other.machineId}/${other.projectId}, its project ${train.projectRef.projectId} was removed`);
      } else {
        this.records.dropTrain(train.repo, train.projectRef);
        console.info(`train: ${train.repo} dropped, its project was removed`);
      }
    }
  }

  /**
   * The PRs of removed projects not already on their way in leave the train as abandoned, as a stopped order's do: no
   * lead or writer is left to hear of them, and their reads would only fail every pass. They stay open on GitHub.
   */
  private dropRemovedChanges(): void {
    const gone = new Map<string, boolean>();
    const removed = (r: ProjectRef) => {
      const key = `${r.machineId}/${r.projectId}`;
      let is = gone.get(key);
      if (is === undefined) gone.set(key, (is = projectRemoved(this.host, r)));
      return is;
    };
    const left = this.records
      .unlandedAll()
      .filter((c) => leavesTheTrain(c.state) && removed(c.projectRef))
      .filter((c) => this.update(c.changeId, [c.state], (x) => ({ ...x, state: "abandoned", lastError: errorText(REMOVED_PROJECT) })) !== undefined).length;
    if (left > 0) console.info(`train: the PRs of removed projects left the train (${left})`);
  }

  /** `console.warn` at most hourly while `what` repeats for `key` (`warn_hourly!`). */
  warnHourly(key: string[], what: string, line: string): void {
    warnHourly(this.repeats, this.nowMs(), key, what, line);
  }

  /** Where the repo's train reads its branch prefix and its rules: that repo's checkout in the owning project. */
  trainCheckout(repo: string, fallback: ProjectRef): ProjectRef {
    const owner = this.trainProject(repo, fallback);
    return this.host.githubRepos(owner).find(([r]) => r === repo)?.[1] ?? owner;
  }

  kick(repo: string): void {
    this.kicks.get(repo)?.notifyOne();
  }

  /** A writer in the project opened a PR or ended: the project's trains read their open PRs on a pass now. */
  writerOpenedPr(projectRef: ProjectRef): void {
    for (const t of this.records.trains()) {
      if (t.projectRef.machineId === projectRef.machineId && t.projectRef.projectId === projectRef.projectId) {
        this.lastReadyCheck.delete(t.repo);
        this.kick(t.repo);
      }
    }
  }

  /** The `pr.fix` prompt with `problem` to the task that wrote the PR, else to the lead as an event line. */
  tellAuthor(change: Change, problem: string): Promise<void> {
    return this.tellAuthorWith(change, problem, "");
  }

  private async tellAuthorWith(change: Change, problem: string, details: string): Promise<void> {
    const set = this.promptSet(change);
    const open = openBlocking(this.records.db, change.prUrl);
    const all = [details.trim(), open].filter((d) => d !== "").join("\n\n");
    const text = fixYourPr(set, change, problem, all);
    if (change.taskId !== undefined) {
      try {
        await this.host.messageTask(change.projectRef, TRAIN_BY, change.taskId, text);
        return;
      } catch (error) {
        this.warnHourly([`train: author ${change.taskId} of ${change.changeId} not messaged`], (error as Error).message, `train: author ${change.taskId} of ${change.changeId} not messaged: ${(error as Error).message}`);
      }
    }
    await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
  }

  /** The prompt texts for a message about `change`: its author's pinned ones, else the project's. */
  promptSet(change: Change) {
    const ps = this.prompts;
    return change.taskId !== undefined ? ps.forTask(change.projectRef, change.taskId) : ps.current(change.projectRef);
  }

  /** The prompt texts it sends: the hub's prompts area (`HubHost` sets it), the shipped texts otherwise. */
  prompts: PromptsLike = SHIPPED_PROMPTS;

  private setReady(change: Change, reviews: ChangeReview[]): Change | undefined {
    const ready = this.update(change.changeId, ["queued", "reviewing", "needs_rebase", "ci_failed"], (c) => {
      const { lastError: _, ...rest } = c;
      const list = [...rest.reviews];
      for (const r of reviews) if (!list.some((x) => sameReview(x, r))) list.push(r);
      return { ...rest, state: "ready", reviews: list };
    });
    if (!ready) return undefined;
    this.emit(ready.projectRef, "change.ready", `${ready.changeId} ready for the train: ${ready.repo}#${ready.prNumber}`, {
      changeId: ready.changeId,
      workstreamId: ready.workstreamId,
    });
    this.kick(ready.repo);
    return ready;
  }

  /** Hands a Change in `reviewing` to the gate; a head that would undo work already on its base goes back first. */
  async toGate(change: Change): Promise<void> {
    const undoes = await this.undoesBase(change);
    if (undoes) return this.sendBack(change, undoes[0], `it ${undoes[0]}`, undoes[1]);
    const v = await this.gate.review(change);
    if (v.kind === "ready") this.setReady(change, v.reviews);
  }

  /** Whether the Change's head puts files back to older versions of its base's: a short why and the details. */
  private async undoesBase(change: Change): Promise<[string, string] | undefined> {
    try {
      const pull = await this.github.pull(change.repo, change.prNumber);
      if (reverts.deliberate(`${pull.title}\n${pull.body ?? ""}`)) return undefined;
      const found = await reverts.restores(this.github, change.repo, pull.base.ref, change.headSha);
      if (found.length === 0) return undefined;
      const commits = new Set(found.flatMap((r) => r.undone.map((v) => v.commit)));
      const base = pull.base.ref;
      const why = `would undo ${commits.size} ${commits.size === 1 ? "commit" : "commits"} of ${base}: rebuild it on origin/${base}`;
      return [why, reverts.details(found, base)];
    } catch (error) {
      this.warnHourly([`train: undone work not checked for ${change.changeId}`], ghMessage(error), `train: undone work not checked for ${change.changeId}: ${ghMessage(error)}`);
      return undefined;
    }
  }

  /** The PR's head and its patch id, from GitHub. */
  private async seen(change: Change, pull: Pull): Promise<[string, string]> {
    const head = pull.head.sha.toLowerCase();
    return [head, await this.github.patchId(change.repo, pull.base.ref, head)];
  }

  /** Reads the PR branch's head and patch id: a new Change goes to the gate, a parked one with the same patch back. */
  async admit(change: Change, pull: Pull): Promise<void> {
    const [headSha, patchId] = await this.seen(change, pull);
    const stacked = await next.stack(this, change, pull);
    if (stacked.patchId === patchId && stacked.state !== "queued") {
      const moved = this.update(stacked.changeId, [stacked.state], (c) => ({ ...c, headSha }));
      if (moved && moved.state !== "reviewing" && moved.state !== "ready") this.setReady(moved, []);
      return;
    }
    const reviewing = this.update(stacked.changeId, [stacked.state], (c) => {
      const { lastError: _, ...rest } = c;
      return { ...rest, headSha, patchId, state: "reviewing" };
    });
    if (reviewing) await this.toGate(reviewing);
  }

  /** When an order is stopped, its PRs not merged and not on their way in leave the train with `why`. */
  takeLeftovers(projectRef: ProjectRef, workstreamId: string, why: string): Change[] {
    const changes = this.records.unlanded(projectRef, workstreamId);
    return leftovers(changes, workstreamId)
      .map((c) => this.update(c.changeId, [c.state], (x) => ({ ...x, state: "abandoned", lastError: why })))
      .filter((c): c is Change => c !== undefined);
  }

  async abandon(change: Change, why: string): Promise<void> {
    const done = this.update(change.changeId, [change.state], (c) => ({ ...c, state: "abandoned", lastError: why }));
    if (done) await this.wakeLead(change.projectRef, prLeft(change.changeId, change.prUrl, why));
  }

  /** `landed` is the batch PR it landed in with the others, when it did. */
  async finishMerged(change: Change, mergedSha: string | undefined, landed?: batch.Landed): Promise<void> {
    const sha = mergedSha?.toLowerCase();
    const merged = this.update(change.changeId, undefined, (c) => {
      const { lastError: _, ...rest } = c;
      return { ...rest, state: "merged", ...(sha !== undefined ? { mergedSha: sha } : {}) };
    });
    if (!merged) return;
    this.mergeRefusals.delete(change.changeId);
    const asSha = sha !== undefined ? ` as ${short(sha)}` : "";
    const data: Record<string, unknown> = { changeId: merged.changeId, workstreamId: merged.workstreamId, repo: merged.repo, prNumber: merged.prNumber };
    if (sha !== undefined) data.mergedSha = sha;
    if (merged.taskId !== undefined) data.taskId = merged.taskId;
    data.mergedAt = isoMs(this.nowMs());
    if (landed) data.batchPr = landed.prNumber;
    const note = landed ? ` in batch #${landed.prNumber}` : "";
    this.emit(merged.projectRef, "pr.merged", `${merged.changeId} merged: ${merged.repo}#${merged.prNumber}${asSha}${note}`, data);
    await this.wakeLead(merged.projectRef, prMerged(merged.changeId, merged.prUrl, asSha, merged.taskId));
    // The PRs held for this one may go now, in whichever repo they are.
    for (const repo of this.records.afterRepos(merged.prUrl)) this.kick(repo);
  }

  /** `why` completes "it ...". From the train's own rebase, or from the queue when GitHub finds it conflicts. */
  async needsRebase(change: Change, why: string): Promise<void> {
    await this.sendBack(change, why, `the merge train could not rebase it: it ${why}`, "");
  }

  /** Parks the Change as needing a rebase with `why`, and tells its author `problem`. */
  private async sendBack(change: Change, why: string, problem: string, details: string): Promise<void> {
    const parked = this.update(change.changeId, ["rebasing", "queued", "reviewing", "ready"], (c) => {
      const out: Change = { ...c, state: "needs_rebase", lastError: errorText(why) };
      // Not reviewed yet: its next head goes to review even if its patch stays the same.
      if (c.state === "reviewing") delete out.patchId;
      return out;
    });
    if (!parked) return;
    this.emit(change.projectRef, "change.needs_rebase", `${change.changeId} needs a rebase: ${why}`, {
      changeId: change.changeId,
      workstreamId: change.workstreamId,
    });
    await this.tellAuthorWith(parked, problem, details);
  }

  /** `stall` when CI ran out of time rather than went red: the train keeps reading its head's checks. */
  async ciFailed(change: Change, failing: CheckRun[], stall?: Stall): Promise<void> {
    const names = failing.map((r) => `${r.name} (${r.conclusion ?? r.status})`);
    const logUrl = failing.find((r) => r.html_url)?.html_url ?? undefined;
    const min = (ms: number) => Math.round(ms / 60_000);
    let why: string;
    if (stall) {
      let what: string;
      const s = (n: number) => (n === 1 ? "" : "s");
      switch (stall.kind) {
        case "no_checks":
          what = `no check reported within ${min(this.options.ciTimeoutMs)} min`;
          break;
        case "queued":
          what = `${stall.count} check${s(stall.count)} waited ${min(this.options.ciQueueCeilingMs)} min for a runner and none started`;
          break;
        case "running":
          what = `it did not finish within ${min(this.options.ciTimeoutMs)} min of its first check starting`;
          break;
        case "unreported":
          what = `the ${stall.all ? "required " : ""}check${s(stall.names.length)} ${stall.names.join(", ")} never reported within ${min(this.options.ciTimeoutMs)} min; every other check passed`;
          break;
        case "never_ran": {
          const one = stall.names.length === 1;
          what =
            `the check${one ? "" : "s"} ${stall.names.join(", ")} never ran, and every other check finished and passed ${min(NEVER_RAN_WAIT_MS)} min ago. The project's train ` +
            `settings or the repo's .fleetd/train.json name ${one ? "it" : "them"}: if a job was renamed or removed, fix the name there`;
          break;
        }
        case "removed": {
          const one = stall.names.length === 1;
          what =
            `its tree has no job for the check${one ? "" : "s"} ${stall.names.join(", ")}, which the base requires: ${one ? "it" : "they"} can't run on it, and ` +
            `GitHub won't merge it until the base's rules stop requiring ${one ? "it" : "them"} (a repo admin's change: ask ` +
            "for it first, or keep the job)";
          break;
        }
      }
      why = `${CI_TIMED_OUT} on ${short(change.headSha)}: ${what}`;
    } else {
      why = `CI failed on ${short(change.headSha)}: ${names.join(", ")}${logUrl ? ` (log: ${logUrl})` : ""}`;
    }
    const parked = this.update(change.changeId, ["ci", "ci_failed"], (c) => ({ ...c, state: "ci_failed", lastError: errorText(why) }));
    if (!parked) return;
    const data: Record<string, unknown> = { changeId: change.changeId, workstreamId: change.workstreamId, checks: failing.map((r) => r.name) };
    if (logUrl) data.logUrl = logUrl;
    this.emit(change.projectRef, "change.ci_failed", `${change.changeId} ${why}`, data);
    if (stall) {
      // A push would only start CI again: the lead hears of it, and the author is left to work.
      await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, `${why}; ${CI_WATCHED}`));
      return;
    }
    await this.tellAuthor(parked, `the merge train did not merge it: ${why}`);
  }

  /** Polls the check runs of `sha` until all are done, one is red, or the timeout passes. */
  async waitCi(change: Change, repo: string, sha: string, base: string, lone: next.Lone | undefined, noted: string[]): Promise<CiOutcome> {
    return (await this.watchCi(change, repo, sha, base, lone, noted)) ?? { kind: "timeout", stall: { kind: "running" } };
  }

  /** `waitCi`, given up once `until` passes with its checks not finished (undefined then), running `between`. */
  async watchCi(
    change: Change,
    repo: string,
    sha: string,
    base: string,
    lone: next.Lone | undefined,
    noted: string[],
    until?: number,
    between?: Between,
  ): Promise<CiOutcome | undefined> {
    const earlier = new Map<string, string | undefined>();
    const outcome = await this.pollCi(change, repo, sha, base, lone, noted, earlier, until, between);
    next.runnerNote(this, noted, undefined, earlier);
    return outcome;
  }

  private async pollCi(
    change: Change,
    repo: string,
    sha: string,
    base: string,
    loneIn: next.Lone | undefined,
    noted: string[],
    earlier: Map<string, string | undefined>,
    until: number | undefined,
    between: Between | undefined,
  ): Promise<CiOutcome | undefined> {
    const lone = loneIn ? { ...loneIn } : undefined;
    let start = this.nowMs();
    let last: CheckRun[] = [];
    let queuedSince: number | undefined;
    const reruns: next.Reruns = new Map();
    const failedReruns: next.Reruns = new Map();
    const flaky: Flaky[] = [];
    const cancelRead = { n: 0 };
    let triedLabel = start;
    let told = false;
    let finishedWithout: number | undefined;
    // A PR's own head, not a batch's: it merges alone, so the checks a batch skips are decided here (D204).
    const alone = change.headSha === sha;
    let refreshed = start;
    for (;;) {
      let all: CheckRun[] = [];
      let unreported: string[] = [];
      let baseRequires: string[] = [];
      let removedRequired: string[] = [];
      let runsRead: CheckRun[] | undefined;
      try {
        all = await this.github.allCheckRuns(repo, sha);
        runsRead = latest(all);
      } catch (error) {
        this.warnHourly([`train: check runs not read (${repo}@${sha})`], ghMessage(error), `train: check runs not read (${repo}@${sha}): ${ghMessage(error)}`);
      }
      const fast = await this.fast(repo, base);
      const skips = alone ? ((await next.workflows(this, repo, base))?.batch ?? []) : [];
      if (runsRead) runsRead = next.provenRuns(runsRead, skips);
      const skippedByBatch = skips.map((b) => b.name);
      // A check the train re-ran for failing is waited for until that re-run is done, in the fast set or not: queued
      // or running, it isn't red, and `gated` would let the PR merge past it.
      const judge = (runs: CheckRun[]) => {
        const judged = gated(runs, fast);
        for (const r of runs) {
          const waited = skippedByBatch.some((n) => next.gatedName(n, r.name)) || flaky.some((f) => f.check === r.name);
          if (waited && !judged.some((j) => j.name === r.name)) judged.push(r);
        }
        return judged;
      };
      if (runsRead) {
        const judged = judge(runsRead);
        const now = this.nowMs();
        const q = next.queued(judged);
        queuedSince = q > 0 ? (queuedSince ?? now) : undefined;
        const note = queuedSince !== undefined && now - queuedSince >= next.RUNNER_WAIT_MS ? `${next.WAITING_FOR_RUNNERS} (${q} queued)` : undefined;
        next.runnerNote(this, noted, note, earlier);
      }
      const runs = runsRead ?? [];
      const judgedRuns = judge(runs);
      if (judgedRuns.length > 0) last = judgedRuns;
      else if (runs.length > 0) last = runs;
      let judged: Checks = checks(judgedRuns);
      if (judged.kind === "none" && runs.length > 0) judged = { kind: "green" };
      if (judged.kind === "red" && allCancelled(judged.runs)) {
        // A cancelled check is never a failure: the new head goes through instead, or the run is re-run (D191).
        if (await this.superseded(change, repo, sha, judged.runs, cancelRead)) return { kind: "moved" };
        if ((await this.rerunCancelled(repo, judged.runs, all, reruns)) === true) start = this.nowMs();
      } else if (judged.kind === "red" && alone) {
        const now = await rerunFailed(this, repo, judged.runs, all, failedReruns, flaky);
        if (now === undefined) {
          this.checkSpans(change, sha, runs);
          return { kind: "red", runs: judged.runs };
        }
        if (now) {
          // The re-run's time is its own, and it has had none yet.
          start = this.nowMs();
          await this.options.sleep(this.busyWait(start, CI_FIRST_WAIT_MS));
          continue;
        }
      } else if (judged.kind === "red") {
        this.checkSpans(change, sha, runs);
        return { kind: "red", runs: judged.runs };
      } else if (judged.kind === "green" && lone && this.holdsForLabel(lone, runs, start)) {
        const now = this.nowMs();
        const unproven = next.unprovenSkips(runs, lone);
        if (lone.label.kind === "failed" && now - triedLabel >= next.LABEL_HOLD_MS) {
          triedLabel = now;
          lone.label = await next.label(this, repo, change.prNumber, false);
        }
        if (!told && now - next.loneSince(lone, start) >= next.LABEL_HOLD_MS) {
          told = true;
          const names = unproven.map((r) => r.name);
          const why = lone.label.kind === "failed" ? `the train could not put \`${NEXT_LABEL}\` on it` : "no run replaced them since the label went on";
          const text =
            `CI didn't start for the labelled PR: ${names.join(", ")} skipped, and ${why}. The train keeps waiting ` +
            "and won't merge it on a skipped check; check the repo's label workflow.";
          console.warn(`train: label run missing for ${change.changeId}: ${text}`);
          await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
        }
      } else if (judged.kind === "green") {
        const required = (await this.ciConfigOk(repo, base))?.requiredChecks;
        let waits = mustReport(fast, required);
        for (const name of skippedByBatch) {
          waits ??= [];
          if (!waits.includes(name) && !runs.some((r) => next.gatedName(name, r.name))) waits.push(name);
        }
        baseRequires = required ? [...required] : [];
        if (waits) {
          const unrun = waits.filter((n) => !runs.some((r) => next.gatedName(n, r.name)));
          if (unrun.length > 0) {
            const gone = await next.undefinedAt(this, repo, base, sha, unrun);
            if (gone.length > 0) console.info(`train: checks the tree at ${repo}@${sha} doesn't define: ${gone.join(", ")}`);
            waits = waits.filter((n) => baseRequires.includes(n) || !gone.includes(n));
            removedRequired = gone.filter((n) => baseRequires.includes(n));
          }
        }
        const [reported, missing] = await this.requiredReported(repo, sha, runs, waits);
        unreported = missing;
        if (reported.kind === "red") {
          this.checkSpans(change, sha, runs);
          return { kind: "red", runs: reported.runs };
        }
        if (reported.kind === "green") {
          const cancelled = cancelledRequired(all, required);
          if (cancelled.length === 0) {
            this.checkSpans(change, sha, runs);
            await flakyNote(this, change, sha, flaky);
            return { kind: "green" };
          }
          if (await this.superseded(change, repo, sha, cancelled, cancelRead)) return { kind: "moved" };
          // Re-runs spent, it waits for the timeout: cancelled is no failure (D191).
          if ((await this.rerunCancelled(repo, cancelled, all, reruns)) === true) start = this.nowMs();
        }
      } else if (judged.kind === "pending") {
        // A check GitHub left pending under a finished run never finishes by itself: its run goes again. The re-run's
        // time is its own.
        if ((await rerunStale(this, repo, sha, judgedRuns))?.now) start = this.nowMs();
      }
      if (until !== undefined && this.nowMs() >= until) return undefined;
      const neverRan = unreported.filter((n) => !baseRequires.includes(n));
      const finished = all.length > 0 && all.every((r) => r.status === "completed");
      if (finished && removedRequired.length > 0) {
        this.checkSpans(change, sha, last);
        return { kind: "timeout", stall: { kind: "removed", names: removedRequired } };
      }
      const now = this.nowMs();
      finishedWithout = finished && neverRan.length > 0 ? (finishedWithout ?? now) : undefined;
      if (finishedWithout !== undefined && now - finishedWithout >= NEVER_RAN_WAIT_MS) {
        this.checkSpans(change, sha, last);
        return { kind: "timeout", stall: { kind: "never_ran", names: neverRan } };
      }
      let stall = this.stalled(last, start);
      if (stall) {
        this.checkSpans(change, sha, last);
        // Every run finished: it is the required checks that never came, not CI that ran long.
        if (stall.kind === "running" && unreported.length > 0) {
          stall = { kind: "unreported", names: unreported, all: unreported.every((n) => baseRequires.includes(n)) };
        }
        return { kind: "timeout", stall };
      }
      // A push while the train waits on CI: the PRs waiting in line take their new heads now.
      if (now - refreshed >= this.options.pollIntervalMs) {
        refreshed = now;
        if (alone && (await this.headMoved(change, repo, sha))) return { kind: "moved" };
        await this.refresh(repo);
      }
      // A pass waiting on CI is the train running: keep its source live and main CI read.
      this.options.fresh.touch(freshTrain(repo), this.nowMs());
      const train = this.records.train(repo);
      if (train) await this.mainCiPass(repo, train.projectRef);
      if (between) await between();
      await this.options.sleep(this.busyWait(start, CI_FIRST_WAIT_MS));
    }
  }

  /** A green read of a PR merged alone still holds for a skipped check its label runs. */
  private holdsForLabel(lone: next.Lone, runs: CheckRun[], start: number): boolean {
    const unproven = next.unprovenSkips(runs, lone);
    // Workflows not read yet: the hold lasts `LABEL_HOLD_MS`, then the skips count.
    return unproven.length > 0 && (lone.gate.kind !== "unknown" || this.nowMs() - next.loneSince(lone, start) < next.LABEL_HOLD_MS);
  }

  /** Whether the checks `required` names have all reported green on `sha`, with those that reported nothing. */
  private async requiredReported(repo: string, sha: string, runs: CheckRun[], required: string[] | undefined): Promise<[Checks, string[]]> {
    const req = required ?? [];
    if (req.every((n) => n === TRAIN_CONTEXT || runs.some((r) => r.name === n))) return [{ kind: "green" }, []];
    try {
      const statuses = await this.github.statuses(repo, sha);
      const missing = req
        .filter((n) => n !== TRAIN_CONTEXT)
        .filter((n) => !runs.some((r) => r.name === n))
        .filter((n) => !statuses.some((s) => s.context === n));
      return [requiredChecks(runs, statuses, req), missing];
    } catch (error) {
      this.warnHourly([`train: commit statuses not read (${repo}@${sha})`], ghMessage(error), `train: commit statuses not read (${repo}@${sha}): ${ghMessage(error)}`);
      return [{ kind: "pending" }, []];
    }
  }

  /** Whether the PR of a Change in CI alone at `sha` has moved to another head, read once per newer cancelled check. */
  private async superseded(change: Change, repo: string, sha: string, cancelled: CheckRun[], read: { n: number }): Promise<boolean> {
    const newest = cancelled.reduce((m, r) => Math.max(m, r.id), 0);
    if (change.headSha !== sha || newest <= read.n) return false;
    read.n = newest;
    return this.headMoved(change, repo, sha);
  }

  /** Whether the Change's PR has a head other than `sha` now. False when it can't be read. */
  private async headMoved(change: Change, repo: string, sha: string): Promise<boolean> {
    try {
      return (await this.github.pull(repo, change.prNumber)).head.sha.toLowerCase() !== sha;
    } catch (error) {
      this.warnHourly([`train: PR of ${change.changeId} not read`], ghMessage(error), `train: PR of ${change.changeId} not read: ${ghMessage(error)}`);
      return false;
    }
  }

  /** Re-runs each job whose required check reads cancelled, on its own: whether it re-ran any; undefined when it can't. */
  async rerunCancelled(repo: string, cancelled: CheckRun[], runs: CheckRun[], reruns: next.Reruns): Promise<boolean | undefined> {
    const r = await next.rerunJobs(this, repo, cancelled, runs, reruns, CANCELLED_RERUNS);
    return !r.unknown && !r.spent && !r.gaveUp ? r.now : undefined;
  }

  /** Whether CI on a head has had its time (D128). */
  private stalled(runs: CheckRun[], start: number): Stall | undefined {
    const now = this.nowMs();
    const over = (since: number, limit: number) => now - since >= limit;
    if (runs.length === 0) return over(start, this.options.ciTimeoutMs) ? { kind: "no_checks" } : undefined;
    const since = runningSince(runs, start);
    if (since !== undefined) return over(Math.max(since, start), this.options.ciTimeoutMs) ? { kind: "running" } : undefined;
    return over(start, this.options.ciQueueCeilingMs) ? { kind: "queued", count: runs.length } : undefined;
  }

  /** The repos whose ready PRs wait because they have no CI, sorted. */
  reposWithoutCi(): string[] {
    return this.records
      .trains()
      .map((t) => t.repo)
      .filter((repo) => this.records.inTrain(repo, ["ready"]).some((c) => c.lastError === batch.NO_CI))
      .sort();
  }

  /** Whether PRs into `base` get CI: the repo has a workflow, or `base` requires a check other than the train's own. */
  async hasCi(repo: string, base: string): Promise<boolean> {
    const ci = await this.ciConfig(repo, base);
    return ci.workflows.length > 0 || ci.requiredChecks.some((c) => c !== TRAIN_CONTEXT);
  }

  /** The fast set of a head into `base`; undefined while the base's rules or the repo's file can't be read. */
  async fast(repo: string, base: string): Promise<Fast | undefined> {
    const ci = await this.ciConfigOk(repo, base);
    if (!ci) return undefined;
    const settings = await repoChecks(this, repo, base);
    return settings ? new Fast(ci.requiredChecks, settings) : undefined;
  }

  /** `base`'s CI config, read at most every `CI_CONFIG_TTL_MS`. */
  async ciConfig(repo: string, base: string): Promise<CiInfo> {
    const key = `${repo}\u0000${base}`;
    const now = this.nowMs();
    const cached = this.ciConfigs.get(key);
    if (cached && now - cached[0] < CI_CONFIG_TTL_MS) return cached[1];
    const ci = await this.github.ciConfig(repo, base);
    this.ciConfigs.set(key, [now, ci]);
    return ci;
  }

  private async ciConfigOk(repo: string, base: string): Promise<CiInfo | undefined> {
    try {
      return await this.ciConfig(repo, base);
    } catch {
      return undefined;
    }
  }

  /** One `ci.check` span per check run of the deciding poll, and `ci.queue` spans from the train's own push. */
  private checkSpans(change: Change, sha: string, runs: CheckRun[]): void {
    const time = this.host.time();
    if (!time) return;
    const now = this.nowMs();
    const pushedAt = this.pushed.get(change.changeId);
    this.pushed.delete(change.changeId);
    const push = pushedAt && pushedAt[0] === sha ? pushedAt[1] : undefined;
    for (const r of runs) {
      const startMs = r.started_at ? parseMs(r.started_at) : undefined;
      if (startMs === undefined) continue;
      const end = r.completed_at ? parseMs(r.completed_at) : undefined;
      const status = end === undefined ? "incomplete" : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? "ok" : r.conclusion === "cancelled" ? "cancelled" : "failed";
      const extra = { check: r.name.slice(0, 200), ...(r.html_url ? { url: r.html_url.slice(0, 500) } : {}) };
      const lane = `${changeLane(change)}/ci`;
      time.span({ srcKey: `check/${change.changeId}/${sha}/${r.name}`, kind: "ci.check", startMs, endMs: Math.max(end ?? now, startMs), ids: changeIds(change), lane, label: r.name, status, extra });
      if (push !== undefined && push <= startMs) {
        time.span({ srcKey: `ciqueue/${change.changeId}/${sha}/${r.name}`, kind: "ci.queue", startMs: push, endMs: startMs, ids: changeIds(change), lane, label: r.name, extra });
      }
    }
  }

  gateRereview(change: Change): boolean {
    return this.gate.rereview(change);
  }

  /** The gate recorded a verdict: a train waiting on a re-review reads it now. */
  reviewRecorded(): void {
    this.verdicts.notifyWaiters();
  }

  /** The clean `reviews` the gate bound to the Change's patch, added to it. */
  addReviews(change: Change, reviews: ChangeReview[]): Change | undefined {
    return this.update(change.changeId, undefined, (c) => {
      const list = [...c.reviews];
      for (const r of reviews) if (!list.some((x) => sameReview(x, r))) list.push(r);
      return { ...c, reviews: list };
    });
  }

  /** Out of the train and back to review, its place in line kept. */
  toReview(change: Change, why?: string): void {
    this.update(change.changeId, ["ready", "rebasing", "ci", "merging"], (c) => ({ ...c, state: "reviewing", ...(why !== undefined ? { lastError: errorText(why) } : {}) }));
  }

  /** The Change's CI passed, but its re-review didn't finish within `reviewWait`: it waits in review. Why. */
  reviewOverdue(change: Change): string {
    if (change.patchId !== undefined) this.overdue.add(`${change.changeId}\u0000${change.patchId}`);
    return `CI passed on ${short(change.headSha)}, but its re-review didn't finish within ${Math.floor(this.options.reviewWaitMs / 60_000)} min; it waits in review, out of the line, and merges once the review is clean`;
  }

  /** Whether the Change's re-review of its current patch already outlasted `reviewWait` once in the train. */
  overdueReview(change: Change): boolean {
    return change.patchId !== undefined && this.overdue.has(`${change.changeId}\u0000${change.patchId}`);
  }

  /** Waits for the re-reviews of `changes`, at most `reviewWait`: each one's outcome; stops at the first blocked. */
  async awaitReviews(changes: Change[]): Promise<ReviewWait[]> {
    const since = this.nowMs();
    const out: (ReviewWait | undefined)[] = changes.map(() => undefined);
    const done = () => out.map((o) => o ?? ({ kind: "waiting" } as ReviewWait));
    for (;;) {
      // Registered before the reads, so a verdict recorded during them is not missed.
      const recorded = this.verdicts.notified();
      for (let i = 0; i < changes.length; i++) {
        if (out[i]) continue;
        const v = await this.gate.again(changes[i]!);
        if (v.kind === "ready") out[i] = { kind: "clean", reviews: v.reviews };
        else if (v.kind === "blocked") {
          out[i] = { kind: "blocked" };
          return done();
        }
      }
      const left = this.options.reviewWaitMs - (this.nowMs() - since);
      if (out.every((o) => o !== undefined) || left <= 0) return done();
      this.options.fresh.touch(freshTrain(changes[0]!.repo), this.nowMs());
      await Promise.race([this.options.sleep(Math.min(this.options.pollIntervalMs, left)), recorded]);
    }
  }

  /** A pass that could not finish: the Change goes back to ready in its place in line with the reason. */
  putBack(change: Change, why: string): void {
    this.warnHourly([`train: pass failed for ${change.changeId}`], why, `train: pass failed for ${change.changeId}: ${why}`);
    this.update(change.changeId, ["ready", "rebasing", "ci", "merging"], (c) => ({ ...c, state: "ready", lastError: errorText(why) }));
  }

  /** The head of a ready Change moved: the same patch stays ready, a new one goes back to review. */
  async readyMoved(change: Change, pull: Pull): Promise<void> {
    const [headSha, patchId] = await this.seen(change, pull);
    const stacked = await next.stack(this, change, pull);
    if (stacked.patchId === patchId) {
      this.update(stacked.changeId, ["ready"], (c) => ({ ...c, headSha }));
      return;
    }
    const reviewing = this.update(stacked.changeId, ["ready"], (c) => ({ ...c, headSha, patchId, state: "reviewing" }));
    if (reviewing) await this.toGate(reviewing);
  }

  /** The wait before the next read of a Change the train holds: `first`, then an eighth of the time waited so far. */
  private busyWait(sinceMs: number, first: number): number {
    const waited = Math.max(this.nowMs() - sinceMs, 0);
    return Math.min(Math.max(Math.floor(waited / 8), first), this.options.pollIntervalMs);
  }

  /** The PR after `update-branch` rebased it, once GitHub shows its new head. */
  private async rebasedPull(change: Change): Promise<Pull> {
    const start = this.nowMs();
    for (;;) {
      const pull = await this.github.pull(change.repo, change.prNumber);
      if (pull.head.sha.toLowerCase() !== change.headSha) return pull;
      if (this.nowMs() - start >= this.options.ciTimeoutMs) {
        throw GhError.failed(`it still shows its old head ${short(change.headSha)} after the rebase`);
      }
      await this.options.sleep(this.busyWait(start, REBASE_FIRST_WAIT_MS));
    }
  }

  /** Rebase on GitHub, CI, status, pinned merge: one ready Change. */
  async take(change: Change): Promise<void> {
    try {
      await this.takeInner(change);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      this.putBack(change, `GitHub: ${error.message}`);
    }
  }

  private async takeInner(change: Change): Promise<void> {
    const repo = change.repo;
    const pull = await this.github.pull(repo, change.prNumber);
    this.guardBase(repo, pull.base.ref);
    if (pull.merged) return this.abandon(change, "was merged outside the train");
    if (pull.state !== "open") return this.abandon(change, "was closed");
    if (pull.head.sha.toLowerCase() !== change.headSha) return this.readyMoved(change, pull);
    // A Change in review goes only as a re-review, which runs alongside its CI.
    const rebasing = this.update(change.changeId, ["ready", "reviewing"], (c) => ({ ...c, state: "rebasing" }));
    if (!rebasing) return;
    const base = pull.base.ref;
    // Already tested on the base as it is now: no label, no rebase, and no second CI run on the same tree.
    const tested = await batch.testedAlone(this, change, pull);
    let label: next.Labelled;
    if (tested) {
      console.info(`train: ${change.changeId}'s own CI already passed on the current base`);
      label = { kind: "before" };
    } else label = await next.label(this, repo, change.prNumber, hasLabel(pull, NEXT_LABEL));
    const update = tested ? "current" : await this.github.updateBranch(repo, change.prNumber);
    let rebased: Pull;
    if (update === "conflict") {
      const why = `conflicts with ${base}`;
      if ((await conflicted(this, rebasing, pull, why)) === "regenerating") {
        // Back in its place, out of the line until its new head shows.
        this.update(change.changeId, ["rebasing"], (c) => ({ ...c, state: batch.reviewed(c) ? "ready" : "reviewing" }));
      }
      return;
    } else if (update === "current") rebased = pull;
    else rebased = await this.rebasedPull(change);
    let headSha = change.headSha;
    let patchId = change.patchId;
    if (rebased.head.sha.toLowerCase() !== change.headSha) {
      [headSha, patchId] = await this.seen(change, rebased);
      this.pushed.set(change.changeId, [headSha, this.nowMs()]);
    }
    // Reviews are bound to the patch id: a rebase that changed it is reviewed again, alongside its CI.
    const moved = patchId !== rebasing.patchId;
    let inCi = this.update(change.changeId, ["rebasing"], (c) => {
      const out: Change = { ...c, headSha, state: "ci" };
      if (moved) {
        if (patchId !== undefined) out.patchId = patchId;
        out.lastError = `the rebase onto ${base} changed the patch id; its re-review runs alongside CI`;
      }
      return out;
    });
    if (!inCi) return;
    if (moved || !batch.reviewed(inCi)) {
      const v = await this.gate.review(inCi);
      if (v.kind === "ready") inCi = this.addReviews(inCi, v.reviews) ?? inCi;
      else if (v.kind === "blocked") {
        this.toReview(inCi);
        return;
      }
    }
    await this.ciAndMerge(inCi, rebased, base, label);
  }

  /**
   * From CI on the Change's head, in `ci`, to merged: waits for its fast set, posts `fleetd/train` and merges pinned to
   * that head. While its CI runs, ready PRs green on their own heads go in a batch stacked on its head.
   */
  async ciAndMerge(inCi: Change, rebased: Pull, base: string, label: next.Labelled): Promise<void> {
    const repo = inCi.repo;
    const headSha = inCi.headSha;
    const gate = await next.labelGate(this, repo, base);
    const lone = gate.kind === "checks" && gate.names.length === 0 ? undefined : { label, gate };
    const noted = [inCi.changeId];
    const started = this.nowMs();
    const chain: batch.Stage[] = [{ pr: inCi.prNumber, sha: headSha, title: rebased.title, members: [{ change: inCi, pull: rebased }], added: 1, lone: true }];
    const stack = batch.stacker(this, repo, base, chain);
    const outcome = (await this.watchCi(inCi, repo, headSha, base, lone, noted, undefined, stack)) ?? { kind: "timeout", stall: { kind: "running" } };
    const failed =
      outcome.kind === "green"
        ? undefined
        : outcome.kind === "red"
          ? "didn't pass: its CI red"
          : outcome.kind === "timeout"
            ? "didn't pass: its CI timed out"
            : "was pushed to during its CI";
    if (failed) batch.dropBehind(this, chain, failed, base);
    if (outcome.kind === "red") return this.ciFailed(inCi, outcome.runs);
    if (outcome.kind === "timeout") return this.ciFailed(inCi, [], outcome.stall);
    if (outcome.kind === "moved") return this.putBack(inCi, CI_SUPERSEDED);
    // CI passed: the merge also waits for a re-review still at work.
    const current = this.records.get(inCi.changeId);
    if (current && !batch.reviewed(current)) {
      const wait = (await this.awaitReviews([current]))[0]!;
      if (wait.kind !== "clean") batch.dropBehind(this, chain, "was sent back to review", base);
      if (wait.kind === "clean") this.addReviews(current, wait.reviews);
      else if (wait.kind === "blocked") return this.toReview(current);
      else return this.toReview(current, this.reviewOverdue(current));
    }
    if (chain.length > 1) return batch.landChain(this, repo, base, chain, started);
    await this.mergeAlone(this.records.get(inCi.changeId) ?? inCi, rebased, base);
  }

  /** A Change in `ci` whose CI passed, reviewed clean, to merged alone. */
  async mergeAlone(inCi: Change, rebased: Pull, base: string): Promise<void> {
    const repo = inCi.repo;
    const headSha = inCi.headSha;
    const noted = [inCi.changeId];
    const merging = this.update(inCi.changeId, ["ci"], (c) => ({ ...c, state: "merging" }));
    if (!merging) return;
    await this.github.postTrainStatus(repo, headSha, `${inCi.changeId}: rebased onto ${base}, CI green`);
    // The squash message GitHub would write by the repo's settings, with the Change's trailer added.
    const [title, body0] = await this.github.squashMessage(repo, rebased);
    const body = batch.withTrailers(body0, [merging]);
    const mergingSince = this.nowMs();
    let retryWait = MERGE_RETRY_FIRST_MS;
    let status: number;
    let message: string;
    for (;;) {
      const out = await this.github.merge(repo, inCi.prNumber, headSha, [title, body]);
      if (out.kind === "merged") {
        watchMerge(this, repo, base, out.sha, merging.prUrl);
        await this.finishMerged(merging, out.sha);
        return;
      }
      status = out.status;
      message = out.message;
      if (!awaitsChecks(message) || this.nowMs() - mergingSince >= this.options.ciTimeoutMs) break;
      // GitHub still waits on a required check for this head: wait for it too and merge again.
      console.info(`train: merge of ${inCi.changeId} refused until checks report: ${message}`);
      const why = `GitHub refused the merge (HTTP ${status}): ${message}; the train waits for those checks`;
      const backInCi = this.update(inCi.changeId, ["merging"], (c) => ({ ...c, state: "ci", lastError: errorText(why) }));
      if (!backInCi) return;
      await this.options.sleep(retryWait);
      retryWait = Math.min(retryWait * 2, MERGE_RETRY_MAX_MS);
      // GitHub may require a check the cached config doesn't name yet: read the base's rules again.
      this.ciConfigs.delete(`${repo}\u0000${base}`);
      const o = await this.waitCi(backInCi, repo, headSha, base, undefined, noted);
      if (o.kind === "red") return this.ciFailed(backInCi, o.runs);
      if (o.kind === "timeout") return this.ciFailed(backInCi, [], o.stall);
      if (o.kind === "moved") return this.putBack(backInCi, CI_SUPERSEDED);
      if (!this.update(inCi.changeId, ["ci"], (c) => ({ ...c, state: "merging" }))) return;
    }
    const refusals = (this.mergeRefusals.get(inCi.changeId) ?? 0) + 1;
    this.mergeRefusals.set(inCi.changeId, refusals);
    const why = `GitHub refused the merge (HTTP ${status}): ${message}`;
    if (refusals < this.options.mergeAttempts) {
      // Usually the base moved between CI and the merge: rebase again. It never left its place in line.
      this.update(inCi.changeId, ["merging"], (c) => ({ ...c, state: "ready", lastError: errorText(why) }));
      return;
    }
    this.mergeRefusals.delete(inCi.changeId);
    this.update(inCi.changeId, ["merging"], (c) => ({ ...c, state: "ci_failed", lastError: errorText(`${why}; gave up after ${refusals} tries`) }));
    await this.wakeLead(inCi.projectRef, prGaveUp(inCi.changeId, inCi.prUrl, why, refusals));
  }

  /** Changes waiting on something outside the train: a patch id to read, reviews, or the author's next push. */
  async refresh(repo: string): Promise<void> {
    const changes = this.records.inTrain(repo, ["queued", "reviewing", "ready", "needs_rebase", "ci_failed"]);
    const ids = new Set(changes.map((c) => c.changeId));
    this.records.keepWaits(repo, [WAIT_UNSTARTED, WAIT_BLOCKED], [...ids]);
    for (const id of [...this.lateReruns.keys()]) if (!ids.has(id)) this.lateReruns.delete(id);
    const live = [...this.records.inTrain(repo, ["rebasing", "ci", "merging"]), ...changes].map((c) => c.changeId);
    forgetRegens(this, repo, live);
    for (const change of changes) {
      let pull: Pull;
      try {
        pull = await this.github.pull(repo, change.prNumber);
      } catch (error) {
        this.warnHourly([`train: refresh of ${change.changeId} failed`], ghMessage(error), `train: refresh of ${change.changeId} failed: ${ghMessage(error)}`);
        continue;
      }
      this.guardBase(repo, pull.base.ref);
      const moved = pull.head.sha.toLowerCase() !== change.headSha;
      const inLine = !moved && !pull.draft && ["queued", "reviewing", "ready"].includes(change.state);
      if (pull.merged) await this.abandon(change, "was merged outside the train");
      else if (pull.state !== "open") await this.abandon(change, "was closed");
      else if (change.state === "queued" && pull.draft) this.holdDraft(change);
      else if (inLine && conflicts(pull)) await conflicted(this, change, pull, `conflicts with ${pull.base.ref}, so GitHub runs no CI on it`);
      else if (change.state === "ready") {
        // The train takes it from here, and reads a moved head then.
        if (inLine) await this.unstartedChecks(change, pull.base.ref);
      } else if (change.state === "queued" || moved) {
        try {
          await this.admit(change, pull);
        } catch (error) {
          if (!(error instanceof GhError)) throw error;
          const why = errorText(`GitHub: ${error.message}`);
          this.update(change.changeId, [change.state], (c) => ({ ...c, lastError: why }));
        }
      } else if (change.state === "reviewing") {
        const v = await this.gate.again(change);
        if (v.kind === "ready") this.setReady(change, v.reviews);
        else {
          await this.stillBlocked(change, v.kind === "blocked");
          if (inLine) await this.unstartedChecks(change, pull.base.ref);
        }
      } else if (timedOut(change)) await this.afterTimeout(change);
      else if (inLine) await this.unstartedChecks(change, pull.base.ref);
    }
  }

  /** A Change its review's findings have held at one head for `BLOCKED_WAKE`: the lead hears once per head. */
  private async stillBlocked(change: Change, isBlocked: boolean): Promise<void> {
    const head = change.headSha;
    const now = this.nowMs();
    if (!isBlocked) {
      this.records.endWait(change.changeId, WAIT_BLOCKED);
      return;
    }
    this.records.startWait(change, WAIT_BLOCKED, head, now, WAITING);
    const wait = this.records.wait(change.changeId, WAIT_BLOCKED);
    if (!wait || wait.state !== WAITING || now - wait.sinceMs < BLOCKED_WAKE_MS) return;
    this.records.setWait(change.changeId, WAIT_BLOCKED, head, "told");
    const text =
      `its review's blocking findings have held it at ${short(head)} for ${BLOCKED_WAKE_MS / 60_000} min with no new push. If you resolved them ` +
      "without a patch (by narrowing the brief, say), call `change_enqueue` for it again: a fresh full review of " +
      "it starts. Otherwise check on its writer.";
    await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
  }

  /** A Change in line whose head has no check `checksStartWait` after the train first saw it (D191). */
  private async unstartedChecks(change: Change, base: string): Promise<void> {
    const head = change.headSha;
    const now = this.nowMs();
    this.records.startWait(change, WAIT_UNSTARTED, head, now, WAITING);
    const wait = this.records.wait(change.changeId, WAIT_UNSTARTED);
    if (!wait || wait.state !== WAITING || now - wait.sinceMs < this.options.checksStartWaitMs) return;
    const ci = await this.ciConfigOk(change.repo, base);
    if (!ci) return;
    const required = ci.requiredChecks.filter((c) => c !== TRAIN_CONTEXT);
    if (ci.workflows.length === 0 && required.length === 0) return;
    const counts = (name: string) => name !== TRAIN_CONTEXT && (required.length === 0 || required.includes(name));
    let started: boolean;
    try {
      const runs = await this.github.checkRuns(change.repo, head);
      if (runs.some((r) => counts(r.name))) started = true;
      else {
        try {
          started = (await this.github.statuses(change.repo, head)).some((s) => counts(s.context));
        } catch (error) {
          return this.warnHourly([`train: statuses of ${change.changeId} not read`], ghMessage(error), `train: statuses of ${change.changeId} not read: ${ghMessage(error)}`);
        }
      }
    } catch (error) {
      return this.warnHourly([`train: check runs of ${change.changeId} not read`], ghMessage(error), `train: check runs of ${change.changeId} not read: ${ghMessage(error)}`);
    }
    this.records.setWait(change.changeId, WAIT_UNSTARTED, head, "read");
    if (started) return;
    const min = Math.floor(this.options.checksStartWaitMs / 60_000);
    const text =
      `no check started on its head ${short(head)} in ${min} min: GitHub skipped its CI, or no workflow took the push. It ` +
      "keeps its place in the train; push to it again (an empty commit will do) to start its CI";
    if (change.taskId !== undefined) {
      try {
        await this.host.messageTask(change.projectRef, TRAIN_BY, change.taskId, `Your PR ${change.prUrl} (${change.changeId}): ${text}.`);
      } catch (error) {
        this.warnHourly([`train: author ${change.taskId} of ${change.changeId} not messaged`], (error as Error).message, `train: author ${change.taskId} of ${change.changeId} not messaged: ${(error as Error).message}`);
      }
    }
    await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
  }

  /** A queued Change whose PR is a draft waits there, saying so, until the PR is marked ready. */
  private holdDraft(change: Change): void {
    if (!isDraft(change)) this.update(change.changeId, ["queued"], (c) => ({ ...c, lastError: DRAFT }));
  }

  /** A Change whose CI timed out, at the same head: green goes back in the queue; red fails as red CI does (D128). */
  private async afterTimeout(change: Change): Promise<void> {
    let runs: CheckRun[];
    let base: string;
    try {
      runs = await this.github.checkRuns(change.repo, change.headSha);
    } catch (error) {
      return this.warnHourly([`train: check runs of ${change.changeId} not read`], ghMessage(error), `train: check runs of ${change.changeId} not read: ${ghMessage(error)}`);
    }
    try {
      base = (await this.github.pull(change.repo, change.prNumber)).base.ref;
    } catch (error) {
      return this.warnHourly([`train: PR of ${change.changeId} not read`], ghMessage(error), `train: PR of ${change.changeId} not read: ${ghMessage(error)}`);
    }
    const fast = await this.fast(change.repo, base);
    let judged = checks(gated(runs, fast));
    if (judged.kind === "none" && runs.length > 0) judged = { kind: "green" };
    if (judged.kind === "green") {
      const required = (await this.ciConfigOk(change.repo, base))?.requiredChecks;
      judged = (await this.requiredReported(change.repo, change.headSha, runs, mustReport(fast, required)))[0];
    }
    if (judged.kind === "green") {
      if (this.setReady(change, [])) await this.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, CI_FINISHED_LATE));
    } else if (judged.kind === "red" && allCancelled(judged.runs)) await this.lateCancelled(change, judged.runs, runs);
    else if (judged.kind === "red") await this.ciFailed(change, judged.runs);
  }

  /** A timed-out Change whose checks then read cancelled: re-run, then back to its author (D191). */
  private async lateCancelled(change: Change, cancelled: CheckRun[], runs: CheckRun[]): Promise<void> {
    const reruns = this.lateReruns.get(change.changeId) ?? new Map();
    const rerun = await this.rerunCancelled(change.repo, cancelled, runs, reruns);
    this.lateReruns.set(change.changeId, reruns);
    if (rerun !== undefined) return;
    if (this.update(change.changeId, ["ci_failed"], (c) => ({ ...c, lastError: errorText(CI_CANCELLED) }))) {
      await this.tellAuthor(change, `the merge train did not merge it: ${CI_CANCELLED}; push to it again (an empty commit will do) to start its CI`);
    }
  }

  /** Enqueues each PR GitHub was unavailable for again. */
  private async unreadPass(repo: string): Promise<void> {
    const mine = [...this.unread].filter(([url]) => parsePrUrl(url)?.repo.toLowerCase() === repo.toLowerCase());
    for (const [prUrl, [projectRef, input, result]] of mine) {
      this.unread.delete(prUrl);
      try {
        const change = await this.enqueueFrom(projectRef, input, result);
        console.info(`train: ${change.changeId} (${prUrl}) read once GitHub answered`);
      } catch (error) {
        const e = error as TrainError;
        if (e.code === "unavailable" || e.code === MERGED) continue;
        await this.wakeLead(projectRef, prRefused(prUrl, input.taskId ?? "the lead", e.message, e.fix));
      }
    }
  }

  /** A writer's ready PR is a slice: an open, non-draft PR from its branch goes on the train at once, once per head. */
  private async readyPass(repo: string, projectRef: ProjectRef): Promise<void> {
    const now = this.nowMs();
    const last = this.lastReadyCheck.get(repo);
    if (last !== undefined && now - last < this.options.readyEveryMs) return;
    const writers = this.host.writers(projectRef);
    if (writers.length === 0) return;
    this.lastReadyCheck.set(repo, now);
    let pulls;
    try {
      pulls = await this.github.openPulls(repo);
    } catch (error) {
      return this.warnHourly([`train: open PRs of ${repo} not read`], ghMessage(error), `train: open PRs of ${repo} not read: ${ghMessage(error)}`);
    }
    for (const pull of pulls.filter((p) => !p.draft)) {
      const headRef = pull.head.ref;
      const writer = writers.find(([, b]) => headRef === b || (headRef.startsWith(b) && headRef.slice(b.length).startsWith("-")));
      if (!writer) continue;
      if (this.records.openFor(repo, pull.number)) continue;
      const key = `${repo}\u0000${pull.number}\u0000${pull.head.sha.toLowerCase()}`;
      if (this.readyHeads.has(key)) continue;
      this.readyHeads.add(key);
      const prUrl = `https://github.com/${repo}/pull/${pull.number}`;
      try {
        const change = await sliceReady(this, projectRef, writer[0], prUrl);
        console.info(`train: a writer's ready PR is a slice: ${change.changeId} ${prUrl}`);
      } catch (error) {
        const e = error as TrainError;
        await this.wakeLead(projectRef, prRefused(prUrl, writer[0], e.message, e.fix));
      }
    }
  }

  /** After a restart: a Change being merged is finished if GitHub merged it, else put back. CI in flight goes on. */
  private async recover(repo: string): Promise<void> {
    const inCi = this.records.inTrain(repo, ["ci"]);
    let resumed = false;
    if (inCi.length === 1) resumed = (await this.resumeCi(inCi[0]!)) || (await batch.resumeBatch(this, repo, inCi));
    else if (inCi.length > 1) resumed = await batch.resumeBatch(this, repo, inCi);
    for (const change of this.records.inTrain(repo, HEAD_STATES)) {
      if (resumed && inCi.some((c) => c.changeId === change.changeId)) continue;
      let pull: Pull | undefined;
      try {
        pull = await this.github.pull(repo, change.prNumber);
        this.guardBase(repo, pull.base.ref);
      } catch {
        pull = undefined;
      }
      if (pull && pull.merged && change.state === "merging") await this.finishMerged(change, pull.merge_commit_sha ?? undefined);
      else if (pull && change.state === "merging" && pull.state === "open") {
        const landed = await batch.landedInBatch(this, change);
        if (landed) await batch.finishBatchMember(this, change, landed);
        else this.putBack(change, "the hub restarted while the train worked on it");
      } else this.putBack(change, "the hub restarted while the train worked on it");
    }
    this.recovered.add(repo);
  }

  /** A Change alone in `ci` at a restart, its PR open at the head it took: its CI is watched again. */
  private async resumeCi(change: Change): Promise<boolean> {
    let pull: Pull;
    try {
      pull = await this.github.pull(change.repo, change.prNumber);
    } catch {
      return false;
    }
    if (pull.merged || pull.state !== "open" || pull.head.sha.toLowerCase() !== change.headSha) return false;
    // A batch member's head is in CI on the batch's PR, not its own.
    for (const name of batch.batchNames(this.options.pipelineDepth)) {
      const branch = await batch.scratchBranch(this, change, name);
      if (branch === undefined) continue;
      try {
        const open = await this.github.pullsFor(change.repo, branch, "open");
        if (open.some((b) => batchHeads(b.body ?? "").some(([n]) => n === change.prNumber))) return false;
      } catch {}
    }
    console.info(`train: the hub restarted; watching ${change.changeId}'s CI again`);
    this.guardBase(change.repo, pull.base.ref);
    const label = await next.label(this, change.repo, change.prNumber, hasLabel(pull, NEXT_LABEL));
    try {
      await this.ciAndMerge(change, pull, pull.base.ref, label);
    } catch (error) {
      if (!(error instanceof GhError)) throw error;
      this.putBack(change, `GitHub: ${error.message}`);
    }
    return true;
  }

  guardBase(repo: string, base: string): void {
    const key = repo.toLowerCase();
    let set = this.bases.get(key);
    if (!set) {
      set = new Set();
      this.bases.set(key, set);
    }
    set.add(base);
  }

  /** PRs merged without the train into the default branch or a base its Changes target: each reported once. */
  private async checkMergedOutside(repo: string, watchSinceMs: number, projectRef: ProjectRef): Promise<void> {
    const now = this.nowMs();
    const last = this.lastBypassCheck.get(repo);
    if (last !== undefined && now - last < this.options.bypassEveryMs) return;
    this.lastBypassCheck.set(repo, now);
    const failed = (e: unknown) => this.warnHourly([`train: merged PRs of ${repo}`], ghMessage(e), `train: merged PRs of ${repo} not read: ${ghMessage(e)}`);
    let merged;
    try {
      merged = await this.github.mergedPulls(repo, watchSinceMs);
    } catch (e) {
      return failed(e);
    }
    let def = this.sync.base(repo);
    if (def === undefined) {
      try {
        def = await this.github.defaultBranch(repo);
        this.sync.setBase(repo, def);
      } catch (e) {
        return failed(e);
      }
    }
    // Unknown while the owner's policy can't be read: the scan waits rather than report a batch of the train's.
    const scratch = await batch.scratchPrefix(this, repo);
    if (scratch === undefined) return;
    const guarded = this.bases.get(repo) ?? new Set();
    let newest = watchSinceMs;
    for (const pr of merged) {
      const at = parseMs(pr.mergedAt);
      if (at === undefined || at <= watchSinceMs) continue;
      newest = Math.max(newest, at);
      if ((pr.base !== def && !guarded.has(pr.base)) || pr.head.startsWith(scratch)) continue;
      const change = this.records.latestFor(repo, pr.number);
      if (change?.state === "merged") continue;
      const owner = change?.projectRef ?? projectRef;
      const data: Record<string, unknown> = { repo, prNumber: pr.number, mergedAt: isoMs(at), head: pr.head, base: pr.base };
      if (pr.mergeSha !== undefined) data.mergedSha = pr.mergeSha.toLowerCase();
      const created = pr.createdAt !== undefined ? parseMs(pr.createdAt) : undefined;
      if (created !== undefined) data.prCreatedAt = isoMs(created);
      if (pr.authorBot !== undefined) data.authorKind = pr.authorBot ? "bot" : "human";
      try {
        const by = (await this.github.pull(repo, pr.number)).merged_by;
        if (by) {
          data.mergedByKind = by.type === "Bot" ? "bot" : "human";
          data.mergedBy = by.login;
        }
      } catch {}
      if (change) data.changeId = change.changeId;
      const line = `${repo}#${pr.number} was merged into ${pr.base} without the merge train.`;
      this.emit(owner, "pr.merged_outside", line, data);
      // Where the landing scanner watches, its `work.landed` line tells the lead, once.
      if (!this.host.landingsWatched(repo, pr.base)) await this.wakeLead(owner, line);
    }
    if (newest > watchSinceMs) this.records.watchPast(repo, newest);
  }

  /** One pass of the repo's loop. True when it took a Change. */
  async step(rawRepo: string): Promise<boolean> {
    const repo = rawRepo.toLowerCase();
    const took = await this.stepLocks.of(repo).run(() => this.stepInner(repo));
    this.options.fresh.touch(freshTrain(repo), this.nowMs());
    return took;
  }

  private async stepInner(repo: string): Promise<boolean> {
    const train = this.records.train(repo);
    if (!train) return false;
    if (!this.recovered.has(repo)) await this.recover(repo);
    // Before refresh: a member of a batch that landed is merged, never read as a waiting PR that conflicts.
    await batch.reconcileBatches(this, repo);
    await this.refresh(repo);
    await this.unreadPass(repo);
    await this.readyPass(repo, train.projectRef);
    await this.mainCiPass(repo, train.projectRef);
    await watchPass(this, repo);
    await scheduledPass(this, repo, train.projectRef);
    await this.checkMergedOutside(repo, train.watchSinceMs, train.projectRef);
    await batch.sweepScratch(this, repo);
    await next.afterPass(this, repo);
    return batch.next(this, repo);
  }

  ensureLoop(repo: string): void {
    if (!this.options.autoRun || this.loops.has(repo)) return;
    this.loops.add(repo);
    this.expectSources(repo);
    let notify = this.kicks.get(repo);
    if (!notify) {
      notify = new Notify();
      this.kicks.set(repo, notify);
    }
    const kick = notify;
    void (async () => {
      while (!this.stopped.signal.aborted) {
        let took = false;
        try {
          took = await this.step(repo);
        } catch (error) {
          console.warn(`train: pass of ${repo} failed:`, error);
        }
        // A dropped train's loop ends.
        if (!this.records.train(repo)) {
          this.loops.delete(repo);
          this.options.fresh.forget(freshGithub(repo));
          this.options.fresh.forget(freshTrain(repo));
          return;
        }
        if (!took) await Promise.race([this.options.sleep(this.options.pollIntervalMs), kick.notified()]);
      }
    })();
  }

  /** The repo's status sources: GitHub answers and train passes. */
  private expectSources(repo: string): void {
    const now = this.nowMs();
    this.options.fresh.expect(freshGithub(repo), GITHUB_STALE_MS, now);
    this.options.fresh.expect(freshTrain(repo), TRAIN_STALE_MS, now);
  }

  /** Reads main-branch CI when due: `ci.main` on a state change. */
  async mainCiPass(repo: string, projectRef: ProjectRef): Promise<void> {
    if (!this.sync.takeDue(repo, this.nowMs())) return;
    let base = this.sync.base(repo);
    if (base === undefined) {
      try {
        base = await this.github.defaultBranch(repo);
        this.sync.setBase(repo, base);
      } catch (error) {
        return this.warnHourly([`train: default branch of ${repo} not read`], ghMessage(error), `train: default branch of ${repo} not read: ${ghMessage(error)}`);
      }
    }
    let runs: CheckRun[];
    try {
      runs = await this.github.checkRuns(repo, base);
    } catch (error) {
      return this.warnHourly([`train: main CI of ${repo} not read`], ghMessage(error), `train: main CI of ${repo} not read: ${ghMessage(error)}`);
    }
    const [state, failing] = ciState(runs);
    const sha = (runs.find((r) => r.head_sha)?.head_sha ?? "").toLowerCase();
    if (this.sync.record(repo, sha, state, failing, this.nowMs())) {
      const failingText = failing.length === 0 ? "" : `: ${failing.join(", ")}`;
      this.emit(projectRef, "ci.main", `main CI ${state} on ${repo}${failingText}`, {
        repo,
        sha,
        state,
        failing: failing.map((f) => [...f].slice(0, 120).join("")).filter((f) => f !== ""),
      });
    }
  }

  /** Main-branch CI as last read, for the status view. */
  mainCi(repo: string): MainCi | undefined {
    return this.sync.mainCi(repo.toLowerCase());
  }

  /**
   * While main-branch CI is red, a note for the status view: which checks, and whether a fix is under way (an open fix
   * order for the check) or the watch re-runs them once; while it waits on that re-run, which checks. The train
   * doesn't hold merges for it, so it is a warning, not a block.
   */
  mainCiNote(rawRepo: string): string | undefined {
    const repo = rawRepo.toLowerCase();
    const ci = this.sync.mainCi(repo);
    if (!ci) return undefined;
    const base = this.sync.base(repo) ?? "main";
    // A check the watch re-runs once after it failed on the merged commit: said while main waits for it.
    const again = rerunning(this, repo, ci.sha);
    if (ci.state !== "red") {
      return ci.state === "pending" && again.length > 0 ? `${again.map((n) => `\`${n}\``).join(", ")} failed on ${base} after the merge, re-running once` : undefined;
    }
    const fixing = ci.failing.filter((name) => {
      const order = this.records.fixOrder(repo, name)?.order;
      return order !== undefined && this.host.workstream(order)?.open === true;
    });
    const quoted = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");
    const what =
      ci.failing.length === 0 ? `CI is red on ${base}` : ci.failing.length === 1 ? `${quoted(ci.failing)} is red on ${base}` : `${quoted(ci.failing)} are red on ${base}`;
    const fix =
      fixing.length === 0 && ci.failing.some((n) => again.includes(n))
        ? "re-running once"
        : fixing.length === 0
          ? "no fix under way"
          : fixing.length === ci.failing.length ? "fix in progress" : `fix in progress for ${quoted(fixing)}`;
    return `${what}, ${fix}`;
  }

  /** Every repo with a train, and the project it belongs to. */
  repos(): [string, ProjectRef][] {
    return this.records.trains().map((t) => [t.repo, t.projectRef]);
  }

  private refuse(projectRef: ProjectRef, prUrl: string, refusal: Refusal, row?: Change): TrainError {
    if (row) {
      const at = this.nowIso();
      this.records.create({ ...row, state: "refused", lastError: errorText(`${refusal.message} Fix: ${refusal.fix}`), createdAt: at, updatedAt: at });
    }
    this.emit(projectRef, "change.refused", `Refused ${prUrl}: ${refusal.message}`, { prUrl, fix: refusal.fix });
    return err("invalid", `The train refused ${prUrl}: ${refusal.message}`, refusal.fix);
  }

  /** Validates the PR and puts it on its repo's train; the same open PR returns its Change. Throws a TrainError. */
  enqueue(projectRef: ProjectRef, input: EnqueueCall): Promise<Change> {
    return this.enqueueFrom(projectRef, input, false);
  }

  /** `enqueue`, for a task's result when `result`: a PR that already merged is a quiet `MERGED` error. */
  private async enqueueFrom(projectRef: ProjectRef, input: EnqueueCall, result: boolean): Promise<Change> {
    const parsed = parsePrUrl(input.prUrl);
    if (!parsed) throw err("invalid", `${input.prUrl} is not a github.com pull request URL.`, "Pass https://github.com/<owner>/<name>/pull/<n>.");
    const repo = parsed.repo.toLowerCase();
    const prNumber = parsed.number;
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const repos = this.host.githubRepos(projectRef);
    // Only a project with several repos is held to them.
    if (repos.length >= 2 && !repos.some(([r]) => r === repo)) {
      throw this.refuse(projectRef, prUrl, {
        message: `${repo} is not one of this project's repos (${repos.map(([r]) => r).join(", ")}).`,
        fix: "enqueue a PR of one of its repos, or have a person add the repo to the project",
      });
    }
    const after = next.upstreams(input.after ?? []);
    if (after.includes(prUrl)) throw this.refuse(projectRef, prUrl, { message: "It names itself in `after`.", fix: "drop it from `after`" });
    const unseen = after.find((u) => !next.seesPr(this, projectRef, u));
    if (unseen !== undefined) {
      throw this.refuse(projectRef, prUrl, {
        message: `You can't hold on a PR of a project you can't see, and ${unseen} is one.`,
        fix: `drop ${unseen} from \`after\`; that project's own lead orders its PRs`,
      });
    }
    // One enqueue with `after` at a time, from the loop check until its Change records them.
    const releaseOrder = after.length === 0 ? undefined : await this.afterLock.lock();
    try {
      const upstream = next.loopsBack(this, prUrl, after);
      if (upstream !== undefined) {
        throw this.refuse(projectRef, prUrl, { message: `${upstream} already waits on it, so neither could merge.`, fix: `drop ${upstream} from \`after\`` });
      }
      const task = input.taskId !== undefined ? this.host.task(input.taskId) : undefined;
      if (input.taskId !== undefined && !(task && sameRef(task.projectRef, projectRef))) {
        throw err("not_found", `No task ${input.taskId} in this project.`, "Call `agents`.");
      }
      const releasePr = await this.enqueueLocks.of(`${repo}#${prNumber}`).lock();
      let held = true;
      try {
        const existing0 = this.records.openFor(repo, prNumber);
        if (existing0) {
          // Another project's Change is its lead's alone.
          if (!sameRef(existing0.projectRef, projectRef)) {
            throw err("invalid", `${prUrl} is already on the merge train for another project.`, "leave it to that project's lead; enqueue a PR of your own project's work");
          }
          if (HEAD_STATES.includes(existing0.state) && after.some((u) => !(existing0.after ?? []).includes(u))) {
            releasePr();
            held = false;
            throw this.refuse(projectRef, prUrl, {
              message: "It is already being merged (rebasing, in CI or merging), so it can't wait on another PR now.",
              fix: "to keep it from landing first, add the `hold` label to it, and remove the label once the other PR merges",
            });
          }
          const existing = next.addAfter(this, existing0, after);
          // Enqueued again while its review's findings block it: the lead resolved them without a new patch.
          if (!result && existing.state === "reviewing" && (await this.gate.resolved(existing))) {
            this.note(existing.changeId, RESOLVED);
            this.records.endWait(existing.changeId, WAIT_BLOCKED);
          }
          this.kick(repo);
          return this.one(this.records.get(existing.changeId) ?? existing);
        }
        const workstreamId = input.workstreamId ?? task?.workstreamId;
        if (workstreamId === undefined) {
          throw this.refuse(projectRef, prUrl, { message: "It names no workstream.", fix: "pass taskId T<n> (the write task that opened it) or workstreamId W<n>" });
        }
        const ws = this.host.workstream(workstreamId);
        if (!ws || !sameRef(ws.projectRef, projectRef)) {
          throw err("not_found", `No workstream ${workstreamId} in this project.`, "Use a workstream id from your digest.");
        }
        if (!ws.hasBrief) {
          throw this.refuse(projectRef, prUrl, { message: `${workstreamId} has no brief yet.`, fix: `register its brief with \`brief\` for ${workstreamId} first` });
        }
        let pull: Pull;
        try {
          pull = await this.github.pull(repo, prNumber);
        } catch (error) {
          if (error instanceof GhError && error.kind === "unavailable") {
            // Nothing is wrong with the PR: its repo's next pass reads it again, or the caller does.
            const again = this.records.train(repo) !== undefined;
            if (again) this.unread.set(prUrl, [projectRef, input, result]);
            throw err(
              "unavailable",
              `GitHub was unavailable for ${prUrl} through ${READ_TRIES} reads: ${error.message}. Nothing is wrong with the PR.`,
              again ? "nothing: the train reads it again on its next pass" : "enqueue it again in a minute",
            );
          }
          throw err("invalid", `Could not read ${prUrl} from GitHub: ${ghMessage(error)}`, "Check the URL; the hub reads PRs with its own `gh` login.");
        }
        this.guardBase(repo, pull.base.ref);
        const now = this.nowIso();
        const row: Change = {
          changeId: "X0",
          projectRef,
          repo,
          prNumber,
          prUrl,
          branch: pull.head.ref,
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          workstreamId,
          headSha: pull.head.sha.toLowerCase(),
          state: "queued",
          reviews: [],
          ...(after.length > 0 ? { after } : {}),
          createdAt: now,
          updatedAt: now,
        };
        if (pull.merged && result) throw err(MERGED, `${prUrl} is already merged.`);
        if (pull.merged || pull.state !== "open") {
          throw this.refuse(projectRef, prUrl, { message: `It is ${pull.merged ? "already merged" : pull.state}.`, fix: "enqueue an open PR" }, row);
        }
        if (pull.head.repo?.full_name.toLowerCase() !== repo) {
          throw this.refuse(projectRef, prUrl, { message: "Its branch lives in another repository.", fix: `push the branch to ${repo} and open the PR from there` }, row);
        }
        this.records.ensureTrain(repo, projectRef, this.nowMs());
        this.trainProject(repo, projectRef);
        const at = this.nowIso();
        const change = this.records.create({ ...row, state: "queued", createdAt: at, updatedAt: at });
        // The row exists: a racing enqueue of this PR now finds it.
        releasePr();
        held = false;
        this.stateSpan(undefined, change);
        this.emit(projectRef, "change.queued", `${change.changeId} queued: ${repo}#${change.prNumber}`, {
          changeId: change.changeId,
          workstreamId: change.workstreamId,
          repo,
          prNumber: change.prNumber,
        });
        if (pull.draft) this.holdDraft(change);
        else {
          try {
            await this.admit(change, pull);
          } catch (error) {
            if (!(error instanceof GhError)) throw error;
            const why = errorText(`GitHub: ${error.message}`);
            this.update(change.changeId, ["queued"], (c) => ({ ...c, lastError: why }));
          }
        }
        this.ensureLoop(repo);
        this.kick(repo);
        return this.one(this.records.get(change.changeId)!);
      } finally {
        if (held) releasePr();
      }
    } finally {
      releaseOrder?.();
    }
  }

  /** A clean review is bound to the Change's current patch id; it may be taken. For the review gate. */
  markReady(changeId: string, reviews: ChangeReview[]): Change {
    const change = this.records.get(changeId);
    if (!change) throw err("not_found", `No change ${changeId}.`);
    if (change.state !== "reviewing") throw err("invalid", `${changeId} is ${change.state}, not reviewing.`);
    const stale = reviews.filter((r) => r.patchId !== change.patchId);
    if (stale.length > 0) {
      const at = change.patchId !== undefined ? short(change.patchId) : "(unread)";
      throw err("invalid", `${stale.map((r) => r.taskId).join(", ")} reviewed patch ${short(stale[0]!.patchId)}, but ${changeId} is at patch ${at}.`, "Review the current head.");
    }
    const ready = this.setReady(change, reviews);
    if (!ready) throw err("invalid", `${changeId} changed state while it was marked ready; read it again.`);
    return this.one(ready);
  }

  private async onTaskCompleted(data: unknown): Promise<void> {
    const taskId = (data as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId === "string") await this.onTaskPr(taskId);
  }

  /** A write task whose result names its PR puts it on the train (M7 auto-enqueue). */
  async onTaskPr(taskId: string): Promise<void> {
    const task = this.host.task(taskId);
    if (!task || task.kind !== "write") return;
    this.writerOpenedPr(task.projectRef);
    const prUrl = task.prUrl;
    if (prUrl === undefined || !parsePrUrl(prUrl)) return;
    try {
      await this.enqueueFrom(task.projectRef, { taskId: task.taskId, prUrl }, true);
    } catch (error) {
      const e = error as TrainError;
      if (e.code === MERGED) return;
      await this.wakeLead(task.projectRef, prRefused(prUrl, task.taskId, e.message, e.fix));
    }
  }

  get(changeId: string): Change | undefined {
    const c = this.records.get(changeId);
    return c ? this.one(c) : undefined;
  }

  /** Newest first. */
  list(filter: ListFilter): Change[] {
    return this.records.positioned(this.records.list(filter));
  }

  state(repo: string) {
    return this.records.trainState(repo);
  }

  /** Sets the Change's `lastError` and nothing else. */
  note(changeId: string, text: string): void {
    this.records.note(changeId, text);
  }
}

/** `change_enqueue`'s call (contracts `ChangeEnqueueCall`). */
export type EnqueueCall = { taskId?: string; prUrl: string; workstreamId?: string; after?: string[] };

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;
const sameReview = (a: ChangeReview, b: ChangeReview) =>
  a.taskId === b.taskId && a.prHeadSha === b.prHeadSha && a.patchId === b.patchId && a.blocking === b.blocking && a.nonBlocking === b.nonBlocking;

/** The order's Changes that are neither merged nor being rebased, checked or merged now. */
export function leftovers(changes: Change[], workstreamId: string): Change[] {
  return changes.filter((c) => c.workstreamId === workstreamId && leavesTheTrain(c.state));
}

/** Not merged, and not already on its way in (rebasing, in CI or merging): a Change its order or project going takes off the train. */
const leavesTheTrain = (state: ChangeState) => ["queued", "reviewing", "ready", "needs_rebase", "ci_failed"].includes(state);

/** The host's `projectRemoved`, else a project with no checkout left. */
const projectRemoved = (host: TrainHost, r: ProjectRef) => (host.projectRemoved ? host.projectRemoved(r) : host.projectRoot(r) === undefined);

const changeLane = (c: Change) => `change:${c.repo}#${c.prNumber}`;
const changeIds = (c: Change) => ({
  machineId: c.projectRef.machineId,
  projectId: c.projectRef.projectId,
  workstreamId: c.workstreamId,
  ...(c.taskId !== undefined ? { taskId: c.taskId } : {}),
});

/** The one message that sends a PR back to its author: what is wrong, a review's findings if any. */
export function fixYourPr(set: PromptSetLike, change: Change, problem: string, findings: string): string {
  const f = findings.trim() === "" ? "" : `\n\n${findings.trim()}\n`;
  return set.render("pr.fix", { pr: `${change.prUrl} (${change.changeId})`, problem, findings: f, branch: change.branch });
}

/** A writer's ready PR (a slice): it goes on the train now, as its task's. */
export async function sliceReady(train: Train, projectRef: ProjectRef, taskId: string, prUrl: string): Promise<Change> {
  const writer = train.host.task(taskId);
  if (!writer || !sameRef(writer.projectRef, projectRef) || writer.kind !== "write") {
    throw err("invalid", `${taskId} is not a write task, and only a writer's PR is a slice.`);
  }
  return train.enqueue(projectRef, { taskId, prUrl });
}

export { GhError, isHeld };
