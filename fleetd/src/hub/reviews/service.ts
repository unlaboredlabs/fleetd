// The merge train's review gate. Each time a Change enters `reviewing` the
// train hands it over with its current patch id; the gate spawns one fresh blocker-only reviewer for that patch through
// Tasks and answers pending, or ready when a clean verdict is already bound to it. Every verdict is bound to the patch
// id of the head it reviewed, and only verdicts bound to the Change's current patch id count. Blocking findings go back
// to the author task and the Change waits for a new head.
//
// A reviewer that ends without a recorded verdict never counts as approval. One whose turn ended is first asked once,
// in its own thread, to finish and report; when that turn ends without a verdict too, a new reviewer starts, `RETRIES`
// times per patch, then no more until a new head. A reviewer still on an older patch when the Change moves on is
// stopped, and what it reports later is ignored.
//
// A new patch after an approved head is re-reviewed by what changed (`classify`): a clean rebase carries the approval
// over, a conflict resolution gets a short review of those files, anything else a full review. A reviewer whose
// fleetd tools failed is not counted against `RETRIES`: a new one starts after a doubling wait, or at once after any
// review records a verdict. The lead resolving blocking findings without a new patch enqueues the Change again: those
// findings count no more (`resolved`), and a fresh full review of the same patch starts.
//
// People's reviews on GitHub (people.ts) hold a Change as blocking findings do: a clean patch is ready only once a read
// at most `FRESH_MS` old shows none of theirs open. Each new one goes to the author task as review findings, and one that
// opens while the Change is in the train sends it back to review. The hold lifts when GitHub says it is answered: the
// person approved, re-reviewed or dismissed their review, or resolved their threads. Each verdict is also posted on the
// PR (post.ts).
import type { Database } from "bun:sqlite";
import type { Change, ChangeReview } from "../../shared/contracts.ts";
import { prNote, prReviewNotRecorded, prReviewStalled } from "../train/events.ts";
import type { TrainGitHub } from "../train/github.ts";
import type { EventView, TrainHost } from "../train/host.ts";
import { Mutex } from "../train/mutex.ts";
import { short } from "../train/rules.ts";
import { reviewed } from "../train/batch.ts";
import { fixYourPr, type ReviewGate, type Train, type Verdict } from "../train/service.ts";
import { findingsText, FRESH_MS, holdWhy, PEOPLE_HOLD, People, type PersonFinding, POLL_MS, WATCHED } from "./people.ts";
import { postVerdict } from "./post.ts";
import { compare, type Rebase } from "./rebase.ts";
import {
  type BoundReview,
  conflictsPrompt,
  findingsMessage,
  gate,
  type Gate,
  oneLine,
  reviewPrompt,
  reviewTitle,
  TOOLS_FAILED,
  toolsFailed,
  unreportedMessage,
} from "./rules.ts";

/** Recorded as the spawner of review tasks and the sender of findings. */
export const REVIEWS_BY = "hub:reviews";
/** The start of a Change's `lastError` while blocking findings on its patch hold it in review until a new head. */
export const BLOCKED = "waiting for a new head: ";

const RETRIES = 1;
const TOOLS_RETRIES = 6;
const TOOLS_RETRY_FIRST_MS = 60_000;
const TOOLS_RETRY_MAX_MS = 15 * 60_000;
const LANDED_MAX = 100;

export const FOLLOWED = ["review.verdict", "task.completed", "task.failed", "task.cancelled"];

/** How a patch after an approved head is re-reviewed, as `review_rebases` records it. */
type Rebased = { fromTask: string; fromHead: string; fromBase: string; base: string; outcome: Rebase };

/** A review task the gate spawned: its Change, the patch its round was for, and whether it counts no more. */
type Round = { changeId: string; patchId: string; ignored: boolean };

const ended = (state: string) => state === "done" || state === "failed" || state === "cancelled";

/** The wait before a new reviewer after the `failed`th whose tools failed. */
function toolsWait(failed: number): number {
  const doublings = Math.min(Math.max(failed - 1, 0), 10);
  return Math.min(TOOLS_RETRY_FIRST_MS * 2 ** doublings, TOOLS_RETRY_MAX_MS);
}

export class Reviews implements ReviewGate {
  private readonly lock = new Mutex();
  /** When each reviewer whose tools failed ended, as this hub saw it. */
  private readonly brokenAt = new Map<string, number>();
  /** When a verdict was last bound, on any Change. */
  private verdictAt = 0;
  /** The patches whose lead heard that their reviewer's tools failed. */
  private readonly toldBroken = new Set<string>();
  private readonly stopped = new AbortController();
  readonly people: People;
  /** The verdicts being posted on their PRs, one after another. */
  private posting: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: TrainHost,
    private readonly train: Train,
  ) {
    this.people = new People(train);
  }

  private get db(): Database {
    return this.train.records.db.conn;
  }

  private note(changeId: string, text: string): void {
    this.train.note(changeId, text);
  }

  stop(): void {
    this.stopped.abort();
  }

  /** Follows verdicts and review tasks ending, from now on. */
  start(): void {
    const from = this.host.eventsHead();
    void (async () => {
      let cursor = from;
      while (!this.stopped.signal.aborted) {
        let page;
        try {
          page = await this.host.eventsWait(cursor, FOLLOWED, 300, this.stopped.signal);
        } catch (error) {
          console.warn("reviews: events not read:", error);
          await this.train.options.sleep(1000);
          continue;
        }
        cursor = page.cursor;
        for (const event of page.events) {
          try {
            await this.handle(event);
          } catch (error) {
            console.warn(`reviews: event ${event.seq} not handled:`, error);
          }
        }
      }
    })();
    void (async () => {
      while (!this.stopped.signal.aborted) {
        try {
          await this.peoplePass();
        } catch (error) {
          console.warn("reviews: people's reviews pass failed:", error);
        }
        await this.train.options.sleep(POLL_MS);
      }
    })();
  }

  /** Reads people's reviews on every train's PRs that are due, and acts on what each read found. */
  async peoplePass(): Promise<void> {
    for (const t of this.train.records.trains()) {
      if (!(await this.people.read(t.repo, FRESH_MS))) continue;
      for (const change of this.train.records.inTrain(t.repo, WATCHED)) {
        await this.lock.run(() => this.afterPeopleRead(change.changeId));
      }
    }
  }

  /**
   * New findings of people's go to the writer; open ones send a reviewed Change in the train back to review (one whose
   * re-review still runs is sent back by the gate, when the train asks it); answered, it is ready.
   */
  private async afterPeopleRead(changeId: string): Promise<void> {
    const change = this.train.records.get(changeId);
    if (!change || !WATCHED.includes(change.state)) return;
    const open = this.people.open(change.prUrl);
    if (open.length > 0 && ["ready", "rebasing", "ci", "merging"].includes(change.state) && reviewed(change)) {
      this.train.toReview(change, `${PEOPLE_HOLD}${holdWhy(open)}`);
    }
    await this.sendPeople(change, open);
    if (open.length === 0 && change.state === "reviewing" && change.lastError?.startsWith(PEOPLE_HOLD)) {
      this.note(change.changeId, "people's reviews on GitHub are answered");
      await this.evaluate(change.changeId);
    }
  }

  /** People's findings on the Change's PR not sent yet go to its author task, as the reviewer's blocking ones do. */
  private async sendPeople(change: Change, open: PersonFinding[]): Promise<void> {
    const fresh = this.people.unsent(change.prUrl, open);
    if (fresh.length === 0) return;
    const why = `${PEOPLE_HOLD}${holdWhy(open)}`;
    const author = change.taskId;
    if (author === undefined) {
      this.people.markSent(change.prUrl, fresh);
      return this.holdNote(change, `${why}; no author task to send them to`);
    }
    const problem = `people reviewed it on GitHub: ${holdWhy(fresh)}`;
    const text = fixYourPr(this.train.prompts.forTask(change.projectRef, author), change, problem, findingsText(change, fresh));
    try {
      await this.host.messageTask(change.projectRef, REVIEWS_BY, author, text);
    } catch (error) {
      return this.holdNote(change, `${why}; sending them to ${author} failed: ${(error as Error).message}`);
    }
    this.people.markSent(change.prUrl, fresh);
    this.holdNote(change, `${why}; sent to ${author}`);
  }

  /**
   * The hold's note on a Change in review, unless the reviewer's blocking findings already say why it waits. Anywhere
   * else its note is the train's own (a failed or timed-out CI, a conflict), which the train reads back.
   */
  private holdNote(change: Change, text: string): void {
    const now = this.train.records.get(change.changeId);
    if (now?.state === "reviewing" && !now.lastError?.startsWith(BLOCKED)) this.note(change.changeId, text);
  }

  /** `v`, a ready verdict, unless people's reviews on GitHub hold the Change: then pending in review, else blocked. */
  private async unlessHeld(change: Change, v: Verdict): Promise<Verdict> {
    await this.people.read(change.repo, FRESH_MS);
    const open = this.people.open(change.prUrl);
    if (open.length === 0) return v;
    await this.sendPeople(change, open);
    const why = `${PEOPLE_HOLD}${holdWhy(open)}`;
    if (!this.train.records.get(change.changeId)?.lastError?.startsWith(why)) this.holdNote(change, why);
    // In review it waits there; in the train, `blocked` sends it back to review rather than holding the line.
    const state = this.train.records.get(change.changeId)?.state ?? change.state;
    return state === "reviewing" ? { kind: "pending" } : { kind: "blocked" };
  }

  /** Whether the review gate spawned this task. */
  isReviewer(taskId: string): boolean {
    return this.roundOf(taskId) !== undefined;
  }

  private roundOf(taskId: string): Round | undefined {
    const row = this.db
      .query<{ change_id: string; patch_id: string; role: string }, [string]>("SELECT change_id, patch_id, role FROM review_tasks WHERE task_id = ?1")
      .get(taskId);
    return row ? { changeId: row.change_id, patchId: row.patch_id, ignored: row.role === "superseded" || row.role === "resolved" } : undefined;
  }

  /** The reviewers spawned for this patch of the Change, oldest first. */
  private reviewers(changeId: string, patchId: string): string[] {
    return this.db
      .query<{ task_id: string }, [string, string]>(
        "SELECT task_id FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2 AND role = 'reviewer' ORDER BY rowid",
      )
      .all(changeId, patchId)
      .map((r) => r.task_id);
  }

  /** This patch's reviewers that ended or still work, oldest first, each with whether its tools failed it. */
  private rounds(changeId: string, patchId: string): [string, boolean][] {
    return this.db
      .query<{ task_id: string; role: string }, [string, string]>(
        `SELECT task_id, role FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2
           AND role IN ('reviewer', 'tools_failed') ORDER BY rowid`,
      )
      .all(changeId, patchId)
      .map((r) => [r.task_id, r.role === "tools_failed"]);
  }

  private nowMs(): number {
    return this.train.nowMs();
  }

  /** Not ended, or not known now: an unread task is never taken for a dead one. */
  private live(taskId: string): boolean {
    const t = this.host.task(taskId);
    return t === undefined || !ended(t.state);
  }

  private putPatch(changeId: string, sha: string, patchId: string): void {
    this.db.query("INSERT OR REPLACE INTO review_patch_ids (change_id, head_sha, patch_id) VALUES (?1, ?2, ?3)").run(changeId, sha, patchId);
  }

  /** The patch id of `sha`: known from the train for heads it handed over, else computed as the train computes it. */
  private async patchFor(change: Change, sha: string): Promise<string> {
    const known = this.db
      .query<{ patch_id: string }, [string, string]>("SELECT patch_id FROM review_patch_ids WHERE change_id = ?1 AND head_sha = ?2")
      .get(change.changeId, sha);
    if (known) return known.patch_id;
    const pull = await this.train.github.pull(change.repo, change.prNumber);
    const patchId = await this.train.github.patchId(change.repo, pull.base.ref, sha);
    this.putPatch(change.changeId, sha, patchId);
    return patchId;
  }

  /** Whether the lead resolved findings on this patch of the Change. */
  private resolvedOn(changeId: string, patchId: string): boolean {
    return (
      this.db.query("SELECT 1 FROM review_tasks WHERE change_id = ?1 AND patch_id = ?2 AND role = 'resolved' LIMIT 1").get(changeId, patchId) !== null
    );
  }

  /** `ReviewGate.resolved`: the findings holding the patch count no more, and a new reviewer starts a full review. */
  async resolved(change: Change): Promise<boolean> {
    return this.lock.run(async () => {
      const patchId = change.patchId;
      if (patchId === undefined || !this.gateFor(change, patchId)[0].waitingForHead) return false;
      this.db
        .query(
          `UPDATE review_tasks SET role = 'resolved' WHERE change_id = ?1 AND (
             (patch_id = ?2 AND role IN ('reviewer', 'tools_failed'))
             OR task_id IN (SELECT task_id FROM review_bindings WHERE patch_id = ?2 AND blocking > 0))`,
        )
        .run(change.changeId, patchId);
      await this.spawnReviewer(change, patchId);
      return true;
    });
  }

  /** The verdicts bound to `patchId`, as the gate and `markReady` take them. */
  private gateFor(change: Change, patchId: string): [Gate, ChangeReview[]] {
    const rows = this.db
      .query<{ task_id: string; pr_head_sha: string; blocking: number; non_blocking: number }, [string, string]>(
        `SELECT b.task_id, b.pr_head_sha, b.blocking, b.non_blocking
           FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id
           WHERE t.change_id = ?1 AND b.patch_id = ?2 AND t.role != 'resolved'`,
      )
      .all(change.changeId, patchId);
    const bound: BoundReview[] = rows.map((r) => ({ taskId: r.task_id, patchId, blocking: r.blocking }));
    const reviews: ChangeReview[] = rows.map((r) => ({ taskId: r.task_id, prHeadSha: r.pr_head_sha, patchId, blocking: r.blocking, nonBlocking: r.non_blocking }));
    return [gate(patchId, bound), reviews];
  }

  /** Spawns a reviewer for this patch; the task id when it started. One the node refused to start is not counted. */
  private async spawnReviewer(change: Change, patchId: string): Promise<string | undefined> {
    const reviewedRow = this.db
      .query<{ pr_head_sha: string }, [string, string]>(
        `SELECT b.pr_head_sha FROM review_bindings b JOIN review_tasks t ON t.task_id = b.task_id
           WHERE t.change_id = ?1 AND b.patch_id != ?2 ORDER BY b.rowid DESC LIMIT 1`,
      )
      .get(change.changeId, patchId);
    let prTitle: string | undefined;
    try {
      prTitle = (await this.train.github.pull(change.repo, change.prNumber)).title;
    } catch {
      prTitle = undefined;
    }
    const set = this.train.prompts.current(change.projectRef);
    const resolved = this.resolvedOn(change.changeId, patchId);
    const reviewed = resolved ? undefined : reviewedRow?.pr_head_sha;
    const rebased = resolved ? undefined : this.rebased(change.changeId, patchId);
    const prompt =
      rebased?.outcome.kind === "conflicts"
        ? conflictsPrompt(set, change, { reviewedSha: rebased.fromHead, reviewedBase: rebased.fromBase, base: rebased.base, files: rebased.outcome.files })
        : reviewPrompt(set, change, reviewed);
    let task;
    try {
      task = await this.host.spawnReview({
        projectRef: change.projectRef,
        by: REVIEWS_BY,
        workstreamId: change.workstreamId,
        title: reviewTitle(prTitle, change.prNumber),
        prompt,
        pr: change.prUrl,
      });
    } catch (error) {
      const why = `could not spawn the reviewer: ${(error as Error).message}`;
      // A closed workstream never gets a reviewer: the Change leaves the train and the lead hears why.
      if (this.host.workstream(change.workstreamId)?.open === false) {
        await this.train.abandon(change, `${why} Enqueue it for an open workstream to land it.`);
      } else this.note(change.changeId, why);
      return undefined;
    }
    if (task.state === "failed") {
      this.note(change.changeId, `the reviewer ${task.taskId} failed to start: ${task.resultTail ?? ""}`);
      return undefined;
    }
    this.db
      .query("INSERT OR IGNORE INTO review_tasks (task_id, change_id, role, patch_id) VALUES (?1, ?2, 'reviewer', ?3)")
      .run(task.taskId, change.changeId, patchId);
    return task.taskId;
  }

  /** The Change is at `patchId` now: its reviewers of an older patch that gave no verdict are stopped. */
  private async supersede(change: Change, patchId: string): Promise<void> {
    const stale = this.db
      .query<{ task_id: string }, [string, string]>(
        `SELECT task_id FROM review_tasks t WHERE change_id = ?1 AND patch_id != ?2 AND role = 'reviewer'
           AND NOT EXISTS (SELECT 1 FROM review_bindings b WHERE b.task_id = t.task_id)`,
      )
      .all(change.changeId, patchId)
      .map((r) => r.task_id);
    for (const taskId of stale) {
      this.db.query("UPDATE review_tasks SET role = 'superseded' WHERE task_id = ?1").run(taskId);
      if (!this.live(taskId)) continue;
      const reason = `Superseded: ${change.repo}#${change.prNumber} has a new head ${short(change.headSha)}; its reviewer reviews that.`;
      try {
        await this.host.cancelTask(change.projectRef, REVIEWS_BY, taskId, reason);
      } catch (error) {
        console.warn(`reviews: superseded reviewer ${taskId} of ${change.changeId} not stopped: ${(error as Error).message}`);
      }
    }
  }

  /** How the Change's new patch is re-reviewed against its last reviewed head, when that head is clean. */
  private async classify(change: Change, patchId: string): Promise<Rebased | undefined> {
    const approved = this.db
      .query<{ task_id: string; pr_head_sha: string; patch_id: string }, [string, string]>(
        `SELECT b.task_id, b.pr_head_sha, b.patch_id FROM review_bindings b
           JOIN review_tasks t ON t.task_id = b.task_id
           WHERE t.change_id = ?1 AND b.patch_id != ?2 ORDER BY b.rowid DESC LIMIT 1`,
      )
      .get(change.changeId, patchId);
    if (!approved) return undefined;
    const fromTask = approved.task_id;
    const fromHead = approved.pr_head_sha;
    // Blocking findings open on the last reviewed head: only a full review clears them.
    if (!this.gateFor(change, approved.patch_id)[0].ready) return undefined;
    const github = this.train.github;
    const repo = change.repo;
    const pull = await github.pull(repo, change.prNumber);
    const base = await github.branchSha(repo, pull.base.ref);
    const own = await github.range(repo, base, change.headSha);
    const rev = await github.range(repo, base, fromHead);
    if (!own || !rev || own.commits.length === 0) return undefined;
    const ownBase = own.base;
    const fromBase = rev.base;
    const rebased = (outcome: Rebase): Rebased => ({ fromTask, fromHead, fromBase, base: ownBase, outcome });
    const dropped = rev.commits.slice(0, Math.max(rev.commits.length - own.commits.length, 0));
    if (dropped.length > 0 && !(await onBase(github, repo, base, fromBase, dropped))) return rebased({ kind: "changed" });
    const below = dropped.at(-1) ?? fromBase;
    const approvedDiff = await github.diff(repo, below, fromHead);
    const now = await github.diff(repo, ownBase, change.headSha);
    const moved = await github.diff(repo, fromBase, ownBase);
    let outcome = compare(approvedDiff, now, moved);
    if (outcome.kind === "conflicts" && own.commits.length > rev.commits.length) outcome = { kind: "changed" };
    // With commits dropped, only the same patch id, context and all, is unchanged.
    else if (outcome.kind === "unchanged" && dropped.length > 0 && (await github.patchIdFrom(repo, below, fromHead)) !== patchId) outcome = { kind: "changed" };
    return rebased(outcome);
  }

  /** How `patchId` is re-reviewed, as recorded. */
  private rebased(changeId: string, patchId: string): Rebased | undefined {
    const row = this.db
      .query<{ from_task: string; from_head: string; from_base: string; base: string; outcome: string; files: string }, [string, string]>(
        "SELECT from_task, from_head, from_base, base, outcome, files FROM review_rebases WHERE change_id = ?1 AND patch_id = ?2",
      )
      .get(changeId, patchId);
    if (!row) return undefined;
    const outcome: Rebase =
      row.outcome === "unchanged" ? { kind: "unchanged" } : row.outcome === "conflicts" ? { kind: "conflicts", files: row.files.split("\n").filter(Boolean) } : { kind: "changed" };
    return { fromTask: row.from_task, fromHead: row.from_head, fromBase: row.from_base, base: row.base, outcome };
  }

  /** `classify`, read once per patch and recorded: an unchanged patch is bound the approval it carries. Whether it carried. */
  private async carried(change: Change, patchId: string): Promise<boolean> {
    if (this.rebased(change.changeId, patchId)) return false;
    let r: Rebased | undefined;
    try {
      r = await this.classify(change, patchId);
    } catch (error) {
      console.warn(`reviews: approval not carried to ${change.changeId}; reviewing: ${(error as Error).message}`);
      return false;
    }
    if (!r) return false;
    const files = r.outcome.kind === "conflicts" ? r.outcome.files.join("\n") : "";
    const carried = r.outcome.kind === "unchanged";
    const rr = r;
    this.train.records.db.transaction((c) => {
      c.query(
        `INSERT OR REPLACE INTO review_rebases (change_id, patch_id, head_sha, from_task, from_head, from_base, base, outcome, files)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).run(change.changeId, patchId, change.headSha, rr.fromTask, rr.fromHead, rr.fromBase, rr.base, rr.outcome.kind, files);
      if (carried) {
        c.query(
          `INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking)
             SELECT task_id, ?2, ?3, 0, non_blocking FROM review_bindings WHERE task_id = ?1 AND pr_head_sha = ?4`,
        ).run(rr.fromTask, change.headSha, patchId, rr.fromHead);
      }
    });
    console.info(`reviews: a new patch of ${change.changeId} after ${r.fromTask}'s approved head ${r.fromHead}: ${r.outcome.kind}`);
    return carried;
  }

  async review(change: Change): Promise<Verdict> {
    return this.lock.run(async () => {
      let patchId = change.patchId;
      if (patchId === undefined) {
        try {
          patchId = await this.patchFor(change, change.headSha);
        } catch (error) {
          this.note(change.changeId, `reviews: ${(error as Error).message}`);
          return { kind: "pending" };
        }
      }
      this.putPatch(change.changeId, change.headSha, patchId);
      return this.round(change, patchId);
    });
  }

  /** Where the review of the Change's patch stands, starting what it lacks. Under the gate's lock. */
  private async round(change: Change, patchId: string): Promise<Verdict> {
    await this.supersede(change, patchId);
    const [before, reviews] = this.gateFor(change, patchId);
    if (before.ready) return this.unlessHeld(change, { kind: "ready", reviews });
    if (before.waitingForHead) return { kind: "blocked" };
    const rounds = this.rounds(change.changeId, patchId);
    // One still at work owes the verdict.
    if (rounds.some(([t]) => this.live(t))) return { kind: "pending" };
    const lastRound = rounds.at(-1);
    if (!lastRound) {
      if (!this.resolvedOn(change.changeId, patchId) && (await this.carried(change, patchId))) {
        return this.unlessHeld(change, { kind: "ready", reviews: this.gateFor(change, patchId)[1] });
      }
      await this.spawnReviewer(change, patchId);
      return { kind: "pending" };
    }
    if (lastRound[1]) {
      const failed = rounds.filter(([, b]) => b).length;
      await this.afterBroken(change, patchId, lastRound[0], failed);
      return { kind: "pending" };
    }
    const reviewers = rounds.filter(([, b]) => !b).map(([t]) => t);
    const last = reviewers.at(-1) ?? lastRound[0];
    const tries = reviewers.length;
    if (await this.nudge(change, last)) return { kind: "pending" };
    if (tries > RETRIES) await this.stalled(change, patchId, last, tries);
    else {
      const next = await this.spawnReviewer(change, patchId);
      if (next !== undefined) {
        const tail = this.finalText(last);
        this.note(
          change.changeId,
          `verdict not recorded: the reviewer ${last} ended without one, saying "${oneLine(tail, 200)}"; ${next} reviews it again (retry ${tries} of ${RETRIES})`,
        );
        await this.host.wakeLead(change.projectRef, prReviewNotRecorded(change.changeId, change.prUrl, last, next, tail));
      }
    }
    return { kind: "pending" };
  }

  /** Asks `last`, a reviewer whose turn ended without a verdict, once in its own thread to finish and report. */
  private async nudge(change: Change, last: string): Promise<boolean> {
    if (this.host.task(last)?.state !== "done") return false;
    const first = this.db.query("UPDATE review_tasks SET nudged = 1 WHERE task_id = ?1 AND nudged = 0").run(last).changes === 1;
    if (!first) return false;
    const text = unreportedMessage(this.train.prompts.forTask(change.projectRef, last), change, change.headSha);
    try {
      await this.host.messageTask(change.projectRef, REVIEWS_BY, last, text);
    } catch (error) {
      this.note(change.changeId, `verdict not recorded: asking the reviewer ${last} to finish failed: ${(error as Error).message}`);
      return false;
    }
    this.note(
      change.changeId,
      `verdict not recorded: the reviewer ${last} ended without one, saying "${oneLine(this.finalText(last), 200)}"; asked it once to finish and report`,
    );
    return true;
  }

  /** The patch's last reviewer couldn't use fleetd's tools: a new one starts once its wait is over or a verdict came. */
  private async afterBroken(change: Change, patchId: string, last: string, failed: number): Promise<void> {
    const endedAt = this.brokenAt.get(last) ?? 0;
    const fixed = this.verdictAt > endedAt;
    const due = fixed || (failed < TOOLS_RETRIES && this.nowMs() - endedAt >= toolsWait(failed));
    if (!due) {
      if (failed >= TOOLS_RETRIES) await this.toolsStalled(change, patchId, last, failed);
      return;
    }
    const next = await this.spawnReviewer(change, patchId);
    if (next !== undefined) {
      const why = fixed ? "another review recorded a verdict since, so the tools work again" : "its wait is over";
      this.note(change.changeId, `${TOOLS_FAILED} for ${last}; ${why}: ${next} reviews it now`);
    }
  }

  /** `failed` reviewers in a row couldn't use fleetd's tools: the lead hears once, across restarts. */
  private async toolsStalled(change: Change, patchId: string, last: string, failed: number): Promise<void> {
    if (this.db.query("INSERT OR IGNORE INTO review_stalls (change_id, patch_id) VALUES (?1, ?2)").run(change.changeId, patchId).changes !== 1) return;
    this.note(
      change.changeId,
      `${TOOLS_FAILED}: ${failed} reviewers in a row, the last ${last}, couldn't use fleetd's tools; the next starts as soon as any review records a verdict; the lead was told`,
    );
    const text = `${failed} reviewers in a row, the last ${last}, couldn't use fleetd's tools to record a verdict ("${oneLine(this.finalText(last), 200)}"); the next starts as soon as any review records one`;
    await this.host.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
  }

  /** The reviewer's final text, which may well say it approved: only a recorded verdict counts. */
  private finalText(task: string): string {
    return this.host.task(task)?.resultTail ?? "";
  }

  /** The lead hears once, across restarts, that the patch's reviewers keep ending without a verdict. */
  private async stalled(change: Change, patchId: string, last: string, tries: number): Promise<void> {
    if (this.db.query("INSERT OR IGNORE INTO review_stalls (change_id, patch_id) VALUES (?1, ?2)").run(change.changeId, patchId).changes !== 1) return;
    this.note(
      change.changeId,
      `verdict not recorded: the reviewer ${last} ended without one; ${tries} reviewers of patch ${short(patchId)} did, so no more start until a new head; the lead was told`,
    );
    await this.host.wakeLead(change.projectRef, prReviewStalled(change.changeId, change.prUrl, last, tries, this.finalText(last)));
  }

  /** The train's pass over a Change still in reviewing at the same head. */
  async again(change: Change): Promise<Verdict> {
    return this.lock.run(async () => (change.patchId === undefined ? { kind: "pending" } : this.round(change, change.patchId)));
  }

  /** Marks the Change ready once its current patch has a clean review and people's reviews hold it no more. */
  private async evaluate(changeId: string): Promise<void> {
    const change = this.train.records.get(changeId);
    if (!change || change.state !== "reviewing" || change.patchId === undefined) return;
    const [g, reviews] = this.gateFor(change, change.patchId);
    if (!g.ready || (await this.unlessHeld(change, { kind: "ready", reviews })).kind !== "ready") return;
    try {
      this.train.markReady(changeId, reviews);
    } catch (error) {
      console.warn(`reviews: mark ready of ${changeId} refused: ${(error as { message?: string }).message}`);
    }
  }

  private async onVerdict(data: Record<string, unknown>): Promise<void> {
    const taskId = typeof data.taskId === "string" ? data.taskId : "";
    // A reviewer of a patch the Change has moved past was stopped; what it says counts for nothing.
    const round = this.roundOf(taskId);
    if (!round || round.ignored) return;
    const change = this.train.records.get(round.changeId);
    if (!change) return;
    const sha = typeof data.prHeadSha === "string" ? data.prHeadSha : "";
    const blocking = typeof data.blocking === "number" ? data.blocking : 0;
    const nonBlocking = typeof data.nonBlocking === "number" ? data.nonBlocking : 0;
    let patchId = await this.patchFor(change, sha);
    // The heads its approval carried to hold its findings too: a carry never clears a blocking finding.
    const carriedTo = this.train.records.db.transaction((c) => {
      c.query("INSERT OR REPLACE INTO review_bindings (task_id, pr_head_sha, patch_id, blocking, non_blocking) VALUES (?1, ?2, ?3, ?4, ?5)").run(
        taskId,
        sha,
        patchId,
        blocking,
        nonBlocking,
      );
      c.query(
        `UPDATE review_bindings SET blocking = ?2, non_blocking = ?3 WHERE task_id = ?1 AND pr_head_sha IN
           (SELECT head_sha FROM review_rebases WHERE from_task = ?1 AND outcome = 'unchanged')`,
      ).run(taskId, blocking, nonBlocking);
      return c
        .query<{ patch_id: string }, [string, string, string]>(
          `SELECT patch_id FROM review_rebases WHERE change_id = ?1 AND from_task = ?2 AND outcome = 'unchanged' AND patch_id = ?3`,
        )
        .get(round.changeId, taskId, change.patchId ?? "")?.patch_id;
    });
    this.verdictAt = this.nowMs();
    this.train.reviewRecorded();
    // Findings on an older patch were already overtaken by a new head, unless its approval carried to this one.
    patchId = carriedTo ?? patchId;
    if (change.patchId === patchId || change.headSha === sha) this.post(change, taskId, sha, blocking, nonBlocking);
    // Sent back mid-review, the Change keeps no patch, but its writer is at work on that very head: they go to it.
    const parked = change.state === "needs_rebase" && change.patchId === undefined && change.headSha === sha;
    if (blocking > 0 && (parked || change.patchId === patchId)) {
      const summary = this.findingsOn(change, patchId, taskId, sha);
      const waiting = `${BLOCKED}${taskId} found ${blocking} blocking at ${short(sha)}`;
      // A parked Change keeps why it was sent back: the log has it instead.
      const note = (text: string) => (parked ? console.warn(`reviews: findings on parked ${change.changeId}: ${text}`) : this.note(change.changeId, text));
      const author = change.taskId;
      if (author === undefined) return note(`${waiting}; no author task to send them to: ${summary}`);
      if (!parked) this.note(change.changeId, `${waiting}; sent to ${author}`);
      const text = findingsMessage(this.train.prompts.forTask(change.projectRef, author), change, {
        taskId,
        prHeadSha: sha,
        blocking,
        nonBlocking,
        summary: `${summary}\n\n\`review_read\` reads these findings again, whole.`,
      });
      try {
        await this.host.messageTask(change.projectRef, REVIEWS_BY, author, text);
      } catch (error) {
        note(`${waiting}; sending them to ${author} failed: ${(error as Error).message}`);
      }
      return;
    }
    await this.evaluate(round.changeId);
  }

  /** Posts the verdict on the PR, after the ones before it; a refusal is logged and holds nothing. */
  private post(change: Change, taskId: string, sha: string, blocking: number, nonBlocking: number): void {
    const summary = this.summaryOf(taskId, sha);
    this.posting = this.posting.then(async () => {
      try {
        await postVerdict(this.train.github, this.db, change, { sha, blocking, nonBlocking, summary });
      } catch (error) {
        console.warn(`reviews: ${taskId}'s verdict not posted on ${change.prUrl}: ${(error as Error).message}`);
      }
    });
  }

  /** Every verdict posted so far is on its PR, or was refused. */
  posted(): Promise<void> {
    return this.posting;
  }

  /** What `taskId` recorded at `sha`, whole. */
  private summaryOf(taskId: string, sha: string): string {
    const row = this.db
      .query<{ data: string }, [string, string]>("SELECT data FROM review_verdicts WHERE task_id = ?1 AND sha = ?2 ORDER BY n DESC LIMIT 1")
      .get(taskId, sha);
    try {
      const v = row ? (JSON.parse(row.data) as { summary?: unknown }) : undefined;
      if (typeof v?.summary === "string") return v.summary;
    } catch {}
    return "(the verdict had no summary)";
  }

  /** Every finding on the patch, `taskId`'s at `sha` first, then each other review bound to it. */
  private findingsOn(change: Change, patchId: string, taskId: string, sha: string): string {
    const [, reviews] = this.gateFor(change, patchId);
    const parts = [this.summaryOf(taskId, sha)];
    for (const r of reviews.filter((r) => r.taskId !== taskId)) {
      parts.push(`${r.taskId} (${r.blocking} blocking, ${r.nonBlocking} non-blocking):\n${this.summaryOf(r.taskId, r.prHeadSha)}`);
    }
    return parts.join("\n\n");
  }

  /** A review task ended, perhaps without the verdict it owed: then the current patch gets a new reviewer. */
  private async onTaskEnded(event: EventView): Promise<void> {
    const taskId = typeof (event.data as { taskId?: unknown })?.taskId === "string" ? (event.data as { taskId: string }).taskId : "";
    const round = this.roundOf(taskId);
    if (!round) return;
    const bound = this.db.query("SELECT 1 FROM review_bindings WHERE task_id = ?1 LIMIT 1").get(taskId) !== null;
    await this.evaluate(round.changeId);
    if (bound || round.ignored) return;
    const how = event.eventType.startsWith("task.") ? event.eventType.slice(5) : event.eventType;
    const tail = this.finalText(taskId);
    const broken = toolsFailed(tail);
    if (broken) {
      this.db.query("UPDATE review_tasks SET role = 'tools_failed' WHERE task_id = ?1").run(taskId);
      this.brokenAt.set(taskId, this.nowMs());
      const failed = this.rounds(round.changeId, round.patchId).filter(([, b]) => b).length;
      this.note(
        round.changeId,
        `${TOOLS_FAILED}: the reviewer ${taskId} couldn't use fleetd's tools to record its verdict, saying "${oneLine(tail, 200)}"; a new reviewer starts within ${Math.ceil(toolsWait(failed) / 60_000)} min, or as soon as another review records a verdict`,
      );
    } else this.note(round.changeId, `verdict not recorded: the reviewer ${taskId} ended (${how}) without one`);
    // The Change still waits on this patch's review: in review, or in the train with its re-review alongside CI.
    const change = this.train.records.get(round.changeId);
    if (!change || !["reviewing", "rebasing", "ci", "merging"].includes(change.state) || change.patchId !== round.patchId) return;
    const key = `${round.changeId}\u0000${round.patchId}`;
    if (broken && !this.toldBroken.has(key)) {
      this.toldBroken.add(key);
      const text = `its reviewer ${taskId} couldn't use fleetd's tools to record a verdict ("${oneLine(tail, 200)}"); fleetd starts a new one by itself, and once the tools work it reviews again at once`;
      await this.host.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
    }
    if ((await this.round(change, round.patchId)).kind === "ready") await this.evaluate(round.changeId);
  }

  async handle(event: EventView): Promise<void> {
    await this.lock.run(async () => {
      if (event.eventType === "review.verdict") {
        try {
          await this.onVerdict((event.data ?? {}) as Record<string, unknown>);
        } catch (error) {
          console.warn(`reviews: verdict ${event.seq} not bound: ${(error as Error).message}`);
        }
      } else await this.onTaskEnded(event);
    });
  }

  rereview(change: Change): boolean {
    const patchId = change.patchId;
    if (patchId === undefined) return false;
    return !this.gateFor(change, patchId)[0].waitingForHead && this.reviewers(change.changeId, patchId).some((t) => this.live(t));
  }
}

/**
 * Whether the approved head's commits `dropped`, below the PR's own, are on `base` already: the last is an ancestor
 * of it, or `base` gained since `from` one commit with their patch, or a commit with each one's patch.
 */
async function onBase(github: TrainGitHub, repo: string, base: string, from: string, dropped: string[]): Promise<boolean> {
  const last = dropped.at(-1);
  if (last === undefined) return true;
  const missing = await github.range(repo, base, last);
  if (missing && missing.commits.length === 0) return true;
  const landed = await github.range(repo, from, base);
  if (!landed || landed.commits.length === 0 || landed.commits.length > LANDED_MAX) return false;
  const patches = new Set<string>();
  for (const sha of landed.commits) {
    // A commit with no diff of its own lands nothing.
    try {
      patches.add(await github.commitPatchId(repo, sha));
    } catch {}
  }
  if (patches.has(await github.patchIdFrom(repo, from, last))) return true;
  for (const sha of dropped) if (!patches.has(await github.commitPatchId(repo, sha))) return false;
  return true;
}

/** The train with its review gate: the gate holds the train, so it can mark Changes ready. */
export function withReviews(train: Train, host: TrainHost): Reviews {
  const reviews = new Reviews(host, train);
  train.gate = reviews;
  return reviews;
}
