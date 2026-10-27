#!/usr/bin/env bash
# Prints the commit a push run on main scopes its job against: the head of the newest other push run on main of
# <workflow> whose jobs named <prefix>... all finished, passed or failed. A newer push to main cancels the older runs
# of desktop-qa.yml and ci.yml's ios-sessions, so comparing with HEAD^1 would leave out what a cancelled run never
# ran; comparing with the last run that did keeps every change covered. Prints nothing when there is none or the API
# fails: the caller falls back to HEAD^1.
#
# Usage: main-base.sh <workflow file> <job name prefix>, with GH_TOKEN, GH_REPO and GITHUB_RUN_ID set.
set -uo pipefail
workflow=$1
prefix=$2
gh api "repos/$GH_REPO/actions/workflows/$workflow/runs?branch=main&event=push&per_page=30" \
  -q ".workflow_runs[] | select(.id != $GITHUB_RUN_ID) | \"\(.id) \(.head_sha)\"" 2>/dev/null |
  while read -r run sha; do
    covered=$(gh api "repos/$GH_REPO/actions/runs/$run/jobs?per_page=100" -q "[.jobs[] | select(.name | startswith(\"$prefix\"))]
      | length > 0 and all(.conclusion == \"success\" or .conclusion == \"failure\")" 2>/dev/null) || exit 0
    if [ "$covered" = true ]; then
      echo "$sha"
      exit 0
    fi
  done
