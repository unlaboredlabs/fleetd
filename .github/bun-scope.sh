#!/usr/bin/env bash
# Whether bun.yml's `bun (experimental)` job has work: writes run=true or run=false to $GITHUB_OUTPUT. Without work the
# job still runs and reports success in seconds, so as one of .fleetd/train.json's fastChecks it reports on every PR and
# batch, and a PR without a Bun change never waits for a check that never comes. HEAD^1 is the base for a PR's merge
# commit (the train's batch PR included); a manual run from a branch compares with its merge base on main. No base to
# compare with runs it. As .github/rust-scope.sh does for ci.yml's Rust jobs.
#
# The paths: the experiment alone, so Rust PRs never wait on it or keep it current. It reads more (gen:check reads the
# Rust hub, contracts and migrations; the job runs crates/fleetd's session_host test and the lab): a change there that
# breaks it shows on main, which always runs it in full.
set -euo pipefail

paths=(experimental/bun .github/workflows/bun.yml .github/bun-scope.sh)

run=true
if [ "$GITHUB_EVENT_NAME" != push ] && [ "$GITHUB_REF" != refs/heads/main ]; then
  base=$(git rev-parse -q --verify HEAD^1 || true)
  if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; then
    base=$(git merge-base origin/main HEAD || true)
  fi
  if [ -n "$base" ] && git diff --quiet "$base" HEAD -- "${paths[@]}"; then
    run=false
    echo "::notice::no Bun change: this job has no work"
  fi
fi
echo "run=$run" | tee -a "$GITHUB_OUTPUT"
