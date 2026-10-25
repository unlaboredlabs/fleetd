---
title: Merge train
description: "How fleetd merges pull requests: one train per repo, batches of ready PRs in one CI run."
---

How fleetd merges pull requests. Only fleetd merges: each writer's PR goes on its repo's
[merge train](/docs/glossary#merge-train).

## What the train does {#steps}

1. Takes the next ready PR. A PR is ready once its review passes (see [Review](#review)).
2. Has GitHub rebase it onto its base branch, as **Update branch** with rebase does.
3. Waits for CI on that exact commit.
4. Posts the `fleetd/train` status and squash-merges it, pinned to that commit.

A conflict or red CI goes back to the agent that wrote the PR; for red CI, with the failing checks.

fleetd merges only on green CI. A ready PR on a repo with no CI (no GitHub Actions workflow, and no required check but
`fleetd/train`) waits, and its queue entry and `fleetd doctor` say to add one. It goes on by itself once a workflow
exists.

To keep a PR off the train, [hold it](#hold).

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
`origin/HEAD`. A landing ends the claims it matches: the same branch, PR or issue key, or a direct push by the claim's
own author whose message matches its title closely. The project's lead is told once about each landing that didn't
come through the train.

Each host's default merge message names its PR: GitHub, Gitea and Forgejo (`Merge pull request #12`, or a squash
subject ending in `(#12)`), GitLab (`See merge request group/project!12`), Bitbucket (`(pull request #12)`) and
Azure DevOps (`Merged PR 12:`). On GitHub, fleetd also reads the merged PRs, so a squash or rebase merge whose message
doesn't name its PR still counts as one. On other hosts, a merge whose message doesn't name its PR counts as pushed
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

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn. To hold every PR of a repo, label each one.

## What never relaxes {#guarantees}

Batches only save waiting.

- Every PR in a batch is reviewed at its current patch.
- The batch's CI must be green and include the checks the base requires.
- `fleetd/train` is posted only on a commit whose CI passed.
- GitHub's rules on the base decide every merge.
