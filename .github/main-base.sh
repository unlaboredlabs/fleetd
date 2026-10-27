#!/usr/bin/env bash
# Prints the commit a push run on main scopes its job against: the head of the newest other push run on main of
# <workflow> whose jobs named <prefix>... all finished, passed or failed. A newer push to main cancels the older runs
# of desktop-qa.yml and ci.yml's ios-sessions, so comparing with HEAD^1 would leave out what a cancelled run never
# ran; comparing with the last run that did keeps every change covered. Pages back through all of main's push runs.
# Prints nothing when there is none or the API fails: the caller then runs the job in full. A third argument names one
# more conclusion that counts as finished: `skipped` for ci.yml's ios sessions, which macos-scope skips on a push that
# didn't touch it, after comparing with this same script's answer, so the run is covered all the same.
#
# Usage: main-base.sh <workflow file> <job name prefix> [conclusion], with GH_TOKEN, GH_REPO and GITHUB_RUN_ID set.
set -uo pipefail
workflow=$1
prefix=$2
also=${3:-success}
gh api --paginate "repos/$GH_REPO/actions/workflows/$workflow/runs?branch=main&event=push&per_page=100" \
  -q ".workflow_runs[] | select(.id != $GITHUB_RUN_ID) | \"\(.id) \(.head_sha)\"" 2>/dev/null |
  while read -r run sha; do
    covered=$(gh api "repos/$GH_REPO/actions/runs/$run/jobs?per_page=100" -q "[.jobs[] | select(.name | startswith(\"$prefix\"))]
      | length > 0 and all(.conclusion == \"success\" or .conclusion == \"failure\" or .conclusion == \"$also\")" 2>/dev/null) || exit 0
    if [ "$covered" = true ]; then
      echo "$sha"
      exit 0
    fi
  done
# A failed lookup prints nothing and must not fail the caller's step.
exit 0
