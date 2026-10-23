---
title: Merge train
description: "How fleetd merges pull requests: one train per repo, batches of disjoint PRs in one CI run, stacked PRs tested ahead."
---

How fleetd merges pull requests. Only fleetd merges: each writer's PR goes on its repo's
[merge train](/docs/glossary#merge-train).

## What the train does {#steps}

1. Takes the next ready PR. A PR is ready once its reviews pass (see [Tiers](#tiers)).
2. Rebases it onto its base branch.
3. Waits for CI on that exact commit.
4. Posts the `fleetd/train` status and squash-merges it, pinned to that commit.

A conflict or red CI goes back to the agent that wrote the PR, with the paths or failing checks.

A PR with no CI merges on fleetd's own checks, and the merge says so. "No CI" means the base requires no check but
`fleetd/train`, and no workflow's `on:` can run for the PR.

To pause a repo's train, use the `train_freeze` tool.

## Tiers {#tiers}

A PR's [tier](/docs/glossary#tier) sets the reviews it needs, each bound to its current patch:

| Tier | Reviews before the train takes it |
|---|---|
| S | none |
| M | one clean review |
| L | two clean reviews and a verifier |

## Batches {#batches}

When several PRs are ready at once, the train merges them together in one CI run. It takes the first PR in line and
adds the ones after it that:

- go into the same base branch;
- change none of the same files (lockfiles such as `Cargo.lock` or `package-lock.json` aside);
- are green on their own commit.

Then:

1. It squashes them onto the base, in order, on its own branch: `train/batch` under the project's branch prefix
   (`fleetd/train/batch` by default).
2. It opens one PR for them, whose CI runs once.
3. When that PR is green, it posts `fleetd/train` and merges it as one squash.
4. It closes each member PR with a comment linking the batch.

A member counts as merged for done-when checks only while its head is still the one the batch was built from.

| If | The train |
|---|---|
| The batch is red | Drops the last member and tries again. The dropped PR later goes alone, so its CI result blames only it. |
| A member gets a new push, the `hold` label, or is closed during CI | Leaves it out before the merge, so untested code never lands. |
| GitHub refuses to merge a batch PR (for example, every PR needs an approving review) | Stops batching that repo until the hub restarts. |

A batch holds at most 4 PRs. Change it with `FLEETD_TRAIN_BATCH_MAX` in the hub's environment; `1` turns batches off.
See [Hub environment](/docs/config-and-files#env).

## Stacked PRs {#stacks}

A PR whose base is another queued PR's branch waits until that parent lands. It never merges into the parent's branch.

While it waits, the train tests it ahead:

1. It rebases the PR onto the parent's base, parent included, on `train/stack-<n>` under the branch prefix.
2. It opens a draft PR there for its CI.
3. The result shows on the stacked PR as the `fleetd/stack` status, which nothing requires. A red result also goes to
   the PR's author, so it can be fixed before the parent lands.

When the parent lands, the train points the stacked PR at the parent's base, rebases it onto the parent's squash, and
runs CI again before merging. Then it closes the draft PR.

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train from taking it, alone or in a batch. Remove the label and it goes in
its turn.

## What never relaxes {#guarantees}

Batches and stacks only save waiting.

- Every PR in a batch is reviewed at its current patch.
- The batch's CI must be green and include the checks the base requires.
- `fleetd/train` is posted only on a commit whose CI passed.
- GitHub's rules on the base decide every merge.
- A stacked PR's early result never replaces the CI on the commit that merges.
