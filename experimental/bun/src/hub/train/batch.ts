// Batches (crates/fleetd/src/hub/train/batch.rs): two or more ready Changes into one base, each reviewed for its
// current patch and green on its own head by its fast set and by the checks the batch's CI skips, up to `BATCH_MAX`
// in queue order, merged together after one CI run. The train builds the batch on GitHub: its scratch branch at the
// base, each member's head merged into it in order, and one PR for it. Green, the train posts `fleetd/train` on that
// head and squash-merges the batch PR pinned to it; each member is then closed with a link. Red, timed out or refused,
// every member goes alone. The next pass's sweep deletes the scratch branch, which closes a batch PR left open.
import type { Change, ChangeState } from "../../shared/contracts.ts";
import { BATCH_MARKER, batchHeads, type CheckRun, type CommitStatus, GhError, held, labelled, NEXT_LABEL, type Pull } from "./github.ts";
import * as next from "./next.ts";
import { DRAFT, errorText } from "./records.ts";
import { conflicted, earlyMigration, REGENERATING } from "./regen.ts";
import { type Fast, isRed, short } from "./rules.ts";
import type { Between, Train } from "./service.ts";
import { watchMerge } from "./watch.ts";

const BATCH_MAX = 8;

const HELD = "held: the PR has the `hold` label; the train takes it once the label is gone";
export const NO_CI =
  "held: this repo has no CI, and fleetd merges only on green CI. Add a GitHub Actions " +
  "workflow that runs on pull requests; it goes on by itself once one exists.";
const MEMBER_LEFT = "a PR left the batch while it formed; the next pass forms it again";
const NOT_CLOSED = "landed, but its PR is not closed yet";
/** The start of a ready Change's `lastError` while the batch forming left it out, followed by why. */
export const LEFT_OUT = "not in this batch: ";
/** The trailer that names a Change on the squash that lands it (contracts `metrics::CHANGE_TRAILER`). */
export const CHANGE_TRAILER = "Fleetd-Change";

const named = (names: string[]) => names.map((n) => `\`${n}\``).join(", ");

/** Why a ready PR's own head keeps it out of a batch, by its fast set and the checks the batch skips; undefined: it may join. */
export function ownChecks(runs: CheckRun[], statuses: CommitStatus[], fast: Fast | undefined, batch: string[]): string | undefined {
  if (runs.length === 0 && statuses.length === 0) return "its own head has no checks yet";
  const cancelled = (r: CheckRun) => r.conclusion === "cancelled";
  const skippedByBatch = (r: CheckRun) => batch.some((n) => next.gatedName(n, r.name));
  const judged =
    fast && fast.set.length > 0
      ? runs.filter((r) => skippedByBatch(r) || (fast.holds(r.name) && !cancelled(r)))
      : fast
        ? runs.filter((r) => skippedByBatch(r) || !cancelled(r))
        : runs;
  const red = judged.filter(isRed).map((r) => r.name);
  const set = fast?.set ?? [];
  const wanted: string[] = [];
  for (const name of [...set, ...batch]) if (!wanted.includes(name) && !runs.some((r) => next.gatedName(name, r.name))) wanted.push(name);
  const missing: string[] = [];
  for (const name of wanted) {
    const state = statuses.find((s) => s.context === name)?.state;
    if (state === "success") continue;
    if (state === "failure" || state === "error") red.push(name);
    else missing.push(name);
  }
  const running = judged.filter((r) => r.status !== "completed").map((r) => r.name);
  if (red.length > 0) return `its own head's ${named(red)} failed`;
  if (running.length > 0) return `its own head's ${named(running)} still running`;
  if (missing.length > 0) return `its own head hasn't reported ${named(missing)} yet`;
  return undefined;
}

/** A clean review is bound to the Change's current patch: nothing else lets the train take it. */
export const reviewed = (c: Change) => c.patchId !== undefined && c.reviews.some((r) => r.blocking === 0 && r.patchId === c.patchId);

/** The batch PR a Change landed in. */
export type Landed = { prNumber: number; mergedSha: string; members: number[] };

/** A ready Change and its PR as this pass read it. */
export type Candidate = { change: Change; pull: Pull };

/** A batch PR in CI, or (`lone`) a PR in CI alone at its rebased head, which batches stack on. */
export type Stage = { pr: number; sha: string; title: string; members: Candidate[]; added: number; lone: boolean };

const own = (s: Stage) => s.members.slice(s.members.length - s.added);
const stageName = (s: Stage) => (s.lone ? `#${s.pr}` : `batch #${s.pr}`);

/** How a batch in CI failed to pass: its CI, or still in CI this long after the one ahead passed. */
type Failed = { kind: "ci"; what: string } | { kind: "late"; waitMs: number };
const failedCi = (f: Failed) => (f.kind === "ci" ? f.what : "ran late");
const failedWhat = (f: Failed) => (f.kind === "ci" ? `didn't pass: its CI ${f.what}` : `was still in CI ${Math.floor(f.waitMs / 1000)} s after the one ahead passed`);

/** Why a batch whose CI passed didn't land. */
type Unlanded =
  | { kind: "members"; ids: string[]; why: string }
  | { kind: "refused"; why: string }
  | { kind: "failed"; why: string }
  | { kind: "unknown"; why: string };

const followerName = (k: number) => `${k}/train/batch`;

/** The scratch branch names under `<prefix>train/` of every batch a train of `depth` may have in CI. */
export function batchNames(depth: number): string[] {
  const out = ["batch"];
  for (let k = 1; k < Math.max(depth, 1); k++) out.push(followerName(k));
  return out;
}

function batchTitle(members: Candidate[]): string {
  const parts = members.map((m) => {
    const t = m.pull.title.trim();
    return t === "" ? `#${m.change.prNumber}` : `${t} (#${m.change.prNumber})`;
  });
  const title = `batch: ${parts.join("; ")}`;
  const chars = [...title];
  return chars.length > 250 ? `${chars.slice(0, 249).join("")}…` : title;
}

const memberLines = (members: Candidate[]) => members.map((m) => `- #${m.change.prNumber} ${m.pull.title.trim()}`).join("\n");

/** The trailer that names a Change on the squash that lands it, `Fleetd-Change: X12 (T45, W9)`. */
export function changeTrailer(c: Change): string {
  return `${CHANGE_TRAILER}: ${c.changeId} (${c.taskId !== undefined ? `${c.taskId}, ` : ""}${c.workstreamId})`;
}

/** A squash message's body with the Changes' trailers last, in its own trailer block when it ends with one. */
export function withTrailers(raw: string, changes: Change[]): string {
  const trailers = changes.map(changeTrailer);
  const body = raw.replaceAll("\r\n", "\n").trim();
  const last = body.split("\n\n").at(-1) ?? "";
  const block =
    last !== "" &&
    last.split("\n").every((l) => {
      const at = l.indexOf(": ");
      if (at < 0) return false;
      const token = l.slice(0, at);
      return token !== "" && l.slice(at + 2).trim() !== "" && /^[A-Za-z0-9-]+$/.test(token);
    });
  if (body === "") return trailers.join("\n");
  return block ? `${body}\n${trailers.join("\n")}` : `${body}\n\n${trailers.join("\n")}`;
}

function batchBody(base: string, members: Candidate[]): string {
  const numbers = members.map((m) => `#${m.change.prNumber}@${m.change.headSha}`);
  return (
    `The fleetd merge train's batch: these ready PRs, each reviewed at its current patch and green on its own, ` +
    `merged onto ${base} in queue order and tested by this PR's one CI run. Once this merges, each is closed ` +
    `with a link here. Red CI sends each through the train alone.\n\n${memberLines(members)}\n\n${BATCH_MARKER} ${numbers.join(" ")}\n`
  );
}

/** `<prefix>train/<name>` in the namespace of the repo's checkout in the train's project; undefined when unreadable. */
export async function scratchBranch(t: Train, change: Change, name: string): Promise<string | undefined> {
  const checkout = t.trainCheckout(change.repo, change.projectRef);
  const prefix = await t.host.branchPrefix(checkout);
  return prefix === undefined ? undefined : `${prefix}train/${name}`;
}

/** `<prefix>train/` of the repo's checkout in the project that owns its train. */
export async function scratchPrefix(t: Train, repo: string): Promise<string | undefined> {
  const owner = t.records.train(repo)?.projectRef;
  if (!owner) return undefined;
  const prefix = await t.host.branchPrefix(t.trainCheckout(repo, owner));
  return prefix === undefined ? undefined : `${prefix}train/`;
}

/**
 * After refresh: a batch of the ready Changes into the first one's base that are green on their own heads, or the
 * first one alone. True when it took or settled one. `fleetd:next` goes on the one taken alone and off every other.
 */
export async function next_(t: Train, repo: string): Promise<boolean> {
  const ready = t.records.inTrain(repo, ["reviewing", "ready"]).filter((c) => c.state === "ready" || rereviewing(t, c));
  const [cands, settled] = await candidates(t, repo, ready);
  next.pruneHeads(t, repo);
  const head = cands[0];
  if (!head) {
    await next.relabel(t, repo, [], []);
    return settled;
  }
  const base = head.pull.base.ref;
  const members: Candidate[] = [];
  const left: [Candidate, string][] = [];
  if (cands.length >= 2) {
    for (const c of cands) {
      const why =
        members.length === BATCH_MAX
          ? `the batch is full (${BATCH_MAX} PRs)`
          : c.pull.base.ref !== base
            ? `it merges into ${c.pull.base.ref}, and this batch into ${base}`
            : await ownCi(t, repo, c.change, base);
      if (why === undefined) members.push(c);
      else left.push([c, why]);
    }
  }
  if (members.length < 2) {
    // Alone: the head goes, and every other PR waits for it.
    const own = left.find(([c]) => c.change.changeId === head.change.changeId);
    const alone = own ? `${head.change.changeId} goes alone first, as ${own[1]}` : `${head.change.changeId} goes alone first: no other ready PR could join it`;
    for (const m of members) left.push([cands.find((c) => c.change.changeId === m.change.changeId) ?? head, alone]);
  }
  const taken = members.length >= 2 ? members : [head];
  for (const c of cands) {
    const why = taken.some((x) => x.change.changeId === c.change.changeId) ? undefined : left.find(([l]) => l.change.changeId === c.change.changeId)?.[1];
    leftOut(t, repo, c.change, why);
  }
  // A PR its own CI already tested on the base as it is now needs no label.
  const tested = members.length < 2 && (await testedAlone(t, head.change, head.pull));
  const wanted: [number, boolean][] = members.length >= 2 || tested ? [] : [[head.change.prNumber, labelled(head.pull, NEXT_LABEL)]];
  const kept = members.map((m) => m.change.prNumber);
  if (tested) kept.push(head.change.prNumber);
  await next.relabel(t, repo, wanted, kept);
  if (members.length >= 2) await takeBatch(t, repo, base, members);
  else await t.take(head.change);
  return true;
}
export { next_ as next };

/** The ready Changes the train may take now, in order, with their PRs; settles what moved meanwhile. */
async function candidates(t: Train, repo: string, ready: Change[]): Promise<[Candidate[], boolean]> {
  const out: Candidate[] = [];
  let settled = false;
  for (let change of ready) {
    let pull: Pull;
    try {
      pull = await t.github.pull(repo, change.prNumber);
    } catch (error) {
      readyError(t, change, (error as Error).message);
      continue;
    }
    if (pull.merged) {
      await t.abandon(change, "was merged outside the train");
      settled = true;
      continue;
    }
    if (pull.state !== "open") {
      await t.abandon(change, "was closed");
      settled = true;
      continue;
    }
    // A re-review whose head moved is refresh's to send to the gate.
    if (change.state === "reviewing" && pull.head.sha.toLowerCase() !== change.headSha) continue;
    if (pull.head.sha.toLowerCase() !== change.headSha) {
      try {
        await t.readyMoved(change, pull);
      } catch (error) {
        readyError(t, change, (error as Error).message);
      }
      settled = true;
      const moved = t.records.get(change.changeId);
      if (moved && moved.headSha === pull.head.sha.toLowerCase() && (moved.state === "ready" || rereviewing(t, moved))) change = moved;
      else continue;
    }
    if (!reviewed(change) && change.state === "ready") {
      const reviewing = t.update(change.changeId, ["ready"], (c) => ({ ...c, state: "reviewing" }));
      if (reviewing) await t.toGate(reviewing);
      settled = true;
      continue;
    }
    const waiting = await next.waitingOn(t, change);
    let hold: string | undefined;
    if (pull.draft) hold = DRAFT;
    else if (held(pull)) hold = HELD;
    else if (waiting) hold = waiting.note;
    else {
      // A read that failed is not "no CI": the head's checks decide, as for any repo.
      let ci: boolean | undefined;
      try {
        ci = await t.hasCi(repo, pull.base.ref);
      } catch {
        ci = undefined;
      }
      if (ci === false) hold = NO_CI;
    }
    const shown = change.lastError;
    const ours = [DRAFT, HELD, NO_CI];
    const wasWaiting = shown?.startsWith(next.WAITING_ON) ?? false;
    if (hold !== shown && (hold !== undefined || wasWaiting || (shown !== undefined && ours.includes(shown)))) {
      t.update(change.changeId, ["ready"], (c) => {
        const { lastError: _, ...rest } = c;
        return hold === undefined ? rest : { ...rest, lastError: errorText(hold) };
      });
    }
    if (hold !== undefined) continue;
    // Stacked on a PR's branch: once that PR merged, it goes into its base, never into the landed branch.
    try {
      if (await next.restack(t, change, pull)) {
        settled = true;
        continue;
      }
    } catch (error) {
      readyError(t, change, (error as Error).message);
      continue;
    }
    // Regenerated first, or still being regenerated: its new head comes through as a push.
    if (await earlyMigration(t, change, pull)) continue;
    out.push({ change, pull });
  }
  return [out, settled];
}

function readyError(t: Train, change: Change, message: string): void {
  const why = errorText(`GitHub: ${message}`);
  t.update(change.changeId, ["ready"], (c) => ({ ...c, lastError: why }));
}

/** Why the Change's own head keeps it out of a batch into `base`; undefined when it may join. */
export async function ownCi(t: Train, repo: string, change: Change, base: string): Promise<string | undefined> {
  let runs: CheckRun[];
  try {
    runs = await t.github.checkRuns(repo, change.headSha);
  } catch (error) {
    return `its checks could not be read: GitHub: ${(error as Error).message}`;
  }
  const fast = await t.fast(repo, base);
  const workflows = await next.workflows(t, repo, base);
  if (!workflows) return "its workflows could not be read for the checks a batch skips";
  const sha = change.headSha;
  const skipWhy = await next.rerunCancelledSkips(t, repo, sha, runs, workflows.batch);
  if (skipWhy !== undefined) return skipWhy;
  runs = next.provenRuns(runs, workflows.batch);
  const batch = next.batchNames(workflows);
  // A check of the fast set whose job its tree doesn't define can't run on its head: the batch's CI decides it.
  if (fast) {
    const unrun = fast.set.filter((n) => !batch.includes(n) && !runs.some((r) => next.gatedName(n, r.name)));
    if (unrun.length > 0) {
      const gone = await next.undefinedAt(t, repo, base, sha, unrun);
      fast.set = fast.set.filter((n) => !gone.includes(n));
    }
  }
  const unrun = [...(fast?.set ?? []), ...batch].some((n) => !runs.some((r) => next.gatedName(n, r.name)));
  let statuses: CommitStatus[] = [];
  if (unrun || runs.length === 0) {
    try {
      statuses = await t.github.statuses(repo, change.headSha);
    } catch (error) {
      return `its statuses could not be read: GitHub: ${(error as Error).message}`;
    }
  }
  return ownChecks(runs, statuses, fast, batch);
}

/** Records why this pass left a ready Change out of the batch (`LEFT_OUT`); undefined clears an earlier reason. */
function leftOut(t: Train, repo: string, change: Change, why: string | undefined): void {
  const shown = change.lastError;
  const ours = shown?.startsWith(LEFT_OUT) ?? false;
  const note = why !== undefined ? `${LEFT_OUT}${why}` : undefined;
  if (why !== undefined) console.info(`train: ${repo}#${change.prNumber} (${change.changeId}) left out of the batch: ${why}`);
  if (note === shown || (note === undefined && !ours)) return;
  t.update(change.changeId, ["ready"], (c) => {
    const { lastError: _, ...rest } = c;
    return note === undefined ? rest : { ...rest, lastError: errorText(note) };
  });
}

/** Deletes the train's scratch branches: no batch is in flight between passes, so any left is a leftover. */
export async function sweepScratch(t: Train, repo: string): Promise<void> {
  const prefix = await scratchPrefix(t, repo);
  if (prefix === undefined) return;
  let branches: string[];
  try {
    branches = await t.github.matchingBranches(repo, prefix);
  } catch {
    return;
  }
  for (const branch of branches) {
    try {
      await t.github.deleteBranch(repo, branch);
    } catch (error) {
      t.warnHourly([`train: scratch branch ${branch} of ${repo} not deleted`], (error as Error).message, `train: scratch branch ${branch} of ${repo} not deleted: ${(error as Error).message}`);
    }
  }
}

/** A Change in review, approved at an earlier patch, whose re-review is at work: it may go through the train meanwhile. */
export function rereviewing(t: Train, change: Change): boolean {
  return (
    change.state === "reviewing" &&
    !t.overdueReview(change) &&
    change.patchId !== undefined &&
    change.reviews.some((r) => r.blocking === 0 && r.patchId !== change.patchId) &&
    t.gateRereview(change)
  );
}

/** Back in place, with `why` as their last error: to ready, or to review for one whose re-review is not done. */
function release(t: Train, members: Candidate[], why: string): void {
  for (const m of members) {
    t.update(m.change.changeId, ["rebasing", "ci", "merging"], (c) => ({ ...c, state: reviewed(c) ? "ready" : "reviewing", lastError: errorText(why) }));
  }
}

/** Moves each member from `from` to `to`; the ones that were not in it any more are left out. */
function advance(t: Train, members: Candidate[], from: ChangeState, to: ChangeState): Candidate[] {
  return members.flatMap((m) => {
    const change = t.update(m.change.changeId, [from], (c) => ({ ...c, state: to }));
    return change ? [{ change, pull: m.pull }] : [];
  });
}

/** Each member alone, in order, released to ready first with `why`; one handed back to ready stops the rest. */
async function alone(t: Train, members: Candidate[], why: string): Promise<void> {
  release(t, members, why);
  for (const m of members) {
    const ready = t.records.get(m.change.changeId);
    if (ready && (ready.state === "ready" || rereviewing(t, ready))) {
      await t.take(ready);
      const after = t.records.get(m.change.changeId);
      if (after && (after.state === "ready" || rereviewing(t, after))) return;
    }
  }
}

/** Makes `branch` the base with each member's head merged in, in order, on GitHub. The batch's head and its members. */
async function buildBatch(t: Train, repo: string, base: string, branch: string, members: Candidate[]): Promise<[string, Candidate[]]> {
  let head = await t.github.branchSha(repo, base);
  await t.github.createBranch(repo, branch, head);
  const kept: Candidate[] = [];
  for (const m of members) {
    const out = await t.github.mergeInto(repo, branch, m.change.headSha, `${m.pull.title.trim()} (#${m.change.prNumber})`);
    if (out.kind === "merged") {
      head = out.sha;
      kept.push(m);
    } else if (out.kind === "conflict" && kept.length > 0 && m.pull.mergeable !== false) {
      // Only with the PRs ahead of it in this batch: it goes again once they land.
      release(t, [m], `conflicts with the PRs ahead of it in this batch; it goes again once they land on ${base}`);
    } else if (out.kind === "conflict") {
      const why = `conflicts with ${base}`;
      if ((await conflicted(t, m.change, m.pull, why)) === "regenerating") release(t, [m], `it ${why}; ${REGENERATING}`);
    } else release(t, [m], `left out of the batch: ${base} already has its head`);
  }
  return [head, kept];
}

async function takeBatch(t: Train, repo: string, base: string, members: Candidate[]): Promise<void> {
  const moved = (["ready", "reviewing"] as ChangeState[]).flatMap((from) => advance(t, members.filter((m) => m.change.state === from), from, "rebasing"));
  const building = members.map((m) => moved.find((b) => b.change.changeId === m.change.changeId)).filter((b): b is Candidate => b !== undefined);
  if (building.length !== members.length) return release(t, building, MEMBER_LEFT);
  const branch = await scratchBranch(t, building[0]!.change, "batch");
  if (branch === undefined) return release(t, building, "the batch's branch name could not be read");
  let sha: string;
  let kept: Candidate[];
  try {
    [sha, kept] = await buildBatch(t, repo, base, branch, building);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    return release(t, building, `GitHub: ${error.message}`);
  }
  if (kept.length < 2) return alone(t, kept, "the batch's other PRs conflict or are already in its base");
  const title = batchTitle(kept);
  let pr: number;
  try {
    pr = await t.github.openPull(repo, branch, base, title, batchBody(base, kept), false);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    return release(t, kept, `GitHub: ${error.message}`);
  }
  // Its branch already gets the expensive jobs; the label shows it is next.
  await next.label(t, repo, pr, false);
  const inCi = advance(t, kept, "rebasing", "ci");
  if (inCi.length !== kept.length) return release(t, kept, MEMBER_LEFT);
  t.pushed.set(inCi[0]!.change.changeId, [sha, t.nowMs()]);
  await ride(t, repo, base, { pr, sha, title, members: inCi, added: inCi.length, lone: false });
}

/** The batch PR behind `ahead` (the `k`th of the chain): the ready PRs green on their own heads not in it, built on it. */
async function follower(t: Train, repo: string, base: string, ahead: Stage, k: number): Promise<Stage | undefined> {
  const ready = t.records.inTrain(repo, ["reviewing", "ready"]).filter((c) => c.state === "ready" || rereviewing(t, c));
  const [cands] = await candidates(t, repo, ready);
  const picked: Candidate[] = [];
  for (const c of cands) {
    if (picked.length === BATCH_MAX) break;
    if (c.pull.base.ref === base && (await ownCi(t, repo, c.change, base)) === undefined) picked.push(c);
  }
  if (picked.length === 0) return undefined;
  const building = (["ready", "reviewing"] as ChangeState[]).flatMap((from) => advance(t, picked.filter((m) => m.change.state === from), from, "rebasing"));
  if (building.length !== picked.length) {
    release(t, building, MEMBER_LEFT);
    return undefined;
  }
  const branch = await scratchBranch(t, ahead.members[0]!.change, followerName(k));
  if (branch === undefined) {
    release(t, building, "the batch's branch name could not be read");
    return undefined;
  }
  let sha: string;
  const kept: Candidate[] = [];
  try {
    await t.github.createBranch(repo, branch, ahead.sha);
    sha = ahead.sha;
    for (const m of building) {
      const out = await t.github.mergeInto(repo, branch, m.change.headSha, `${m.pull.title.trim()} (#${m.change.prNumber})`);
      if (out.kind === "merged") {
        sha = out.sha;
        kept.push(m);
      } else if (out.kind === "conflict") {
        release(t, [m], `conflicts with the PRs in ${stageName(ahead)} ahead of it; it goes again once they land`);
      } else release(t, [m], `left out of the batch: ${base} already has its head`);
    }
  } catch (error) {
    release(t, building, `GitHub: ${(error as Error).message}`);
    return undefined;
  }
  if (kept.length === 0) return undefined;
  const all = [...ahead.members, ...kept];
  const title = batchTitle(all);
  let pr: number;
  try {
    pr = await t.github.openPull(repo, branch, base, title, batchBody(base, all), false);
  } catch (error) {
    release(t, kept, `GitHub: ${(error as Error).message}`);
    return undefined;
  }
  await next.label(t, repo, pr, false);
  const inCi = advance(t, kept, "rebasing", "ci");
  if (inCi.length !== kept.length) {
    release(t, kept, MEMBER_LEFT);
    return undefined;
  }
  t.pushed.set(inCi[0]!.change.changeId, [sha, t.nowMs()]);
  console.info(`train: batch #${pr} of ${repo} in CI behind #${ahead.pr}: ${inCi.map((m) => `#${m.change.prNumber}`).join(", ")}`);
  return { pr, sha, title, members: [...ahead.members, ...inCi], added: inCi.length, lone: false };
}

/** What runs between reads of the CI of `chain`'s first stage, at most once per poll: a batch built on its last stage. */
export function stacker(t: Train, repo: string, base: string, chain: Stage[]): Between {
  const depth = Math.max(t.options.pipelineDepth, 1);
  const every = t.options.pollIntervalMs;
  let tried: number | undefined;
  return async () => {
    const now = t.nowMs();
    if (chain.length >= depth || (tried !== undefined && now - tried < every)) return;
    tried = now;
    const ahead = chain.at(-1);
    if (!ahead) return;
    const nextStage = await follower(t, repo, base, ahead, chain.length);
    if (nextStage) chain.push(nextStage);
  };
}

/** From `lead` in CI to merged, with batches behind it in CI meanwhile, then landed by `landChain`. */
async function ride(t: Train, repo: string, base: string, lead: Stage): Promise<void> {
  const started = t.nowMs();
  const chain: Stage[] = [lead];
  const failed = await stageCi(t, repo, base, lead, undefined, stacker(t, repo, base, chain));
  if (failed) {
    dropBehind(t, chain, failedWhat(failed), base);
    return failAlone(t, lead, failed);
  }
  await landChain(t, repo, base, chain, started);
}

/** The batches stacked on `chain`'s first stage, which `what`: their own PRs back in line, for a batch on the base. */
export function dropBehind(t: Train, chain: Stage[], what: string, base: string): void {
  const lead = chain[0];
  if (!lead) return;
  const why = `${stageName(lead)} ahead of it ${what}; it forms again on ${base}`;
  for (const stage of chain.slice(1)) release(t, own(stage), why);
}

/** `chain`, whose first stage passed CI, to merged: the furthest batch that passed lands as one squash of all. */
export async function landChain(t: Train, repo: string, base: string, chain: Stage[], started: number): Promise<void> {
  const waitMs = t.options.followerWaitMs ?? Math.max(t.nowMs() - started, 0);
  const until = t.nowMs() + waitMs;
  let landing = 0;
  let failed: [number, Failed] | undefined;
  for (let i = 1; i < chain.length; i++) {
    const f = await stageCi(t, repo, base, chain[i]!, [until, waitMs]);
    if (!f) landing = i;
    else {
      failed = [i, f];
      break;
    }
  }
  const lands = chain[landing]!;
  if (failed) {
    const [at, f] = failed;
    const stage = chain[at]!;
    if (f.kind === "late") {
      console.info(`train: batch #${stage.pr} of ${repo} is still in CI; ${stageName(lands)} ahead lands without it`);
      release(
        t,
        own(stage),
        `batch #${stage.pr} was still in CI ${Math.floor(waitMs / 1000)} s after ${stageName(lands)} ahead of it passed, which landed without it; it forms again on ${base}`,
      );
    }
    const why = `batch #${stage.pr} ahead of it ${failedWhat(f)}; it forms again on ${base}`;
    for (const behind of chain.slice(at + 1)) release(t, own(behind), why);
  }
  // The furthest passed batch lands; one that can't gives way to the nearest passed stage ahead of it still clean.
  let at = landing;
  let landed: { ok: true } | { ok: false; at: number; unlanded: Unlanded };
  for (;;) {
    if (at === 0 && chain[0]!.lone) {
      await mergeAloneStage(t, chain[0]!, base);
      landed = { ok: true };
      break;
    }
    const u = await land(t, repo, base, chain[at]!);
    if (!u) {
      landed = { ok: true };
      break;
    }
    let ahead: number | undefined;
    if (at === 0) ahead = undefined;
    else if (u.kind === "members") {
      for (let j = at - 1; j >= 0; j--) {
        if (!chain[j]!.members.some((m) => u.ids.includes(m.change.changeId))) {
          ahead = j;
          break;
        }
      }
    } else if (u.kind === "refused" || u.kind === "failed") ahead = at - 1;
    if (ahead === undefined) {
      landed = { ok: false, at, unlanded: u };
      break;
    }
    console.info(`train: batch #${chain[at]!.pr} of ${repo} can't land (${u.why}); ${stageName(chain[ahead]!)} ahead lands`);
    const why = `batch #${chain[at]!.pr} passed CI but couldn't land (${u.why}); ${stageName(chain[ahead]!)} ahead of it landed without it, and it forms again on ${base}`;
    for (const stage of chain.slice(ahead + 1, at + 1)) release(t, own(stage), why);
    at = ahead;
  }
  if (landed.ok) {
    if (failed && failed[1].kind !== "late") await failAlone(t, chain[failed[0]]!, failed[1]);
  } else {
    // Nothing landed ahead of the red batch: its own PRs form again with the rest.
    if (failed) release(t, own(chain[failed[0]]!), landed.unlanded.why);
    if (landed.unlanded.kind === "refused") await alone(t, chain[landed.at]!.members, landed.unlanded.why);
    else release(t, chain[landed.at]!.members, landed.unlanded.why);
  }
}

/** The PR alone at the front of a chain, whose CI passed and whose batches behind didn't land: merged alone. */
async function mergeAloneStage(t: Train, stage: Stage, base: string): Promise<void> {
  const m = stage.members[0];
  if (!m) return;
  const change = t.records.get(m.change.changeId) ?? m.change;
  try {
    await t.mergeAlone(change, m.pull, base);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    t.putBack(change, `GitHub: ${error.message}`);
  }
}

/** The batch's CI on its head: undefined once it passed, else how it failed. `late`: when it is given up, and the wait. */
async function stageCi(t: Train, repo: string, base: string, stage: Stage, late?: [number, number], between?: Between): Promise<Failed | undefined> {
  console.info(`train: batch #${stage.pr} of ${repo} in CI at ${stage.sha}: ${stage.members.map((m) => `#${m.change.prNumber}`).join(", ")}`);
  const noted = own(stage).map((m) => m.change.changeId);
  const outcome = await t.watchCi(own(stage)[0]!.change, repo, stage.sha, base, undefined, noted, late?.[0], between);
  if (!outcome) return { kind: "late", waitMs: late?.[1] ?? 0 };
  if (outcome.kind === "green") return undefined;
  if (outcome.kind === "red") return { kind: "ci", what: "red" };
  if (outcome.kind === "timeout") return { kind: "ci", what: "timed out" };
  return { kind: "ci", what: "superseded" };
}

/** A batch whose CI failed: each of its own PRs goes alone. */
async function failAlone(t: Train, stage: Stage, failed: Failed): Promise<void> {
  console.info(`train: batch #${stage.pr} red at ${stage.sha}, each member goes alone`);
  await alone(t, own(stage), `batch #${stage.pr}'s CI ${failedCi(failed)}; each of its PRs goes alone`);
}

/** The batch PR `stage`, whose CI passed, to merged; when it can't, why, its members back in `ci`. */
async function land(t: Train, repo: string, base: string, stage: Stage): Promise<Unlanded | undefined> {
  const { pr, sha, title } = stage;
  const inCi = stage.members;
  const numbers = inCi.map((m) => m.change.prNumber);
  // CI passed: the merge also waits for the re-reviews still at work.
  const pending = inCi.map((m) => t.records.get(m.change.changeId)).filter((c): c is Change => c !== undefined && !reviewed(c));
  if (pending.length > 0) {
    const waits = await t.awaitReviews(pending);
    const dropped: string[] = [];
    const ids: string[] = [];
    pending.forEach((change, i) => {
      const w = waits[i]!;
      if (w.kind === "clean") t.addReviews(change, w.reviews);
      else if (w.kind === "blocked") {
        t.toReview(change);
        ids.push(change.changeId);
        dropped.push(`#${change.prNumber}'s re-review found blocking findings`);
      } else {
        t.toReview(change, t.reviewOverdue(change));
        ids.push(change.changeId);
        dropped.push(`#${change.prNumber}'s re-review is still at work`);
      }
    });
    if (dropped.length > 0) {
      console.info(`train: a re-review dropped PRs from batch #${pr}: ${dropped.join("; ")}`);
      return { kind: "members", ids, why: `batch #${pr} passed CI, but ${dropped.join(" and ")}; the batch forms again without it` };
    }
  }
  // A member pushed to, held or closed while CI ran is not what was tested.
  const moved: string[] = [];
  let why: string | undefined;
  for (const m of inCi) {
    try {
      const p = await t.github.pull(repo, m.change.prNumber);
      if (p.state === "open" && !p.merged && !held(p) && p.head.sha.toLowerCase() === m.change.headSha) continue;
      moved.push(m.change.changeId);
      why ??= `#${m.change.prNumber} was pushed to, held or closed while batch #${pr} was in CI`;
    } catch (error) {
      moved.push(m.change.changeId);
      why ??= `GitHub: ${(error as Error).message}`;
    }
  }
  if (why !== undefined) return { kind: "members", ids: moved, why };
  const merging = advance(t, inCi, "ci", "merging");
  const back = (u: Unlanded) => {
    advance(t, merging, "merging", "ci");
    return u;
  };
  if (merging.length !== inCi.length) return back({ kind: "failed", why: MEMBER_LEFT });
  try {
    await t.github.postTrainStatus(repo, sha, `batch of ${merging.length}: merged onto ${base}, CI green`);
  } catch (error) {
    return back({ kind: "failed", why: `GitHub: ${(error as Error).message}` });
  }
  const commitBody = withTrailers(memberLines(merging), merging.map((m) => m.change));
  let out;
  try {
    out = await t.github.merge(repo, pr, sha, [`${title} (#${pr})`, commitBody]);
  } catch (error) {
    // GitHub may have merged it all the same: the next pass's reconcile finishes the members if it did.
    return back({ kind: "unknown", why: `GitHub: ${(error as Error).message}` });
  }
  if (out.kind === "refused") {
    console.info(`train: batch #${pr} refused (HTTP ${out.status}): ${out.message}; each member goes alone`);
    return back({ kind: "refused", why: `GitHub refused batch #${pr} (HTTP ${out.status}): ${out.message}; each of its PRs goes alone` });
  }
  watchMerge(t, repo, base, out.sha, `https://github.com/${repo}/pull/${pr}`);
  const landed: Landed = { prNumber: pr, mergedSha: out.sha, members: numbers };
  for (const m of merging) await finishBatchMember(t, m.change, landed);
  return undefined;
}

/** Merged in `landed`: recorded as merged with the batch's squash, and its own PR closed with a link to it. */
export async function finishBatchMember(t: Train, change: Change, landed: Landed): Promise<void> {
  let pull: Pull;
  try {
    pull = await t.github.pull(change.repo, change.prNumber);
  } catch (error) {
    return t.warnHourly([`train: batch member ${change.changeId} not read; the next pass finishes it`], (error as Error).message, `train: batch member ${change.changeId} not read; the next pass finishes it: ${(error as Error).message}`);
  }
  if (pull.head.sha.toLowerCase() !== change.headSha) {
    const why =
      `pushed to while batch #${landed.prNumber} merged: the batch landed its head ${short(change.headSha)}, not the new one, which goes ` +
      "through the train";
    t.update(change.changeId, ["ready", "rebasing", "ci", "merging"], (c) => ({ ...c, state: "ready", lastError: errorText(why) }));
    return;
  }
  await t.finishMerged(change, landed.mergedSha, landed);
  if (pull.state === "open") await closeMember(t, change, landed);
}

/** Closes a landed member's PR with a link to its batch; a failure stays on the Change for reconcile to retry. */
async function closeMember(t: Train, change: Change, landed: Landed): Promise<void> {
  const others = landed.members.filter((n) => n !== change.prNumber).map((n) => `#${n}`);
  const comment = `Landed in #${landed.prNumber} (${short(landed.mergedSha)}) by the fleetd merge train: merged together with ${others.join(", ")} after one CI run on the batch.`;
  let failure: string | undefined;
  try {
    await t.github.close(change.repo, change.prNumber, comment);
  } catch (error) {
    failure = (error as Error).message;
  }
  t.update(change.changeId, ["merged"], (c) => {
    const { lastError: _, ...rest } = c;
    return failure === undefined ? rest : { ...rest, lastError: errorText(`${NOT_CLOSED}: GitHub: ${failure}`) };
  });
}

/** Each pass: members of merged batch PRs not finished (a restart, a failed call) are finished now, at their recorded heads. */
export async function reconcileBatches(t: Train, repo: string): Promise<void> {
  const prefix = await scratchPrefix(t, repo);
  if (prefix === undefined) return;
  const pulls: Pull[] = [];
  for (const name of batchNames(t.options.pipelineDepth)) {
    try {
      pulls.push(...(await t.github.pullsFor(repo, `${prefix}${name}`, "closed")));
    } catch {
      return;
    }
  }
  for (const p of pulls.filter((p) => p.merged_at != null)) {
    const heads = batchHeads(p.body ?? "");
    const landed: Landed = { prNumber: p.number, mergedSha: p.merge_commit_sha ?? "", members: heads.map(([n]) => n) };
    for (const [n, sha] of heads) {
      const change = t.records.latestFor(repo, n);
      if (!change || sha !== change.headSha) continue;
      if (change.state === "merged" && change.lastError?.startsWith(NOT_CLOSED)) await closeMember(t, change, landed);
      else if (["ready", "rebasing", "ci", "merging"].includes(change.state)) await finishBatchMember(t, change, landed);
    }
  }
}

/** After a restart, the batch whose members are all in `ci` at the heads the open batch PR names goes on being watched. */
export async function resumeBatch(t: Train, repo: string, inCi: Change[]): Promise<boolean> {
  const first = inCi[0];
  if (!first) return false;
  const branch = await scratchBranch(t, first, "batch");
  if (branch === undefined) return false;
  let open: Pull[];
  try {
    open = await t.github.pullsFor(repo, branch, "open");
  } catch {
    return false;
  }
  const b = open[0];
  if (!b) return false;
  const heads = batchHeads(b.body ?? "");
  const builtFrom = (c: Change) => heads.some(([n, sha]) => n === c.prNumber && sha === c.headSha);
  if (heads.length !== inCi.length || !inCi.every(builtFrom)) return false;
  const members: Candidate[] = [];
  for (const [n] of heads) {
    const change = inCi.find((c) => c.prNumber === n);
    if (!change) return false;
    try {
      members.push({ change, pull: await t.github.pull(repo, n) });
    } catch {
      return false;
    }
  }
  console.info(`train: the hub restarted; watching batch #${b.number}'s CI again`);
  await ride(t, repo, b.base.ref, { pr: b.number, sha: b.head.sha.toLowerCase(), title: b.title, members, added: members.length, lone: false });
  return true;
}

/** The merged batch PR that names this Change's PR at its head, for a hub that restarted while merging it. */
export async function landedInBatch(t: Train, change: Change): Promise<Landed | undefined> {
  const pulls: Pull[] = [];
  for (const name of batchNames(t.options.pipelineDepth)) {
    const branch = await scratchBranch(t, change, name);
    if (branch === undefined) return undefined;
    try {
      pulls.push(...(await t.github.pullsFor(change.repo, branch, "closed")));
    } catch {
      return undefined;
    }
  }
  for (const p of pulls) {
    const heads = batchHeads(p.body ?? "");
    if (p.merged_at != null && heads.some(([n, sha]) => n === change.prNumber && sha === change.headSha)) {
      return { prNumber: p.number, mergedSha: p.merge_commit_sha ?? "", members: heads.map(([n]) => n) };
    }
  }
  return undefined;
}

/**
 * Whether the Change's own head may merge as it is, with no rebase and no label: its base's head is already in it, and
 * its fast set already passed there, with no skipped check the label runs (but on a PR that has the label).
 */
export async function testedAlone(t: Train, change: Change, pull: Pull): Promise<boolean> {
  const repo = change.repo;
  const base = pull.base.ref;
  const head = change.headSha;
  if (pull.head.sha.toLowerCase() !== head) return false;
  try {
    const baseSha = await t.github.branchSha(repo, base);
    const range = await t.github.range(repo, baseSha, head);
    if (!range || range.base !== baseSha) return false;
    if ((await ownCi(t, repo, change, base)) !== undefined) return false;
    const runs = await t.github.checkRuns(repo, head);
    const has = labelled(pull, NEXT_LABEL);
    const lone: next.Lone = { label: next.labelled(t, repo, change.prNumber, has), gate: await next.labelGate(t, repo, base) };
    return next.unprovenSkips(runs, lone).length === 0;
  } catch {
    return false;
  }
}
