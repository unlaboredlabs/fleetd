---
title: CI for the merge train
description: Choose the checks the merge train waits for, skip slow jobs on batches, and let it regenerate built files.
---

This page is for whoever maintains a repo's CI: how to tune what the [merge train](/docs/merge-train) waits for.

Nothing here is required. With no setup, the train waits for every check and merges only on green CI.

## Pick the checks it waits for {#fast-set}

The train waits for:

- the checks the base branch requires on GitHub;
- the checks listed in `.fleetd/train.json` on the base branch.

```json
{
  "fastChecks": ["lint", "docs"],
  "afterMerge": ["e2e (macos-latest)"]
}
```

- `fastChecks`: more checks to wait for on each PR.
- `afterMerge`: checks to run only after the merge. A failure there opens a fix request instead of blocking the PR.
- `ciAtOnce`: with **Merge, then verify**, how many PRs run CI at once (1 to 16, default 4).

Every key is optional. With no required checks and no list, the train waits for every check.

A check that fails outside this set still blocks the merge, unless it's in `afterMerge`. Checks from other CI
providers (CircleCI, Buildkite, Jenkins) count too.

If you rename a job, update the list in the same PR. The train warns when a listed check never runs.

## Time limits {#ci-time}

- CI gets 45 minutes of running time per commit. Time waiting for runners doesn't count, up to 2 hours.
- A failed check is re-run once. If it passes, the train calls it flaky and carries on.
- CI that runs out of time isn't sent back to the agent. If it finishes green later, the PR goes back in line.

## Skip slow jobs on batches {#scarce-runners}

Some runners are scarce. GitHub runs only 5 macOS jobs at once per account, for example. Run such a job on each PR,
and skip it on the train's batches:

```yaml
jobs:
  macos:
    runs-on: macos-latest
    if: ${{ !endsWith(github.head_ref, 'train/batch') }}
```

The train reads this. A PR joins a batch only once that job passed on the PR itself. The job still runs on main after
each merge, where a failure opens a fix request.

To skip the job when a change doesn't touch it, decide on a cheap runner first:

```yaml
jobs:
  scope:
    runs-on: ubuntu-latest
    outputs:
      macos: ${{ steps.scope.outputs.macos }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2
      - id: scope
        run: |
          if git diff --quiet HEAD^1 HEAD -- src/macos; then
            echo macos=false >> "$GITHUB_OUTPUT"
          else
            echo macos=true >> "$GITHUB_OUTPUT"
          fi
  macos:
    needs: scope
    if: ${{ !cancelled() && !endsWith(github.head_ref, 'train/batch') && needs.scope.outputs.macos != 'false' }}
    runs-on: macos-latest
```

Don't use a workflow-level `paths:` filter for this. A workflow that never starts never reports, and the PR never
joins a batch.

## Run slow jobs only when merging {#next-label}

Instead, a repo can skip expensive jobs on every push, and run them only on what the train is merging now. The train
puts the `fleetd:next` label on that PR, or on the batch.

```yaml
jobs:
  macos:
    runs-on: macos-latest
    if: >-
      github.event_name != 'pull_request'
      || endsWith(github.head_ref, 'train/batch')
      || contains(github.event.pull_request.labels.*.name, 'fleetd:next')
```

Adding a label must also start a run:

1. Don't add `labeled` to the CI workflow's own triggers. Any other label would then replace real results with
   skipped ones.
2. Add a small workflow on `labeled` that reacts only to `fleetd:next` and runs CI on the PR's branch
   (`gh workflow run ci.yml --ref <branch>`).
3. Give the runs it starts their own concurrency group, so they don't cancel the PR's own run.

## Regenerate built files {#regenerate}

Built files, such as a docs site or generated types, conflict on almost every rebase. Commit
`.fleetd/regenerate.json` and the train rebuilds them instead of sending the PR back:

```json
{
  "generated": ["site/docs/", "docs/reference/cli.md"],
  "run": ["npm ci --prefix docs", "npm run build --prefix docs"],
  "migrations": "db/migrations/",
  "timeoutMinutes": 30
}
```

- `generated`: the built files. A path ending in `/` is a folder.
- `run`: the commands that rebuild them, run from the repo root.
- `migrations` (optional): a folder of timestamped `.sql` files. A PR's new migrations get fresh timestamps when they
  sort too early.
- `timeoutMinutes` (optional): 1 to 120, default 30.

When a PR conflicts only in generated files, the train:

1. Rebases it on one of the bot's machines, taking the base's side in generated files.
2. Runs the commands, commits the result, and runs them again to check nothing changes.
3. Pushes to the PR's branch. The new commit is reviewed and tested like any other.

A conflict in any other file goes back to the agent. The commands run with no access to your credentials.
