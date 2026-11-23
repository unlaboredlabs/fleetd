#!/usr/bin/env bash
# Whether a Mobile release mobile-merged.yml started after a merge (mobile-release.yml with `only_if_changed`) has a
# phone app to send to TestFlight: only when the files its binary is built from changed between the newest commit a
# build already went there from and the one this run builds (`sha`, the commit CI passed on). A build covers the commit
# its run's name gives (`Mobile release of <sha>`), else its run's head, once its `Upload to TestFlight` step passed; a
# run that failed or skipped covers nothing. One older than a commit already sent (CI of two merges finishing out of
# order) builds nothing.
#
#   mobile-due.sh paths   the paths the binary is built from, one per line: the app, the desktop modules Metro bundles
#                         with it (metro.config.js), and the release's own workflow and scripts
#   mobile-due.sh commit  fails unless BUILD_SHA is a full commit id on the branch, at or before GITHUB_SHA (its head
#                         when the run started)
#   mobile-due.sh due     prints build=true or build=false and says why in one line (stderr and the job summary).
#                         Reads UPLOAD (true when a build would go to TestFlight), BUILD_SHA, GITHUB_REPOSITORY and
#                         GITHUB_REF_NAME, and reads the workflow's runs with gh (GH_TOKEN, actions: read).
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

# The commit the newest build sent to TestFlight from the branch was of, empty for none.
covered() {
  local runs id sha uploaded
  runs="$(gh api "repos/$repo/actions/workflows/mobile-release.yml/runs?branch=$branch&status=success&per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(((.display_title // "") | [match("[0-9a-f]{40}").string][0]) // .head_sha)"')"
  while read -r id sha; do
    [ -n "$id" ] || continue
    uploaded="$(gh api "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" \
      --jq '.jobs[] | select(.name == "ios") | .steps[] | select(.name == "Upload to TestFlight" and .conclusion == "success") | .name')"
    if [ -n "$uploaded" ]; then
      echo "$sha"
      return
    fi
  done <<< "$runs"
}

# Whether commit $1 is $2 or one before it.
at_or_before() {
  local status
  status="$(gh api "repos/$repo/compare/$1...$2" --jq .status)"
  [ "$status" = identical ] || [ "$status" = ahead ]
}

case "${1:-}" in
paths)
  printf '%s\n' "${paths[@]}"
  ;;
commit)
  repo="${GITHUB_REPOSITORY:?}"
  head="${BUILD_SHA:?}"
  if ! [[ "$head" =~ ^[0-9a-f]{40}$ ]] || ! at_or_before "$head" "${GITHUB_SHA:?}"; then
    echo "::error::$head isn't a commit of ${GITHUB_REF_NAME:-the branch} at or before ${GITHUB_SHA:0:9}: give a full commit id from it." >&2
    exit 1
  fi
  ;;
due)
  repo="${GITHUB_REPOSITORY:?}"
  branch="${GITHUB_REF_NAME:?}"
  head="${BUILD_SHA:?}"
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
  if at_or_before "$head" "$since"; then
    say "Nothing new for TestFlight: ${head:0:9} is in the build of ${since:0:9}, which went there already."
    echo build=false
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
  echo "usage: mobile-due.sh paths|commit|due" >&2
  exit 2
  ;;
esac
