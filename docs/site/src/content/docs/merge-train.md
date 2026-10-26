---
title: Merge train
description: "How fleetd merges pull requests: one train per repo, batches of ready PRs in one CI run."
---

How fleetd merges pull requests. Only fleetd merges: each writer's PR goes on its repo's
[merge train](/docs/glossary#merge-train).

## What the train does {#steps}

1. Takes the next ready PR. A PR is ready once its review passes (see [Review](#review)).
2. Has GitHub rebase it onto its base branch, as **Update branch** with rebase does.
3. Waits for CI on that exact commit (see [How long CI may take](#ci-time)).
4. Posts the `fleetd/train` status and squash-merges it, pinned to that commit.

A conflict or red CI goes back to the agent that wrote the PR; for red CI, with the failing checks.

fleetd merges only on green CI. A ready PR on a repo with no CI (no GitHub Actions workflow, and no required check but
`fleetd/train`) waits, and its queue entry and `fleetd doctor` say to add one. It goes on by itself once a workflow
exists.

To keep a PR off the train, [hold it](#hold).

## How long CI may take {#ci-time}

The train gives a commit's CI 45 minutes of running time, counted from when its first check starts. Time the checks
spend queued for runners doesn't count. While every check is still queued, there is a ceiling of 2 hours. If the CI
provider gives no start times, the 45 minutes count from when the train starts waiting.

A red check fails the PR at once, however long the other checks have left. CI that runs out of time is different: the
PR shows `ci_failed` with "CI timed out", the lead is told, and the agent that wrote it isn't asked to push. The train
keeps reading that commit's checks. If they finish green, the PR goes back in the queue ("CI finished after the
timeout; back in the queue") and merges on that run, after the usual rebase if its base moved. If one goes red, the
PR goes back to its agent as for any red CI. A new push starts over as usual.

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
patch: a rebase that keeps the patch keeps the review, and a new commit gets a new reviewer, who starts from what
changed. Blocking findings go to the agent that wrote the PR, and the PR waits for its next commit.

## Batches {#batches}

When several PRs are ready at once, the train merges them together in one CI run. It takes up to 8 ready PRs in
line that go into the same base branch and are green on their own commit. Then:

1. It makes its own branch from the base on GitHub, `train/batch` under the project's branch prefix
   (`fleetd/train/batch` by default), and merges each PR into it in order.
2. It opens one PR for them, whose CI runs once.
3. When that PR is green, it posts `fleetd/train` and merges it as one squash.
4. It closes each member PR with a comment linking the batch.

A member counts as merged only while its head is still the one the batch was built from.

| If | The train |
|---|---|
| A PR conflicts with the base or the PRs ahead of it | Leaves it out and sends it back to the agent that wrote it. |
| The batch is red, or GitHub refuses to merge its PR | Takes each member alone, so each CI result blames only that PR. |
| A member gets a new push, the `hold` label, or is closed during CI | Drops the batch before the merge, so untested code never lands, and builds a new one without it. |

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

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn. To hold every PR of a repo, label each one.

## What never relaxes {#guarantees}

Batches only save waiting.

- Every PR in a batch is reviewed at its current patch.
- The batch's CI must be green and include the checks the base requires.
- `fleetd/train` is posted only on a commit whose CI passed.
- GitHub's rules on the base decide every merge.
