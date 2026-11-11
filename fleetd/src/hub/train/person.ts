// Ready PRs that wait on a person: one whose base requires an approving review on GitHub, which the train merges by
// itself once it is approved, and one with the `hold` label, which a person merges. The train never approves a PR and
// never goes around a rule: it reads GitHub's own answer on the PR's reviews, waits, and says so once.
import type { Change } from "../../shared/contracts.ts";
import { HELD, ownCiRed, reviewed, tellOwnRed } from "./batch.ts";
import { prNote } from "./events.ts";
import type { Pull } from "./github.ts";
import { WAIT_PERSON } from "./records.ts";
import { short } from "./rules.ts";
import type { Train } from "./service.ts";

/** A ready Change's `lastError` while its base requires an approving review it doesn't have. */
export const APPROVAL = "held: waiting for a person's approval on GitHub; the train merges it once it is approved";

/** How often at most the train brings one PR a person merges up to date with its base: each update runs its CI again. */
const HELD_UPDATE_EVERY_MS = 60 * 60_000;

const unapproved = (decision: string | undefined) => decision === "REVIEW_REQUIRED" || decision === "CHANGES_REQUESTED";
const baseKey = (repo: string, base: string) => `${repo}\u0000${base}`;

/**
 * GitHub's answer on the Change's reviews, read at most every `readyEveryMs` per head; undefined where it gives none.
 * A base it answers for requires an approval, whatever its rules read (`approvalBases`); no answer unlearns nothing,
 * as GitHub also gives none while another rule holds the PR. Throws when GitHub doesn't answer.
 */
async function decision(t: Train, change: Change, base: string, fresh = false): Promise<string | undefined> {
  const now = t.nowMs();
  const cached = t.decisions.get(change.changeId);
  if (!fresh && cached && cached[1] === change.headSha && now - cached[0] < t.options.readyEveryMs) return cached[2];
  const d = await t.github.reviewDecision(change.repo, change.prNumber);
  t.decisions.set(change.changeId, [now, change.headSha, d]);
  if (d !== undefined) t.approvalBases.add(baseKey(change.repo, base));
  return d;
}

function unread(t: Train, change: Change, error: unknown): void {
  const message = (error as Error).message;
  t.warnHourly([`train: reviews of ${change.changeId} not read`], message, `train: reviews of ${change.changeId} not read, so it goes as if approved: ${message}`);
}

/**
 * Whether a ready Change waits for a person's approval: its base requires one, and GitHub says it has none yet. One
 * whose reviews can't be read goes on as before the train read them, and GitHub refuses its merge if it must.
 */
export async function awaitsApproval(t: Train, change: Change, base: string): Promise<boolean> {
  // One that waits for it already is asked about whatever the rules read: a restart forgets a base a refusal taught.
  if (!(await t.rules(change.repo, base)).approval && change.lastError !== APPROVAL) return false;
  try {
    return unapproved(await decision(t, change, base));
  } catch (error) {
    unread(t, change, error);
    return false;
  }
}

/**
 * A merge GitHub refused: whether for an approval the PR doesn't have, by GitHub's own answer. Then the Change waits
 * in line for it, and the lead hears of it again.
 */
export async function refusedUnapproved(t: Train, merging: Change, base: string): Promise<boolean> {
  try {
    if (!unapproved(await decision(t, merging, base, true))) return false;
  } catch (error) {
    unread(t, merging, error);
    return false;
  }
  t.records.endWait(merging.changeId, WAIT_PERSON);
  t.update(merging.changeId, ["merging"], (c) => ({ ...c, state: "ready", lastError: APPROVAL }));
  return true;
}

/**
 * A ready Change that waits on a person, for the reason in `note` (`HELD` or `APPROVAL`), looked at every
 * `readyEveryMs`: its author hears of red CI on its own head, once per head, and the lead hears that it is reviewed
 * and green, once per patch. One with the label is first brought up to date with its base (`keepCurrent`).
 */
export async function waits(t: Train, change: Change, pull: Pull, note: string): Promise<void> {
  if (change.state !== "ready" || !reviewed(change) || change.patchId === undefined) return;
  const now = t.nowMs();
  const last = t.personChecks.get(change.changeId);
  if (last !== undefined && now - last < t.options.readyEveryMs) return;
  t.personChecks.set(change.changeId, now);
  const base = pull.base.ref;
  const own = await ownCiRed(t, change.repo, change, base);
  if (own.red.length > 0) return tellOwnRed(t, change, own.red, "it waits for a person, and no one merges it red");
  if (own.why !== undefined) return;
  if (note === HELD && (await keepCurrent(t, change, pull))) return;
  if (!t.records.startWait(change, WAIT_PERSON, change.patchId, now, "told")) return;
  const at = `reviewed and green at ${short(change.headSha)}`;
  const text =
    note === HELD
      ? `${at}, and held by its \`hold\` label. If a person merges it, tell them it is ready, this once`
      : `${at}, and waiting for a person's approval on GitHub, which its base requires: tell them, this once. The train merges it by itself once it is approved`;
  await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, text));
}

/**
 * Brings a PR a person merges up to date with its base, at most every `HELD_UPDATE_EVERY_MS`: true when it pushed.
 * Never at the cost of an approval: where the base drops approvals on new commits, an approved PR is left as it is,
 * and any other gets the base merged into it, which rewrites none of its commits. Not while the rules can't be read.
 */
async function keepCurrent(t: Train, change: Change, pull: Pull): Promise<boolean> {
  const repo = change.repo;
  const base = pull.base.ref;
  const now = t.nowMs();
  const last = t.heldUpdates.get(change.changeId);
  if (last !== undefined && now - last < HELD_UPDATE_EVERY_MS) return false;
  try {
    const rules = await t.rules(repo, base);
    if (rules.unread.length > 0) return false;
    const baseSha = await t.github.branchSha(repo, base);
    const range = await t.github.range(repo, baseSha, change.headSha);
    if (!range || range.base === baseSha) return false;
    const fragile = rules.approval && rules.dismissStale;
    if (fragile && !unapproved(await decision(t, change, base))) return false;
    t.heldUpdates.set(change.changeId, now);
    const update = await t.github.updateBranch(repo, change.prNumber, !fragile);
    if (update === "rebased") console.info(`train: ${change.changeId}, which a person merges, brought up to date with ${base}`);
    return update === "rebased";
  } catch (error) {
    const message = (error as Error).message;
    t.warnHourly([`train: ${change.changeId} not brought up to date`], message, `train: ${change.changeId}, which a person merges, not brought up to date with ${base}: ${message}`);
    return false;
  }
}

/** Forgets what is kept in memory for `repo`'s Changes that left the line. */
export function forget(t: Train, repo: string, live: Set<string>): void {
  const gone = (id: string) => !live.has(id) && (t.records.get(id)?.repo ?? repo) === repo;
  for (const map of [t.decisions, t.personChecks, t.heldUpdates]) for (const id of [...map.keys()]) if (gone(id)) map.delete(id);
}
