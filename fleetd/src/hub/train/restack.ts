// A stacked PR whose base landed. A PR based on another PR's branch keeps pointing at that branch after the PR under
// it merges, where it conflicts with the old branch (the train rebased that one before it landed) and GitHub runs no
// CI on it. The train points it at the landed PR's base instead, the default branch, and rebases only its own commits
// onto it: `git rebase --onto origin/<base> <the landed head>` in a scratch worktree of the repo's checkout, on its
// node, which skips the lower PR's commits it still holds, rewritten or not. The result is pushed with a lease on the
// head the train last saw, so a writer's newer push is never overwritten. A conflict, or a rebase the train can't run
// here, goes back to the writer with the command to run; either way the writer hears what happened.
import type { Change, ChangeState } from "../../shared/contracts.ts";
import { GhError, githubWhy, type Pull } from "./github.ts";
import type { NodeRun } from "./host.ts";
import { defaultBase, waitingOn } from "./next.ts";
import { errorText } from "./records.ts";
import { short } from "./rules.ts";
import { TRAIN_BY, type Train } from "./service.ts";

const GIT_TIMEOUT_SEC = 300;
const SAID = "fleetd-restack: ";
const CONFLICT = 4;
/** The states of a Change whose PR the train may point elsewhere and rebase: in line, or back with its writer. */
const STATES: ChangeState[] = ["queued", "reviewing", "ready", "needs_rebase"];

/** Where a PR on a landed or gone branch goes now: `onto`, past `upstream`, the head that landed (none when unknown). */
export type Moved = { base: string; onto: string; upstream?: string; why: string };

/** The script that rebases the PR's own commits, on the node in the repo's checkout. */
const SCRIPT = `set -u
onto=refs/remotes/origin/$1 upstream=$2 head=$3
[ -n "$upstream" ] || upstream=$onto
say() { printf 'fleetd-restack: %s\\n' "$*"; }
refuse() { say "$*"; exit 3; }
g() {
  git -c user.name="fleetd merge train" -c user.email=train@fleetd.invalid -c commit.gpgsign=false \\
    -c core.hooksPath=/dev/null -c rerere.enabled=false "$@"
}
git cat-file -e "$head^{commit}" 2>/dev/null || refuse "the PR's head $head is not in the checkout"
git cat-file -e "$upstream^{commit}" 2>/dev/null || refuse "$upstream is not in the checkout"
git rev-parse -q --verify "$onto" >/dev/null || refuse "origin/$1 is not in the checkout"
root=$(pwd)
tmp=$(mktemp -d) || refuse "no scratch directory"
work=$tmp/tree
trap 'cd "$root"; git worktree remove --force "$work" >/dev/null 2>&1; git worktree prune; rm -rf "$tmp"' EXIT
git worktree add -q --detach "$work" "$head" >"$tmp/log" 2>&1 || refuse "no scratch worktree: $(tail -n 1 "$tmp/log")"
cd "$work" || refuse "no scratch worktree"
if ! g rebase -q --onto "$onto" "$upstream" >"$tmp/log" 2>&1; then
  files=$(git diff --name-only --diff-filter=U | head -n 5 | tr '\\n' ' ')
  [ -n "$files" ] || refuse "the rebase stopped: $(tail -n 1 "$tmp/log")"
  say "\${files% }"
  exit 4
fi
say "done $(git rev-parse HEAD)"
`;

/**
 * The Change whose PR `pull` is based on a branch that landed, or is gone: pointed at its new base and rebased onto it,
 * or back with its writer. Whether it was (or GitHub's refusal held it this pass); false while its base is live.
 */
export async function restack(t: Train, change: Change, pull: Pull): Promise<boolean> {
  if (!STATES.includes(change.state) || pull.head.sha.toLowerCase() !== change.headSha) return false;
  try {
    const moved = await landedBase(t, change, pull);
    if (!moved) return false;
    await t.github.editPull(change.repo, change.prNumber, [["base", moved.onto]]);
    console.info(`train: ${change.changeId}'s PR on ${moved.base} pointed at ${moved.onto}: ${moved.why}`);
    await rebaseOnto(t, change, pull, moved);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    const why = errorText(githubWhy(error));
    t.update(change.changeId, STATES, (c) => ({ ...c, lastError: why }));
  }
  t.kick(change.repo);
  return true;
}

/** Where the PR goes now: its base's PR merged (by the train or a person), or its base branch is gone. */
export async function landedBase(t: Train, change: Change, pull: Pull): Promise<Moved | undefined> {
  const repo = change.repo;
  const base = pull.base.ref;
  const main = await defaultBase(t, repo);
  // Still waiting on a PR under it: nothing landed yet, and GitHub isn't asked.
  if (base === main || (await waitingOn(t, change)) !== undefined) return undefined;
  const tip = await t.github.branchTip(repo, base);
  const landed = (await t.github.pullsFor(repo, base, "closed"))[0];
  if (landed && (landed.merged_at != null || t.records.latestFor(repo, landed.number)?.state === "merged")) {
    const url = `https://github.com/${repo}/pull/${landed.number}`;
    const prefix = await t.host.branchPrefix(change.projectRef);
    // A long-lived branch that once merged (a `develop`) is no landed stack: only a writer's branch, or one it waits on.
    const stacked = (change.after ?? []).includes(url) || (prefix !== undefined && base.startsWith(prefix));
    // Pushed to again since it landed, the branch is in use.
    if (stacked && (tip === undefined || tip === landed.head.sha.toLowerCase())) {
      return { base, onto: landed.base.ref, upstream: landed.head.sha.toLowerCase(), why: `its base ${base} landed in #${landed.number}` };
    }
  }
  return tip === undefined ? { base, onto: main, why: `its base ${base} is gone` } : undefined;
}

/**
 * The PR's own commits onto `moved.onto`, pushed. A conflict goes back to its writer; a rebase the train can't run here
 * (no checkout, a fork's branch) leaves it in line, for GitHub's rebase as any PR's. The writer hears either way.
 */
async function rebaseOnto(t: Train, change: Change, pull: Pull, moved: Moved): Promise<void> {
  const { onto, upstream = "" } = moved;
  const branch = pull.head.ref;
  const head = change.headSha;
  let outcome: Outcome;
  if (pull.head.repo?.full_name.toLowerCase() !== change.repo.toLowerCase()) outcome = { kind: "failed", why: "its branch is in another repo" };
  else {
    const checkout = t.trainCheckout(change.repo, change.projectRef);
    try {
      // One at a time in a checkout, with its regenerations: two would race for its refs and its worktrees.
      outcome = await t.regenTurns.of(`${checkout.machineId}/${checkout.projectId}`).run(() => rebaseOnNode(t, change, branch, moved));
    } catch (error) {
      outcome = { kind: "failed", why: (error as Error).message };
    }
  }
  // Its writer pushed meanwhile (the lease refused the train's push): that head goes through as any push does.
  if (outcome.kind !== "rebased" && (await t.github.pull(change.repo, change.prNumber)).head.sha.toLowerCase() !== head) return;
  if (outcome.kind === "conflict") {
    const redo = `\`git fetch origin && git rebase --onto origin/${onto} ${upstream || `origin/${onto}`}\``;
    const why = `conflicts with ${onto} in ${outcome.files} once the train pointed it there (${moved.why}): rebase its own commits with ${redo}`;
    // Already back with its writer for the old base's conflict: the reason it is back now, and the writer hears it.
    const parked = t.update(change.changeId, ["needs_rebase"], (c) => ({ ...c, lastError: errorText(why) }));
    if (parked) await t.tellAuthor(parked, `the merge train could not rebase it: it ${why}`);
    else await t.needsRebase(change, why);
    return;
  }
  let note: string;
  let rebase: string;
  if (outcome.kind === "failed") {
    console.info(`train: ${change.changeId} not rebased onto ${onto} by the train: ${outcome.why}`);
    note = `${moved.why}, so it goes into ${onto} now; the train could not rebase it itself (${outcome.why})`;
    rebase = `The train could not rebase it itself (${outcome.why}), so GitHub rebases it, as any PR; if that conflicts, it comes back to you.`;
  } else if (outcome.sha === head) {
    note = `${moved.why}, so it goes into ${onto} now`;
    rebase = "Its commits were already on it, so its branch is as you left it.";
  } else {
    const sha = outcome.sha;
    t.pushed.set(change.changeId, [sha, t.nowMs()]);
    note = `${moved.why}, so it goes into ${onto} now, rebased onto it as ${short(sha)}`;
    rebase =
      `The train rebased your own commits onto origin/${onto} and pushed ${short(sha)} to ${branch}, so you don't need to. If you push ` +
      `to this PR again, first run \`git fetch origin\` and put only your commits since ${head} on top of origin/${branch} ` +
      `(\`git rebase --onto origin/${branch} ${head}\`). Never force-push over the train's commit.`;
  }
  t.update(change.changeId, STATES, (c) => ({ ...c, lastError: errorText(note) }));
  if (change.taskId === undefined) return;
  const text = `The merge train moved your PR ${change.prUrl} onto ${onto}: ${moved.why}, so it now goes into ${onto}. ${rebase}`;
  try {
    await t.host.messageTask(change.projectRef, TRAIN_BY, change.taskId, text);
  } catch (error) {
    t.warnHourly([`train: author ${change.taskId} not told of the move of ${change.changeId}`], (error as Error).message, `train: author ${change.taskId} not told of the move of ${change.changeId}: ${(error as Error).message}`);
  }
}

/** Whether the Change's conflict is with the branch of a PR it waits on, which the train may have rewritten: it moves once that one lands. */
export async function waitsBelow(t: Train, change: Change, pull: Pull): Promise<boolean> {
  return pull.base.ref !== (await defaultBase(t, change.repo)) && (await waitingOn(t, change)) !== undefined;
}

type Outcome = { kind: "rebased"; sha: string } | { kind: "conflict"; files: string } | { kind: "failed"; why: string };

/** Fetch, rebase, push, each on the checkout's node. */
async function rebaseOnNode(t: Train, change: Change, branch: string, moved: Moved): Promise<Outcome> {
  const checkout = t.trainCheckout(change.repo, change.projectRef);
  const root = t.host.projectRoot(checkout);
  if (root === undefined) return { kind: "failed", why: "the repo's checkout is gone" };
  const { onto, upstream = "" } = moved;
  const head = change.headSha;
  const fetch = ["git", "fetch", "-q", "--no-tags", "origin", `+refs/heads/${onto}:refs/remotes/origin/${onto}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
  // The landed head, by its SHA: GitHub serves a PR's commits after its branch is gone.
  if (upstream !== "") fetch.push(upstream);
  let run = await t.host.nodeRun(checkout, root, fetch, GIT_TIMEOUT_SEC);
  if (run.exitCode !== 0) return { kind: "failed", why: `fetching from origin failed: ${said(run)}` };
  run = await t.host.nodeRun(checkout, root, ["sh", "-c", SCRIPT, "fleetd-restack", onto, upstream, head], GIT_TIMEOUT_SEC);
  const out = said(run);
  if (run.exitCode === CONFLICT) return { kind: "conflict", files: out };
  const sha = run.exitCode === 0 && out.startsWith("done ") ? out.slice(5).trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return { kind: "failed", why: run.exitCode === undefined ? `the rebase did not finish: ${out}` : out };
  if (sha === head) return { kind: "rebased", sha };
  const push = ["git", "push", "-q", `--force-with-lease=refs/heads/${branch}:${head}`, "origin", `${sha}:refs/heads/${branch}`];
  run = await t.host.nodeRun(checkout, root, push, GIT_TIMEOUT_SEC);
  if (run.exitCode !== 0) return { kind: "failed", why: `pushing to the PR failed: ${said(run)}` };
  return { kind: "rebased", sha };
}

/** What a node command's output says: its last `fleetd-restack:` line, else its last line. */
function said(run: NodeRun): string {
  const lines = run.outputTail.split("\n").map((l) => l.trim());
  const ours = [...lines].reverse().find((l) => l.startsWith(SAID));
  const text = ours !== undefined ? ours.slice(SAID.length) : ([...lines].reverse().find((l) => l !== "") ?? "no output");
  return [...text].slice(0, 500).join("");
}
