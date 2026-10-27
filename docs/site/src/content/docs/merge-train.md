---
title: Merge train
description: "How fleetd merges pull requests: one train per repo, batches of ready PRs in one CI run."
---

How fleetd merges pull requests. Only fleetd merges: each writer's PR goes on its repo's
[merge train](/docs/glossary#merge-train).

## What the train does {#steps}

1. Takes the next ready PR. A PR is ready once its review passes (see [Review](#review)).
2. Has GitHub rebase it onto its base branch, as **Update branch** with rebase does.
3. Waits for its [fast set](#fast-set) of checks on that exact commit (see [How long CI may take](#ci-time)).
4. Posts the `fleetd/train` status and squash-merges it, pinned to that commit.

A conflict or red CI goes back to the agent that wrote the PR; for red CI, with the failing checks. A conflict only in
generated files is [regenerated](#regenerate) instead.

GitHub runs no CI on a PR that conflicts with its base. So on every pass the train reads each waiting PR's mergeable
state, and once GitHub says it conflicts, the PR goes back to its agent as `needs_rebase` ("conflicts with main, so
GitHub runs no CI on it") without waiting for its turn, unless the train can [regenerate](#regenerate) it. A waiting PR whose commit has none of its base's required
checks (any check, when the base requires none) 15 minutes after the train first saw it is flagged to its agent and the
lead, once per commit, and keeps its place.

fleetd merges only on green CI. A ready PR on a repo with no CI (no GitHub Actions workflow, and no required check but
`fleetd/train`) waits, and its queue entry and `fleetd doctor` say to add one. It goes on by itself once a workflow
exists.

To keep a PR off the train, [hold it](#hold).

## Which checks it waits for {#fast-set}

The train waits only for the repo's fast set, the same way in every repo:

- the checks the base branch requires, read from its ruleset or branch protection;
- the checks you add in the project's settings.

Each check of the fast set is waited for until it reports, however late its workflow starts; one that never reports
times out by name. The train never waits for any other check. A check outside the fast set that has already failed
when the fast set is green still stops the merge, unless you mark it **after merge only**. A required check is always
in the fast set, since GitHub won't merge without it. A cancelled run of a check that isn't required doesn't count.
With no required check and none added, the train waits for every check, so such a repo still merges only on green
CI. When the train can't read the base's rules or the project's settings, it also waits for every check.

Set the checks in the desktop app under **Settings › Projects › Merge train**, with the `project_settings_set` tool
(`train`), or from a terminal:

```sh
fleetd project set lab-a/storefront --fast-check "test (ubuntu-latest)" --after-merge "e2e (macos-latest)"
```

Each option may repeat, and replaces its list; `none` empties it. The train uses new settings from its next pass.

The checks are the repo's, not the project's: in a project with [several repos](#repos), name the repo
(`project_settings_set` with `repo`) to set its own.

## After the merge {#after-merge}

The train watches the checks it didn't wait for on the commit it merged onto the base. When one fails there, fleetd
opens a fix order for the project, so its lead takes it up like any order: it names the check, the base, the PR that
merged and the run's link. One failure opens one order. The same check failing again on the next merges, while that
order is open, is that order's; once it is closed, a new failure opens a new one. A cancelled run is no failure. The
watch ends once every check on the commit has finished, and after 6 hours at most. With an empty fast set the train
waited for every check, so there is nothing to watch.

A check red on the base holds no merge: each pull request merges on its own checks. Status shows it as a warning, with
whether its fix order is open ([a check red on main](/docs/status#red-main)).

## How long CI may take {#ci-time}

The train gives a commit's CI 45 minutes of running time, counted from when its first check starts. Time the checks
spend queued for runners doesn't count. While every check is still queued, there is a ceiling of 2 hours. If the CI
provider gives no start times, the 45 minutes count from when the train starts waiting.

A red check fails the PR at once, however long the other checks have left. A cancelled check is never a failure: if
a push to the PR cancelled its run, the train takes the new commit instead; otherwise it re-runs the run, or waits. CI that runs out of time is different: the
PR shows `ci_failed` with "CI timed out", the lead is told, and the agent that wrote it isn't asked to push. The train
keeps reading that commit's checks. If they finish green, the PR goes back in the queue ("CI finished after the
timeout; back in the queue") and merges on that run, after the usual rebase if its base moved. If one goes red, the
PR goes back to its agent as for any red CI. If they read cancelled, the train re-runs them twice, then sends the PR
back to its agent to push again. A new push starts over as usual.

When the hub restarts while a PR's CI runs, alone or in a batch, the new hub keeps watching the same run on the same
commit, and merges once it is green. It doesn't rebase the PR or run its CI again.

The train takes a PR whose base is a branch it merges into, such as `main`. A PR based on another open PR's branch is
refused when it is queued: once that PR merges, point it at the same base (`gh pr edit <n> --base main`) and queue it
again.

## Merges outside the train {#outside}

When a PR is merged into a branch the train guards without the train, such as by hand on GitHub, the train notices
within a minute and records `pr.merged_outside`. The next PR in line is rebased onto the new base as usual, so nothing
else changes.

Every commit that reaches a project's base branch is also recorded as a landing (`work.landed`), however it got there:
by the train, from a PR merged outside it, or pushed straight to the branch. fleetd reads this with plain git on the
project's machine, once a minute, so it works on any git host, and on repos with no train. The base is the checkout's
`origin/HEAD`. A landing ends the claims it matches: the same branch or PR, a closing reference to the claim's issue
in its message ("Fixes #12", "Closes SHOP-12"; a mere mention doesn't count), or a direct push by the claim's own
author whose message matches its title closely. The project's lead is told once about each landing that didn't come
through the train. When git on the project's machine can't reach the remote (for SSH, the key has to be in the
`ssh-agent` the node runs with), the lead is told once, with git's reason.

Each host's default merge message names its PR: GitHub, Gitea and Forgejo (`Merge pull request #12`, or a squash
subject ending in `(#12)`), GitLab (`See merge request group/project!12`), Bitbucket (`(pull request #12)`) and
Azure DevOps (`Merged PR 12:`). On GitHub, fleetd also reads the merged PRs, so a squash or rebase merge whose message
doesn't name its PR still counts as one, every commit of a rebase merge included. On other hosts, a merge whose message doesn't name its PR counts as pushed
straight to the branch.

## Review {#review}

Every PR gets one fresh reviewer, which reports blocking findings only. Its verdict is bound to the PR's current
patch. Blocking findings go to the agent that wrote the PR, and the PR waits for its next commit.

### Re-reviews {#re-reviews}

When an approved PR gets a new head, the train compares the PR's own changes with the approved head's: each run of
removed and added lines, and where it sits. A run is unchanged when it has the same lines in the place main's added
and removed lines move it to, and main changed nothing right next to it. Context lines don't count, so main editing a
line near the PR's changes, with an unchanged line between, is no change. The same lines moved elsewhere are.

| What changed | Review |
| --- | --- |
| Nothing: the same patch id, or the same changed lines in the same places after a clean rebase | None. The approval carries over, recorded with the head and reviewer it came from. |
| Only lines next to main's changes: the author resolved conflicts in a rebase | A short review of just those files: the PR's side, main's side and the resolution. |
| Anything else: new commits, or a changed hunk main never touched | A full review, which starts from what changed. |

An approval carries over only from the last reviewed head, and only when that head has no blocking findings open.
If the reviewer whose approval carried over later records blocking findings on its head, every head it carried to is
blocked too. A rebase past commits that landed on main as a squash keeps the approval only with the same patch id.
When the train can't read the commits it compares, the PR gets a full review.

A PR already approved at an earlier patch isn't sent back to wait for its new review. The new review runs while its
CI runs, alone or in a batch, and the merge waits for both. If the review finds a blocker, the PR leaves the train for
its author, and a batch it was in forms again without it, so its code never lands. If CI is green and the review is
still at work after 15 minutes, the PR waits in review out of the train's way, and merges once the review is clean.

A reviewer that couldn't use fleetd's tools, so it couldn't record its verdict, is caught as soon as it ends. Its
queue entry and the train's line say "review tools failed", and the lead hears once. A new reviewer starts by itself
a minute later, then after longer waits up to 15 minutes. It starts at once when any other review records a verdict,
since that shows the tools work again. These don't count toward the one retry a reviewer that ended without a verdict
for other reasons gets.

## Batches {#batches}

When several PRs are ready at once, the train merges them together in one CI run. It takes up to 8 ready PRs in
line that go into the same base branch and whose fast set passed on their own commit, every check of it reported. A
PR whose commit has no checks yet stays out. A cancelled or superseded run, and any check outside the fast set, doesn't
keep a PR out: the batch's own CI decides. Then:

1. It makes its own branch from the base on GitHub, `train/batch` under the project's branch prefix
   (`fleetd/train/batch` by default), and merges each PR into it in order.
2. It opens one PR for them, whose CI runs once.
3. When that PR is green, it posts `fleetd/train` and merges it as one squash.
4. It closes each member PR with a comment linking the batch.

A member counts as merged only while its head is still the one the batch was built from.

| If | The train |
|---|---|
| A PR conflicts with the PRs ahead of it | Leaves it out; it goes again once they land, and a conflict with the base then is [regenerated](#regenerate) or sent back. |
| A PR conflicts with the base | Leaves it out and [regenerates](#regenerate) it, or sends it back to the agent that wrote it. |
| The batch is red, or GitHub refuses to merge its PR | Takes each member alone, so each CI result blames only that PR. |
| A member gets a new push, the `hold` label, or is closed during CI | Drops the batch before the merge, so untested code never lands, and builds a new one without it. |

On every pass, a ready PR the batch left out says why, in its queue entry and in the train's line in the lead's digest:
for example "not in this batch: its own head's `lint` failed", "… still running", or "the batch is full (8 PRs)".

## Generated files {#regenerate}

Built files (a docs site, generated types, reference pages) conflict on almost every rebase. A repo that commits
`.fleetd/regenerate.json` lets the train make them again instead of sending the PR back:

```json
{
  "generated": ["site/docs/", "docs/reference/cli.md"],
  "run": ["cargo run --locked -q -p docsgen", "npm ci --prefix docs", "npm run build --prefix docs"],
  "migrations": "db/migrations/",
  "timeoutMinutes": 30
}
```

| Key | What it is |
|---|---|
| `generated` | The generated files, from the repo root: a path ending in `/` is a directory, anything else one file. |
| `run` | Shell lines run in order from the repo root: the same commands CI checks the generated files with. |
| `migrations` | Optional. A directory of `<UTC stamp>_<name>.sql` files that must sort after the base's newest. |
| `timeoutMinutes` | Optional, 1–120, default 30. |

The train reads the file from the base branch, never from the PR. When a PR conflicts with its base, or adds a
migration that sorts at or before the base's newest, the train:

1. Picks the node holding the repo's checkout. It must be online and take agent work; the hub's own machine runs
   none of this. With no such node, the PR goes back to its agent as before.
2. Fetches the base and the PR there, and rebases the PR onto `origin/<base>` in a scratch worktree.
3. Takes the base's side of each conflict in a generated file. A conflict in any other file stops it.
4. Gives the PR's new migrations fresh UTC stamps, in order, when one sorts too early.
5. Runs every `run` line, commits what changed as its own commit, then runs them all again: the second run must change
   nothing, and no run may change a file outside `generated`.
6. Pushes the result to the PR's branch, only if the branch is still where it was.

The commands run as the node's user, as agent work does there, but reach for no credential: their HOME is a scratch
directory, git under them has no credential helper and no hooks, and they get no SSH agent. The fetch and the push are
separate steps. Programs are found on the node's PATH, the one its agent sessions get; a missing one is named in the
reason. The commands get `FLEETD_REGENERATE_CACHE`, a directory in the node's own home kept between runs
(`~/.fleetd/node/cache/regenerate/<owner>-<name>`, or under the node's `--home`), for build caches such as
`CARGO_TARGET_DIR`. One regeneration runs at a time in a checkout; the others wait their turn. Meanwhile the PR keeps
its place in line, its queue entry says the train is regenerating it, and the train goes on with
the others. Once the train pushes, the agent that wrote the PR is told, so it builds on the train's commit instead of
overwriting it.

The pushed commit is a new patch, so it is reviewed and tested like any push. When any step fails, the timeout passes,
or there is nothing to regenerate, the PR goes back to its
agent as `needs_rebase`, with the reason: for example "conflicts with main, and the train could not regenerate its
generated files: it conflicts with main in src/app.rs, which is not a generated file".

## CI runners are scarce {#scarce-runners}

GitHub doesn't start queued jobs in order. When a repo has few runners of a kind, such as macOS, every agent push
queues a full CI run, and the batch PR can wait behind them. So the train labels what it is merging now with
`fleetd:next`:

- the batch PR;
- or a PR it merges alone, before it rebases that PR, so the rebase's CI run already sees the label.

PRs waiting behind it get no label: the run the label starts would cancel their own CI and take the runners the batch
needs. The train takes the label off once a PR merges or leaves the queue, and creates the label if the repo doesn't
have it.

To use it, run your expensive jobs only on `main`, on the batch branch, on manual runs, and on labelled PRs:

```yaml
jobs:
  macos:
    runs-on: macos-latest
    if: >-
      github.event_name != 'pull_request'
      || endsWith(github.head_ref, 'train/batch')
      || contains(github.event.pull_request.labels.*.name, 'fleetd:next')
```

A skipped job still reports, so it can stay a required check.

Adding the label must also start a run. Don't add `labeled` to that workflow's `pull_request` types: a run for any other
label would replace the PR's real check results with skipped ones. Instead, use a small workflow on `labeled` that
reacts to `fleetd:next` only and runs the CI workflow on the PR's branch (`gh workflow run ci.yml --ref <branch>`), as
fleetd's own `.github/workflows/macos-label.yml` does.

Give the runs that workflow starts a concurrency group of their own, not the PR's. GitHub's ruleset reads a required
check from the PR's own run on the head, not from the newest run of it. A started run that cancels the PR's own run on
the same head leaves that check reading cancelled, and GitHub refuses the merge even though the started run passed.
The train guards against it: before it merges, it re-runs any workflow run on the head whose required check reads
cancelled, and waits for it again. A run still cancelled after 2 re-runs is red.

The train reads the repo's workflows to see which checks the label runs. It looks for jobs whose `if:` names
`fleetd:next`, in a workflow that reacts to the label being added, or in one that such a workflow starts with
`gh workflow run`. For a PR it merges alone, such a check skipped before the label went on never counts as passing.
The train waits for the run the label starts. If GitHub refuses the label, or no run replaces the skipped check within
3 minutes, the train keeps waiting, retries the label, and tells the lead once: "CI didn't start for the labelled PR".

Every other skipped check counts as GitHub counts it: as passing. That covers checks in workflows the label never
runs, and jobs a workflow skips on purpose. In a repo whose workflows don't run anything on the label, nothing waits,
and a refused label is only one line in the hub's log. If the workflows can't be read, the train uses the last answer
it had for the repo; with none, any skipped check holds the PR for 3 minutes, then counts.

When the checks of the batch, or of a PR merging alone, have been queued for more than 5 minutes, its queue entry and
the lead's digest say "waiting for CI runners (N queued)". Once a runner takes them, the entry's earlier note comes
back.

## Several repos {#repos}

A project can hold several repos. Each repo has its own train, so its PRs line up and merge on their own, apart from
the other repos' PRs. The train for a repo reads its rules and its branch prefix from that repo's checkout. If two
projects share a repo, they share its train and its rules.

A project with two or more repos takes only PRs from its repos. A PR from any other repo is refused, and the refusal
lists the project's repos. A project with one repo, or none, takes PRs from any repo, as before, such as a fork's
upstream.

## Merge order {#order}

When one PR needs another merged first, such as a client that needs a new API, the lead enqueues it with `after`:

```json
{ "prUrl": "https://github.com/acme/web/pull/12", "after": ["https://github.com/acme/api/pull/40"] }
```

The PRs can be in the same repo or any other. Enqueuing a PR that is already in line adds the new `after` PRs to the
ones it has. Once the train is merging it (rebasing, in CI or merging), that is refused: add the `hold` label to keep it
from landing first. The train also refuses an order that loops back, where the upstream PR already waits on this one.

The downstream PR is reviewed and checked as usual. Once it is ready, it stays in line, held with
"waiting on acme/api#40" and the reason. When the upstream PR merges, the downstream PR's train takes it on its next
pass.

If the upstream PR fails CI or review, is refused, or leaves the train without merging, the downstream PR stays
held. The lead is told once, with the reason. Once the upstream PR is fixed and merges, the downstream PR goes on its
own. A PR merged outside the train also counts as merged.

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn. To hold every PR of a repo, label each one.

## What never relaxes {#guarantees}

Batches only save waiting.

- Every PR in a batch is reviewed at its current patch, or carries an approval of the same changed lines.
- The batch's fast set must pass, and it always includes the checks the base requires.
- `fleetd/train` is posted only on a commit whose CI passed.
- GitHub's rules on the base decide every merge.
