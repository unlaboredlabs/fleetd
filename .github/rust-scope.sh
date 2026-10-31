#!/usr/bin/env bash
# Whether ci.yml's Rust jobs (rust-lint, rust-docs, rust (linux), rust (darwin)) have work: writes run=true or run=false
# to $GITHUB_OUTPUT. Without work each job still runs and reports success in seconds, so `rust (linux)` stays a required
# check that a skip never stands in for. Main always runs them (its pushes save the caches and the site's `fleetd
# help`). HEAD^1 is the base for a PR's merge commit (the train's batch PR included); a manual run from a branch
# compares with its merge base on main. No base to compare with runs them.
#
# The paths: everything the Rust build, its tests, docsgen and the lab scenarios read. Add one here when a test starts
# reading a file outside them.
set -euo pipefail

paths=(
  crates Cargo.toml Cargo.lock .config .fleetd .github/workflows .github/rust-scope.sh .github/migrations-check.mjs
  # The generated contracts and setup steps that tests check are current; the installer a test runs.
  app/desktop/src/shared/contracts app/desktop/fixtures/setup site/install.sh
  # The lab scenarios, and libsodium for the seal test.
  tests/lab
  # The docs pages docsgen writes (crates/docsgen/src/main.rs).
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
    echo "::notice::no Rust change: this job has no work"
  fi
fi
echo "run=$run" | tee -a "$GITHUB_OUTPUT"
