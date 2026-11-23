// "Merge, then verify": a bot's PRs merge on their own green CI, each on a rebase onto its base as the base was when
// that CI started, so two PRs that break only together are found on the base's own CI after the merge. A check red on
// a merged commit again after the watch's one re-run (a flake passes then and nothing happens: watch.ts) is blamed on
// one commit: the first one red since the check was last green, bisecting the commits between. A commit the check has
// no run on counts as its parent (a check scoped to some paths skips it); a cancelled run there is re-run, the one in
// the middle first, until the first red commit's parent is green. The culprit's PR gets a revert PR from GitHub, which
// the train lands before any other PR; its writer hears it was reverted, and the lead hears once. What it can't pin
// down (no green run within `WALK` commits, a commit with no PR, a revert GitHub refuses) opens the usual fix order.
import type { Change, ProjectRef } from "../../shared/contracts.ts";
import { prNote } from "./events.ts";
import { type CheckRun, jobOf } from "./github.ts";
import type { Watch } from "./records.ts";
import { isRed, short } from "./rules.ts";
import { TRAIN_BY, type Train } from "./service.ts";

/** How many commits back from a red one the bisect looks for the check's last green run. */
export const WALK = 30;
/** A probe's re-run that shows no newer run this long after the train asked for it counts as not run. */
const PROBE_SHOW_MS = 15 * 60_000;

/** What the watch records on the red commit: a cancelled run there it re-ran to bisect (`probe:<sha>`), as its run id. */
const PROBE = "probe:";

/** The check on one commit, as the bisect reads it. */
export type Seen = "green" | "red" | "pending" | "cancelled" | "none";

/** The bisect's next step: the culprit, a commit to re-run, a re-run to wait for, or no green to start from. */
export type Step = { kind: "culprit"; at: number } | { kind: "probe"; at: number } | { kind: "wait" } | { kind: "unknown" };

/**
 * The next step over the check's runs on consecutive commits, oldest first. The culprit is the first red commit whose
 * nearest commit with a run before it is green; commits without a run (`none`) count as their parent. Between the last
 * green and the first red, a run still going is waited for, else the cancelled one in the middle is re-run.
 */
export function bisect(seen: Seen[]): Step {
  const red = seen.indexOf("red");
  if (red < 0) return { kind: "unknown" };
  const green = seen.lastIndexOf("green", red);
  if (green < 0) return { kind: "unknown" };
  const open: number[] = [];
  for (let i = green + 1; i < red; i++) if (seen[i] !== "none") open.push(i);
  if (open.length === 0) return { kind: "culprit", at: red };
  if (open.some((i) => seen[i] === "pending")) return { kind: "wait" };
  return { kind: "probe", at: open[Math.floor((open.length - 1) / 2)]! };
}

/** `name`'s newest run among `runs`, as the bisect reads it. A skipped run counts as none. */
export function seenOf(runs: CheckRun[], name: string): [Seen, CheckRun | undefined] {
  const run = runs.filter((r) => r.name === name).sort((a, b) => b.id - a.id)[0];
  if (!run) return ["none", undefined];
  if (run.status !== "completed") return ["pending", run];
  if (run.conclusion === "cancelled") return ["cancelled", run];
  if (run.conclusion === "skipped") return ["none", run];
  return [isRed(run) ? "red" : "green", run];
}

/** What the watch does about a check red again on a merged commit: blamed and reverted (or already), still bisecting, or a fix order. */
export type Blame = "taken" | "waiting" | "order";

/** The text the culprit's writer gets. */
export function writerText(culprit: Culprit, check: CheckRun, base: string, revertUrl: string): string {
  const link = check.html_url ? ` (its run: ${check.html_url})` : "";
  return (
    `Your PR ${culprit.prUrl} merged as ${short(culprit.sha)} and turned \`${check.name}\` red on ${base}${link}: it passed on ` +
    `your PR's own CI, but not with what merged beside it. The merge train reverted it in ${revertUrl}, which lands ` +
    `first. Bring your change back in a new PR from a fresh origin/${base} (\`git fetch origin && git checkout -B ` +
    `<branch>-2 origin/${base}\`), with the fix that makes \`${check.name}\` pass there, and open it as usual.`
  );
}

/** The one line the lead gets, about the culprit's Change (`change`, its id or its short sha). */
export function leadLine(change: string, culprit: Culprit, check: CheckRun, w: Watch, revertUrl: string, writer: string | undefined): string {
  const told = writer !== undefined ? `; its writer ${writer} brings it back with a fix` : "; it has no writer to send it back to";
  return prNote(
    change,
    culprit.prUrl,
    `reverted: \`${check.name}\` went red on ${w.base} at ${short(w.sha)}, and again on its re-run, and bisecting the merges since ` +
      `it was last green blamed this PR (${short(culprit.sha)}). The train opened the revert ${revertUrl} and lands it before any ` +
      `other PR${told}`,
  );
}

/** The commit a bisect blamed and the PR it came from. */
export type Culprit = { sha: string; prNumber: number; prUrl: string };

/** The revert PR's body: why, and the words that tell the train it reverts on purpose (`reverts.ts` `deliberate`). */
export function revertBody(culprit: Culprit, check: CheckRun, w: Watch): string {
  const link = check.html_url ? ` ([run](${check.html_url}))` : "";
  return (
    `Reverts #${culprit.prNumber} (${short(culprit.sha)}).\n\n` +
    `\`${check.name}\` failed on ${w.base} at ${short(w.sha)}${link}, and again when the merge train re-ran it. Bisecting the ` +
    `merges since it was last green blamed this one: it was green before ${short(culprit.sha)} and red from it. The train ` +
    "lands this revert before any other PR; the PR's writer brings the change back with a fix."
  );
}

/**
 * In "Merge, then verify": what the watch does instead of opening a fix order for `check`, red on `w`'s commit again
 * after its re-run. Bisects, re-running a cancelled run on the way (`waiting` until it shows); blames a commit and
 * reverts its PR (`taken`, as when its revert is already open); else `order`.
 */
export async function blame(t: Train, w: Watch, check: CheckRun): Promise<Blame> {
  const { repo } = w;
  const name = check.name;
  let commits: string[];
  try {
    commits = await t.github.recentCommits(repo, w.sha, WALK);
  } catch (error) {
    console.warn(`train: commits before ${repo}@${short(w.sha)} not read to bisect ${name}: ${(error as Error).message}`);
    return "waiting";
  }
  // Newest first from the red commit, until the first green one.
  const read: [string, Seen, CheckRun | undefined][] = [[w.sha, "red", check]];
  for (const sha of commits.slice(commits[0] === w.sha ? 1 : 0)) {
    let runs: CheckRun[];
    try {
      runs = await t.github.checkRuns(repo, sha);
    } catch (error) {
      console.warn(`train: checks of ${repo}@${short(sha)} not read to bisect ${name}: ${(error as Error).message}`);
      return "waiting";
    }
    const [seen, run] = seenOf(runs, name);
    read.push([sha, probing(t, w, name, sha, seen, run) ? "pending" : seen, run]);
    if (seen === "green") break;
  }
  const oldest = [...read].reverse();
  const step = bisect(oldest.map(([, s]) => s));
  if (step.kind === "unknown") {
    console.info(`train: ${name} red on ${repo}@${short(w.sha)}: no green run of it in the ${WALK} commits before; a fix order instead`);
    return "order";
  }
  if (step.kind === "wait") return "waiting";
  if (step.kind === "probe") {
    const [sha, , run] = oldest[step.at]!;
    const job = run ? jobOf(run) : undefined;
    if (job === undefined) return "order";
    try {
      await t.github.rerunJob(repo, job);
    } catch (error) {
      console.warn(`train: ${name}'s cancelled run on ${repo}@${short(sha)} not re-run to bisect; a fix order instead: ${(error as Error).message}`);
      return "order";
    }
    console.info(`train: bisecting ${name} red on ${repo}@${short(w.sha)}: re-ran its cancelled run on ${short(sha)}`);
    t.records.putWatchCheck(repo, w.sha, name, run!.id, `${PROBE}${sha}`, t.nowMs());
    return "waiting";
  }
  const sha = oldest[step.at]![0];
  return revert(t, w, check, sha);
}

/** Whether the train re-ran `run`, the cancelled run of `name` on `sha`, to bisect, and the re-run hasn't shown yet. */
function probing(t: Train, w: Watch, name: string, sha: string, seen: Seen, run: CheckRun | undefined): boolean {
  if (seen !== "cancelled" || !run) return false;
  const asked = t.records.watchChecks(w.repo, w.sha).find((s) => s.name === name && s.runId === run.id && s.did === `${PROBE}${sha}`);
  return asked !== undefined && t.nowMs() - asked.atMs < PROBE_SHOW_MS;
}

/** Reverts the PR that merged as `sha`, the culprit of `check` red on `w`'s commit; tells its writer and the lead. */
async function revert(t: Train, w: Watch, check: CheckRun, sha: string): Promise<Blame> {
  const { repo } = w;
  const known = t.records.revertOf(repo, sha);
  if (known !== undefined) {
    console.info(`train: ${check.name} red on ${repo}@${short(w.sha)} is ${short(sha)}'s, whose revert is #${known}`);
    return "taken";
  }
  let pulls;
  try {
    pulls = await t.github.mergedPullsOf(repo, sha);
  } catch (error) {
    console.warn(`train: the PR of ${repo}@${short(sha)} not read: ${(error as Error).message}`);
    return "waiting";
  }
  const pull = pulls[0];
  if (!pull) {
    console.info(`train: ${check.name} red on ${repo}@${short(w.sha)} came with ${short(sha)}, which no PR merged; a fix order instead`);
    return "order";
  }
  const change = t.records.latestFor(repo, pull.number);
  const culprit: Culprit = { sha, prNumber: pull.number, prUrl: `https://github.com/${repo}/pull/${pull.number}` };
  let opened: { number: number; url: string };
  try {
    opened = await revertPull(t, repo, culprit, revertBody(culprit, check, w));
  } catch (error) {
    console.warn(`train: GitHub didn't revert ${culprit.prUrl}; a fix order instead: ${(error as Error).message}`);
    return "order";
  }
  console.info(`train: ${check.name} red on ${repo}@${short(w.sha)}: bisect blamed ${culprit.prUrl}; revert #${opened.number} opened`);
  t.records.putRevert(repo, sha, check.name, w.sha, opened.number, t.nowMs());
  const projectRef = change?.projectRef ?? w.projectRef;
  await landFirst(t, projectRef, change, opened.url, culprit, check, w);
  const writer = change?.taskId;
  if (change && writer !== undefined) await tellWriter(t, change, writerText(culprit, check, w.base, opened.url));
  await t.wakeLead(projectRef, leadLine(change?.changeId ?? short(sha), culprit, check, w, opened.url, writer));
  return "taken";
}

/** GitHub's revert of the culprit's PR, as a PR of its own. */
async function revertPull(t: Train, repo: string, culprit: Culprit, body: string): Promise<{ number: number; url: string }> {
  const slash = repo.indexOf("/");
  const vars: [string, string][] = [
    ["owner", repo.slice(0, slash)],
    ["name", repo.slice(slash + 1)],
  ];
  const found = (await t.github.graphql(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${culprit.prNumber}){id}}}`, vars)) as any;
  const id = found?.repository?.pullRequest?.id;
  if (typeof id !== "string") throw new Error(`no node id for #${culprit.prNumber}`);
  // GitHub titles it `Revert "<the PR's title>"`.
  const made = (await t.github.graphql(
    "mutation($id:ID!,$body:String!){revertPullRequest(input:{pullRequestId:$id,body:$body}){revertPullRequest{number url}}}",
    [
      ["id", id],
      ["body", body],
    ],
  )) as any;
  const pr = made?.revertPullRequest?.revertPullRequest;
  if (typeof pr?.number !== "number" || typeof pr?.url !== "string") throw new Error("GitHub answered without the revert PR");
  return { number: pr.number, url: pr.url };
}

/**
 * The revert goes on the train at the front of its line: under the culprit's order while it is open (its reviewer
 * reviews it as any PR), else in a new order the lead lands it through.
 */
async function landFirst(t: Train, projectRef: ProjectRef, change: Change | undefined, url: string, culprit: Culprit, check: CheckRun, w: Watch): Promise<void> {
  const ws = change ? t.host.workstream(change.workstreamId) : undefined;
  if (change && ws?.open) {
    try {
      const queued = await t.enqueue(projectRef, { prUrl: url, workstreamId: change.workstreamId });
      t.records.toFront(queued.changeId);
      return;
    } catch (error) {
      console.warn(`train: revert ${url} not enqueued under ${change.workstreamId}; a new order lands it: ${(error as Error).message}`);
    }
  }
  const text =
    `Land the merge train's revert ${url}: \`${check.name}\` failed on ${w.base} after ${culprit.prUrl} merged ` +
    `(${short(culprit.sha)}), and bisecting blamed it. Enqueue the revert with \`change_enqueue\`; the train lands it before any other PR.`;
  try {
    await t.host.openOrder(projectRef, text, `train-revert:${w.repo}:${culprit.sha}`);
  } catch (error) {
    t.warnHourly(["verify.revert_order", w.repo, culprit.sha], (error as Error).message, `train: order for revert ${url} not opened: ${(error as Error).message}`);
  }
}

async function tellWriter(t: Train, change: Change, text: string): Promise<void> {
  try {
    await t.host.messageTask(change.projectRef, TRAIN_BY, change.taskId!, text);
  } catch (error) {
    console.warn(`train: writer ${change.taskId} of reverted ${change.changeId} not messaged: ${(error as Error).message}`);
  }
}

/** Whether the project's PRs merge, then verify (its `mergeMode`). */
export const verifying = (t: Train, projectRef: ProjectRef) => t.host.mergeMode?.(projectRef) === "verify_after";

/**
 * Whether `repo`'s train merges, then verifies: the mode of the bot it is bound to, one for every PR on it, whichever
 * bot sharing the repo it is from (W845).
 */
export const repoVerifying = (t: Train, repo: string, projectRef: ProjectRef) => verifying(t, t.trainProject(repo, projectRef));
