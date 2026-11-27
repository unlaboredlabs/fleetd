#!/usr/bin/env bash
# What a Mobile release mobile-merged.yml started after a merge (mobile-release.yml with `only_if_changed`) sends out:
# nothing when the files the phone app is built from didn't change since the newest commit a run already released,
# else an over-the-air update when the native fingerprint is the newest TestFlight build's, else a new build (D800).
# A run released a commit once its `Upload to TestFlight` step (job ios) or its `Publish the update` step (job update)
# passed; the commit is the one its run's name gives (`Mobile release of <sha>`), else its run's head. A run that failed
# or skipped released nothing. One older than a commit already released (CI of two merges finishing out of order)
# sends nothing.
#
#   mobile-due.sh paths    the paths the app is built from, one per line: the app, the desktop modules Metro bundles
#                          with it (metro.config.js), and the release's own workflow and scripts
#   mobile-due.sh commit   fails unless BUILD_SHA is a full commit id on the branch, at or before GITHUB_SHA (its head
#                          when the run started)
#   mobile-due.sh due      prints due=true or due=false and says why in one line (stderr and the job summary). Reads
#                          UPLOAD (true when a build would go to TestFlight), BUILD_SHA, GITHUB_REPOSITORY and
#                          GITHUB_REF_NAME, and reads the workflow's runs with gh (GH_TOKEN, actions: read).
#   mobile-due.sh release  prints release=update or release=testflight and says why, the same way. An update when
#                          updates can be published (UPDATES=true) and this commit's runtime versions (RUNTIME_IOS,
#                          RUNTIME_ANDROID: each platform's native fingerprint, app.config.ts) are the ones the newest
#                          TestFlight build embeds, which its ios job's `Native fingerprint ios <x> android <y>` step
#                          names; a build that doesn't name them gets a new build. Reads what `due` does but UPLOAD.
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
# Tests and notes aren't in the app.
skip=(':!*.test.ts' ':!*.test.tsx' ':!*.md')

# The workflow's successful runs on the branch, newest first, each as "<run id> <commit>".
runs() {
  gh api "repos/$repo/actions/workflows/mobile-release.yml/runs?branch=$branch&status=success&per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(((.display_title // "") | [match("[0-9a-f]{40}").string][0]) // .head_sha)"'
}

# What run $1 released: "testflight <fingerprint>", "update" or "none". The fingerprint is empty for a build from
# before builds named theirs.
released() {
  gh api "repos/$repo/actions/runs/$1/jobs?filter=latest&per_page=100" --jq '
    def passed($job; $step): [.jobs[] | select(.name == $job) | .steps[] | select(.name == $step and .conclusion == "success")] | length > 0;
    ([.jobs[] | select(.name == "ios") | .steps[] | .name | select(startswith("Native fingerprint ")) | ltrimstr("Native fingerprint ")][0] // "") as $fp
    | if passed("ios"; "Upload to TestFlight") then "testflight \($fp)" elif passed("update"; "Publish the update") then "update" else "none" end'
}

# The commit of the newest run that released anything ($1 any), or that sent a build to TestFlight ($1 testflight),
# then that build's fingerprint; empty for none.
newest() {
  local list id sha got what fp
  list="$(runs)"
  while read -r id sha; do
    [ -n "$id" ] || continue
    got="$(released "$id")"
    read -r what fp <<< "$got"
    if [ "$what" = testflight ] || { [ "$1" = any ] && [ "$what" = update ]; }; then
      echo "$sha ${fp:-}"
      return
    fi
  done <<< "$list"
}

# Whether commit $1 is $2 or one before it.
at_or_before() {
  local status
  status="$(gh api "repos/$repo/compare/$1...$2" --jq .status)"
  [ "$status" = identical ] || [ "$status" = ahead ]
}

say() { echo "$1" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" >&2; }

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
  if [ "${UPLOAD:-}" != true ]; then
    say "Nothing sent: TestFlight isn't set up here (the iOS signing secrets and the App Store Connect key)."
    echo due=false
    exit 0
  fi
  got="$(newest any)"
  read -r since _ <<< "$got"
  if [ -z "$since" ]; then
    say "Releasing ${head:0:9}: no earlier run from $branch released the phone app."
    echo due=true
    exit 0
  fi
  if at_or_before "$head" "$since"; then
    say "Nothing new: ${head:0:9} is in the release of ${since:0:9}, which went out already."
    echo due=false
    exit 0
  fi
  git fetch -q --no-tags --depth=1 origin "$since" "$head"
  changed="$(git diff --name-only "$since" "$head" -- "${paths[@]}" "${skip[@]}" | wc -l | tr -d ' ')"
  if [ "$changed" = 0 ]; then
    say "Nothing new: the phone app hasn't changed on $branch since ${since:0:9}."
    echo due=false
  else
    say "Releasing ${head:0:9}: $changed of the phone app's files changed on $branch since ${since:0:9}."
    echo due=true
  fi
  ;;
release)
  repo="${GITHUB_REPOSITORY:?}"
  branch="${GITHUB_REF_NAME:?}"
  head="${BUILD_SHA:?}"
  want="ios ${RUNTIME_IOS:?} android ${RUNTIME_ANDROID:?}"
  if [ "${UPDATES:-}" != true ]; then
    say "Building ${head:0:9} for TestFlight: over-the-air updates aren't published here (the UPDATES_PRIVATE_KEY_PEM secret and UPDATES_CERT_PEM variable, on main's edge channel)."
    echo release=testflight
    exit 0
  fi
  got="$(newest testflight)"
  read -r built fp <<< "$got"
  if [ -z "$built" ]; then
    say "Building ${head:0:9} for TestFlight: no earlier build from $branch went there."
    echo release=testflight
  elif [ -z "${fp:-}" ]; then
    say "Building ${head:0:9} for TestFlight: the newest build there, of ${built:0:9}, doesn't name its native fingerprint."
    echo release=testflight
  elif [ "$fp" != "$want" ]; then
    say "Building ${head:0:9} for TestFlight: the native fingerprint changed since the build of ${built:0:9} (it embeds $fp, this is $want)."
    echo release=testflight
  else
    say "Publishing ${head:0:9} as an over-the-air update: its native fingerprint is the one the TestFlight build of ${built:0:9} embeds ($want)."
    echo release=update
  fi
  ;;
*)
  echo "usage: mobile-due.sh paths|commit|due|release" >&2
  exit 2
  ;;
esac
