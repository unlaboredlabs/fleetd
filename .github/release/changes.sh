#!/usr/bin/env bash
# Writes changes.json, the "what's new" the app's update notice shows: newest first, the first-parent commits of the
# channel, each with its subject (a merged PR's title and number, or a `batch: a (#1); b (#2)` of several) and the
# areas it touched (app/ → app, crates/ → hub, anything else → other). Capped at 300.
#
#   {"changes": [{"commit", "date", "subject", "areas": ["app" | "hub" | "other"]}]}
#
# The new entries run from the previous release's commit (its release.json) to <head>, in front of its changes.json,
# de-duplicated. Without a previous commit, or one <head> doesn't descend from, it takes the last 50. Starting at the
# last published commit means a cancelled edge build loses nothing. Needs the full history (fetch-depth: 0).
#
#   changes.sh <dir with the previous release.json and changes.json, either may be missing> <head> > changes.json
set -euo pipefail
prev_dir="$1"
head="$2"
since="$(jq -r '.commit // empty' "$prev_dir/release.json" 2>/dev/null || true)"
range=("$head" -n 50)
if [ -n "$since" ] && git merge-base --is-ancestor "$since" "$head" 2>/dev/null; then
  range=("$since..$head")
else
  echo "no previous release commit in the history of $head; taking the last 50 commits" >&2
fi
older='[]'
if [ -s "$prev_dir/changes.json" ]; then older="$(jq -c '.changes // []' "$prev_dir/changes.json")"; fi

TZ=UTC git log --first-parent --date=format-local:%Y-%m-%dT%H:%M:%SZ --format='%H%x1f%cd%x1f%s' "${range[@]}" |
  while IFS=$'\x1f' read -r commit date subject; do
    areas="$(git diff-tree --no-commit-id --name-only -r --root -m --first-parent "$commit" |
      awk '{ print /^app\// ? "app" : /^crates\// ? "hub" : "other" }' | sort -u | paste -sd, -)"
    jq -nc --arg commit "$commit" --arg date "$date" --arg subject "$subject" --arg areas "${areas:-other}" \
      '{commit: $commit, date: $date, subject: $subject, areas: ($areas | split(","))}'
  done |
  jq -s --argjson older "$older" '{changes: ((. + $older) | reduce .[] as $c ([]; if any(.[]; .commit == $c.commit) then . else . + [$c] end) | .[:300])}'
