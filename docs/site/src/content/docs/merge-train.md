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
within a minute. It records `pr.merged_outside` and tells the project's lead. The next PR in line is rebased onto the
new base as usual, so nothing else changes.

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
queues a full CI run, and the batch PR can wait behind them. So the train labels what it merges next with
`fleetd:next`:

- the batch PR;
- a PR it merges alone, before it rebases that PR, so the rebase's CI run already sees the label;
- the next 3 ready PRs in line.

It takes the label off once a PR merges, leaves the queue, or falls behind others. It creates the label if the repo
doesn't have it. Labelling never blocks a merge: if GitHub refuses it, the train logs it once and goes on.

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

The train never counts a skipped check as passing for a PR it is about to merge alone. If that PR's CI is from before
the label, any check skipped back then holds the merge for up to 3 minutes. If the label's run starts in that time,
the train waits for it.

When the batch's checks have been queued for more than 5 minutes, its queue entry and the lead's digest say
"waiting for CI runners (N queued)".

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn. To hold every PR of a repo, label each one.

## What never relaxes {#guarantees}

Batches only save waiting.

- Every PR in a batch is reviewed at its current patch.
- The batch's CI must be green and include the checks the base requires.
- `fleetd/train` is posted only on a commit whose CI passed.
- GitHub's rules on the base decide every merge.
