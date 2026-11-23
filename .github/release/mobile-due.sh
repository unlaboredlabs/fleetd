#!/usr/bin/env bash
# Whether a Mobile release started by itself (mobile-release.yml's schedule, or mobile-merged.yml's dispatch after a
# merge) has a phone app to send to TestFlight: only when the files its binary is built from changed on the branch
# since the newest commit already covered. A commit is covered by a successful scheduled run there (it sent its build,
# or found nothing new since the one before) or by a dispatched run there whose build went to TestFlight (its `Upload
# to TestFlight` step passed). A run that failed covers nothing, so the next one tries the same commit again.
#
#   mobile-due.sh paths   the paths the binary is built from, one per line: the app, the desktop modules Metro bundles
#                         with it (metro.config.js), and the release's own workflow and scripts
#   mobile-due.sh due     prints build=true or build=false and says why in one line (stderr and the job summary).
#                         Reads UPLOAD (true when a build would go to TestFlight), GITHUB_REPOSITORY, GITHUB_REF_NAME
#                         and GITHUB_SHA, and lists the workflow's runs with gh (GH_TOKEN, actions: read).
set -euo pipefail

paths=(
  app/mobile
  app/desktop/src/shared
  app/desktop/src/renderer/src/data
  app/desktop/src/renderer/screens/automations
  app/desktop/src/renderer/screens/connections
  app/desktop/src/renderer/screens/projects
  app/desktop/src/renderer/screens/sessions
  app/desktop/src/renderer/screens/settings
  app/desktop/src/renderer/screens/updates
  .github/workflows/mobile-release.yml
  .github/release/mobile-env.sh
  .github/release/mobile-sign.sh
)
# Tests and notes aren't in the binary.
skip=(':!*.test.ts' ':!*.test.tsx' ':!*.md')

# The newest commit on the branch a run covers, empty for none.
covered() {
  local repo="${GITHUB_REPOSITORY:?}" runs id event sha uploaded
  runs="$(gh api "repos/$repo/actions/workflows/mobile-release.yml/runs?branch=$branch&status=success&per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(.event) \(.head_sha)"')"
  while read -r id event sha; do
    [ -n "$id" ] || continue
    if [ "$event" = schedule ]; then
      echo "$sha"
      return
    fi
    uploaded="$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" \
      --jq '.jobs[] | select(.name == "ios") | .steps[] | select(.name == "Upload to TestFlight" and .conclusion == "success") | .name')"
    if [ -n "$uploaded" ]; then
      echo "$sha"
      return
    fi
  done <<< "$runs"
}

case "${1:-}" in
paths)
  printf '%s\n' "${paths[@]}"
  ;;
due)
  branch="${GITHUB_REF_NAME:?}"
  head="${GITHUB_SHA:?}"
  say() { echo "$1" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; }
  if [ "${UPLOAD:-}" != true ]; then
    say "Nothing sent: TestFlight isn't set up here (the iOS signing secrets and the App Store Connect key)."
    echo build=false
    exit 0
  fi
  since="$(covered)"
  if [ -z "$since" ]; then
    say "Building ${head:0:9} for TestFlight: no earlier build from $branch went there."
    echo build=true
    exit 0
  fi
  git fetch -q --no-tags --depth=1 origin "$since"
  changed="$(git diff --name-only "$since" "$head" -- "${paths[@]}" "${skip[@]}" | wc -l | tr -d ' ')"
  if [ "$changed" = 0 ]; then
    say "Nothing new for TestFlight: the phone app hasn't changed on $branch since ${since:0:9}."
    echo build=false
  else
    say "Building ${head:0:9} for TestFlight: $changed of the phone app's files changed on $branch since ${since:0:9}."
    echo build=true
  fi
  ;;
*)
  echo "usage: mobile-due.sh paths|due" >&2
  exit 2
  ;;
esac
