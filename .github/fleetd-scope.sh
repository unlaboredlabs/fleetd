#!/usr/bin/env bash
# Whether ci.yml's `fleetd` job has work: writes run=true or run=false to $GITHUB_OUTPUT. Without work the job still
# runs and reports success in seconds, so it reports on every PR and batch, and a skip never stands in for it. Main
# always runs it. HEAD^1 is the base for a PR's merge commit (the train's batch PR included); a manual run from a branch
# compares with its merge base on main. No base to compare with runs it.
#
# The paths: everything its steps read. Add one here when a test starts reading a file outside them.
set -euo pipefail

paths=(
  fleetd .fleetd .github/workflows/ci.yml .github/fleetd-scope.sh .github/migrations-check.mjs
  # The wire contract and its schemas; the setup steps the docs generator checks; the installer a test runs.
  app/desktop/src/shared/contracts app/desktop/fixtures/setup site/install.sh
  # The lab scenarios.
  tests/lab
  # The docs pages generated from the code.
  docs/site/src/content/docs/reference/cli.md docs/site/src/content/docs/reference/agent-tools.md
  docs/site/src/content/docs/what-agents-are-told.md
)

run=true
if [ "$GITHUB_EVENT_NAME" != push ] && [ "$GITHUB_REF" != refs/heads/main ]; then
  base=$(git rev-parse -q --verify HEAD^1 || true)
  if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
    base=$(git merge-base origin/main HEAD || true)
  fi
  if [ -n "$base" ] && git diff --quiet "$base" HEAD -- "${paths[@]}"; then
    run=false
    echo "::notice::no fleetd change: this job has no work"
  fi
fi
echo "run=$run" | tee -a "$GITHUB_OUTPUT"
