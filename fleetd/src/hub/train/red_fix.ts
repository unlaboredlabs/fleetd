// The fix for a red base: while the base's CI is red (main_ci.ts), a PR on the train that a fix order for a failing
// check opened (its order's), or that changes the workflow file of a failing check (a job that hangs or runs past its
// limit is fixed there, as fleetd-cloud #769 was on 2026-11-23, with no failing test for a PR to name). The status
// counts it as a fix under way, and the train's line takes it before the others: alone in test-then-merge, and in
// "Merge, then verify" into CI even when the repo's PRs in CI at once are at their limit.
import type { Change, ChangeState } from "../../shared/contracts.ts";
import { gatedName, knownWorkflows, workflows } from "./next.ts";
import type { Train } from "./service.ts";

const WORKFLOWS = ".github/workflows/";
/** A Change still on its way to merging: what counts as a fix under way. */
export const ON_ITS_WAY: ChangeState[] = ["queued", "reviewing", "ready", "rebasing", "ci", "merging", "needs_rebase", "ci_failed"];

/** Whether `change` fixes its repo's red base, by what `readFixes` read: false while the base isn't red. */
export function fixesRed(t: Train, change: Change): boolean {
  const repo = change.repo.toLowerCase();
  const ci = t.mainCi(repo);
  if (ci?.state !== "red") return false;
  const ordered = ci.failing.some((name) => {
    const order = t.records.fixOrder(repo, name)?.order;
    return order !== undefined && order === change.workstreamId && t.host.workstream(order)?.open === true;
  });
  if (ordered) return true;
  const kept = t.pullFiles.get(change.changeId);
  if (kept?.[0] !== change.headSha || !kept[1]) return false;
  const touched = kept[1].flatMap((f) => [f.path, ...(f.previousPath === undefined ? [] : [f.previousPath])]).filter((p) => p.startsWith(WORKFLOWS));
  if (touched.length === 0) return false;
  const files = knownWorkflows(t, repo, t.sync.base(repo) ?? "main")?.files;
  // Which file runs a failing check unknown (unread, or no check named): any workflow file counts.
  if (files === undefined || ci.failing.length === 0) return true;
  const failing = files.filter(([, names]) => ci.failing.some((check) => names.some((n) => gatedName(n, check)))).map(([path]) => path);
  return touched.some((p) => failing.includes(p));
}

/** While the repo's base is red: its workflows and the files of each of its Changes on their way, read once per head. */
export async function readFixes(t: Train, repo: string): Promise<void> {
  if (t.mainCi(repo)?.state !== "red") return;
  await workflows(t, repo, t.sync.base(repo) ?? "main");
  for (const change of t.records.inTrain(repo, ON_ITS_WAY)) {
    try {
      await t.changeFiles(change);
    } catch (error) {
      t.warnHourly([`train: files of ${change.changeId} not read`], (error as Error).message, `train: files of ${change.changeId} not read for a red main's fix: ${(error as Error).message}`);
    }
  }
}

/** `ready` with the red base's fixes first, each kept in its place among them. */
export const fixesFirst = (t: Train, ready: Change[]): Change[] => {
  const fixes = ready.filter((c) => fixesRed(t, c));
  return [...fixes, ...ready.filter((c) => !fixes.includes(c))];
};

/** The red base's fixes on their way to merging. */
export const redFixes = (t: Train, repo: string): Change[] => t.records.inTrain(repo, ON_ITS_WAY).filter((c) => fixesRed(t, c));
