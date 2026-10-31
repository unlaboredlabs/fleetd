#!/usr/bin/env bash
# scripts/reverts.sh [<base> [<head>]]: whether <head> (default HEAD) would undo work already on <base> (default
# origin/main), as a commit moved onto a fresh main while its files were an older tree's does. Two exact steps:
# - a file the head changes since its merge base is put back when its blob equals the file's blob after one of its last
#   10 earlier changes on the base, from no later than the merge base, while the base's current blob differs; the
#   base's commits that changed it since are the ones it undoes;
# - such a commit counts only when the head puts back at least half the files it changed (a file it added counts as
#   put back when the head deletes it).
# It names each counted commit and its files put back, and exits 1. A commit since the merge base whose message says
# it reverts named commits or PRs ("revert" and, later on its line, a #<n> or a commit's hex) passes. The merge train
# runs the same rule on every PR before review (crates/fleetd/src/hub/train/reverts.rs): keep the two in step.
set -uo pipefail
base=${1:-origin/main} head=${2:-HEAD}
mb=$(git merge-base "$base" "$head") || exit 2
grep -qiE 'revert.*(#[0-9]+|\b[0-9a-f]{7,40}\b)' <<<"$(git log --format=%B "$mb..$head")" && exit 0
mb_at=$(git log -1 --format=%ct "$mb")
# "<commit> <path>" for each file put back and each commit it undoes.
back=$(git diff --name-only --no-renames --diff-filter=d -z "$mb" "$head" | while IFS= read -r -d '' f; do
  blob=$(git rev-parse "$head:$f")
  git log -n 11 --first-parent --format='C %H %ct' --raw --no-abbrev --no-renames "$base" -- "$f" |
    awk -v f="$f" -v blob="$blob" -v mb_at="$mb_at" '
      /^C / { sha = $2; at = $3; next }
      /^:/ {
        split($0, a, /[ \t]+/)
        if (a[4] == blob && n == 0) exit
        if (a[4] == blob && at <= mb_at) { printf "%s", undone; exit }
        n++; undone = undone sha " " f "\n"
      }'
done)
[ -z "$back" ] && exit 0
deleted=$(git diff --name-only --no-renames --diff-filter=D "$mb" "$head")
found=0
for c in $(cut -d' ' -f1 <<<"$back" | sort -u | head -30); do
  total=0 put=0
  while IFS=$'\t' read -r status f; do
    total=$((total + 1))
    if grep -qxF "$c $f" <<<"$back" || { [ "$status" = A ] && grep -qxF "$f" <<<"$deleted"; }; then put=$((put + 1)); fi
  done < <(git show --format= --name-status --no-renames "$c")
  [ $((put * 2)) -ge "$total" ] && [ "$total" -gt 0 ] || continue
  [ $found = 0 ] && echo "$head would undo work already on $base: it puts back older versions of these commits' files."
  found=1
  git log -1 --format='%h %s' "$c"
  grep "^$c " <<<"$back" | cut -d' ' -f2- | sed 's/^/  /'
done
[ $found = 0 ] && exit 0
echo "Your commit carries files from an older $base. Rebuild your branch on $base and re-apply only your own changes"
echo "(git checkout -B <branch> $base, redo your edits, check git diff $base shows only them). If you mean to revert"
echo "those commits, say so in your commit message, naming them or their PRs, and in the PR's title or body too: the"
echo "merge train reads those."
exit 1
