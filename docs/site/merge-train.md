---
title: Merge train
section: Using fleetd
order: 54
description: How fleetd merges PRs: one train per repo, batches of disjoint PRs in one CI run, stacked PRs tested ahead.
---

Only fleetd merges. Each writer's PR goes on its repo's train, which rebases it onto its base, waits for CI on that
exact head, posts the `fleetd/train` status and squash-merges it pinned to that head. A conflict or red CI goes back to
the agent that wrote the PR, with the paths or failing checks. A repo with no CI at all (no workflows, no required
checks) merges on fleetd's own checks, and the merge says so. Freeze a repo's train with `train_freeze`.

A PR is ready for the train once its reviews pass: tier S needs none, M one clean review, L two plus a verifier, each
bound to the PR's current patch. A PR body needs a `Source:` line naming what it serves.

## Batches

When several PRs are ready at once, the train merges them together in one CI run instead of one after another.
It takes the first PR in line and adds the ones after it that:

- go into the same base branch,
- change none of the same files (lockfiles such as `Cargo.lock` or `package-lock.json` aside),
- are green on their own head.

It squashes them onto the base in order on a branch of its own, `train/batch` under the project's branch prefix
(`fleetd/train/batch` by default; see `branchPrefix` in [the policy file](config-and-files.md)), and opens one PR for them,
whose CI runs once. When that PR is green, the train posts `fleetd/train` on it and merges it as one squash. Each
member PR is then closed with a comment linking the batch. It counts as merged for done-when checks only while its
head is still the one the batch was built from, as the batch PR records.

If the batch is red, the train drops the last member and tries again with the rest. The dropped PR later goes on its
own, so it's the only one whose CI result blames it. A member that gets a new push, the `hold` label or is closed while
the batch is in CI is left out before the merge, so untested code never lands.

The most PRs in one batch is 4. Set `FLEETD_TRAIN_BATCH_MAX` in the hub's environment to change it; `1` turns batches
off, so each PR goes alone. If GitHub refuses to merge a batch PR (for example, the base requires an approving review
on every PR), the train stops batching that repo until the hub restarts.

## Stacked PRs

A PR whose base is another queued PR's branch waits until that parent lands; it never merges into the parent's
branch. Meanwhile the train tests it ahead: it rebases the PR onto the parent's base, parent included, on
`train/stack-<n>` under the branch prefix, and opens a draft PR there for its CI. The result shows on the stacked PR as the
`fleetd/stack` status, which nothing requires. A red result also goes to the PR's author, so it can be fixed before
the parent lands.

When the parent lands, the train points the stacked PR at the parent's base, rebases it onto the parent's squash and
runs CI on it again before merging, since the base wants an up-to-date branch. The draft PR is then closed.

## Holding a PR

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn.

## What never relaxes

Batches and stacks only save waiting. Every PR in a batch is reviewed at its current patch, the batch's CI must be
green and include the checks the base requires, `fleetd/train` is posted only on a head whose CI passed, and GitHub's
rules on the base decide every merge. A stacked PR's early result never replaces the CI on the head that merges.
