#!/usr/bin/env bash
# CI's quick Linux checks, run before a push, for what changed since origin/main (committed or not):
#
#   scripts/check.sh              what the changes reach, less what an earlier pass still covers
#   scripts/check.sh <check>...   these in full, changed or not: fleetd site desktop qa
#   scripts/check.sh --background [<check>...]   the same, detached, its output in the git dir's fleetd-check.log
#   scripts/check.sh --wait       waits for the background run to end, and prints its last line
#
# Each runs the commands of its CI job. With none named, fleetd/scripts/check_scope.ts picks the parts from the files
# the worktree changes against its merge base with origin/main, as CI's jobs scope themselves, and runs more whenever
# it can't tell what a file reaches:
# - fleetd, for a change under .github/fleetd-scope.sh's paths: in fleetd/, the generated files (migrations, docs
#   pages, setup steps: bun run gen:check), the hub migrations check (the worktree, untracked files too, merged onto
#   origin/main, fetched fresh, as CI checks its merge commit), every migration on the oldest SQLite fleetd supports,
#   the type check, and the tests that reach a changed file through what they import or name, not through another
#   part's wiring (the CLI's golden outputs reach every module through main.ts). Shared code (src/shared, the contracts,
#   the migrations, the dependencies) runs everything that reads it, and a file no test names runs every test. CI's
#   `fleetd` job runs every test, builds the binary and runs the black-box tests and the lab scenarios on it.
# - site: a build of docs/site, the site's pages and links, and (for a change to the site's own files, not only to
#   fleetd's paths, which `fleetd help` and the generated docs pages read) that the landing page fits every width.
#   No personal identifiers and no supplier name of fleetd's computers where a person reads it run on every call; they
#   read every tracked file, and the untracked ones not ignored.
# - desktop, for app/desktop, ci.yml and the hub files the app's tests read (ci.yml's scope): its case clashes,
#   typecheck, lint, unit tests and the web app's bundle.
# - reverts: on every call, whether HEAD would undo work already on origin/main (scripts/reverts.sh, the merge train's
#   own check before review): a commit made on a fresh main while its files were an older tree's.
# - qa: desktop-qa.yml's screens, all shards in one run, when named. With none named, a change to app/desktop's
#   renderer, fixtures or QA screens runs the screens it shows (app/desktop/qa/touched.ts picks them; past 150 tests,
#   only its own: its fixtures', its page's or directory's, and the screens whose QA entries it changed): a screen that
#   asks the hub something new fails there when one of its fixtures has no answer for it, and one that moved to another
#   page fails there when its steps don't hold on it.
#
# It runs them all, then names each one that failed, with its command, and exits 1. Its last line is one of:
#   check.sh: pushable <tree>                                  every check the changes touch passed on the tree
#   check.sh: passed <check>...; still to pass on <tree>: ...  the checks named passed, others are still to pass
#   check.sh: failed <check>...                                these failed (their commands are listed above it)
# It fetches origin/main first, and doesn't install toolchains: bun, node 24 and pnpm. On a fleetd machine (an agent's
# PATH has fleetd-heavy) a run waits its turn for one of the machine's heavy-run slots, saying so in one line, so ten
# writers' checks at once can't load the machine until each other's timing tests fail.
#
# A fleetd writer's push of a branch is refused unless its tree passed (.fleetd/pre-push.json): it records the tree it
# checked (the worktree's, committed or not) in the git dir's fleetd-checked once every check the changes touch has
# passed on it, in one run or in several (scripts/check.sh fleetd reruns only the one that failed). Each check's pass is
# recorded there too, as "<tree> <base> <check>": the change it covered is the tree's difference from the base. A pass
# still counts for a later tree that is its tree merged cleanly onto a newer main whose new commits touch none of the
# change's files: a check it covers doesn't run, and says so. Otherwise a check runs only for what its pass hasn't
# seen: the change's own edits since, and its files main touched too. So a desktop fix on a branch whose fleetd passed
# doesn't run fleetd again, and a rebase onto a main that moved elsewhere runs nothing but the checks on every call.
# So run it on the tree you push, and commit exactly what it checked: a main that moved since but merges cleanly needs
# no rebase, as the merge train rebases and runs CI itself. One too long for a command's time limit runs with
# --background, and --wait, run with Claude's Monitor tool, says how it ended (never a sleep loop): it records its pass
# when it ends either way.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

log=$(git rev-parse --path-format=absolute --git-path fleetd-check.log)
pid_file=$(git rev-parse --path-format=absolute --git-path fleetd-check.pid)
last_line='^check\.sh: (pushable|passed|failed) '
if [ "${1:-}" = --background ]; then
  shift
  detach=(nohup)
  command -v setsid >/dev/null && detach=(setsid nohup)
  # The detached run takes a slot of its own: one started under fleetd-heavy mustn't take its slot along for free.
  env -u FLEETD_HEAVY_SLOT -u FLEETD_CHECK_SLOT "${detach[@]}" "$PWD/scripts/check.sh" "$@" >"$log" 2>&1 </dev/null &
  echo $! >"$pid_file"
  echo "check.sh: running in the background (pid $!), its output in $log."
  echo "Wait for it with the Monitor tool running \`scripts/check.sh --wait\` (never a sleep loop): it prints the run's last"
  echo "line when it ends (check.sh: pushable <tree>, or failed <checks>). A Monitor that times out first: start it again."
  exit 0
fi
if [ "${1:-}" = --wait ]; then
  pid=$(cat "$pid_file" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # GNU tail returns once the run ends; elsewhere, a check each second.
    tail --pid="$pid" -f /dev/null 2>/dev/null || while kill -0 "$pid" 2>/dev/null; do sleep 1; done
  fi
  end=$(grep -E "$last_line" "$log" 2>/dev/null | tail -n 1)
  echo "${end:-check.sh: failed (the background run ended before its last line; its output is in $log)}"
  [[ $end == "check.sh: pushable "* || $end == "check.sh: passed "* ]]
  exit
fi
# On a fleetd machine, a run takes one of its heavy-run slots first (fleetd/src/node/heavy_slots.ts): with every slot
# in use it prints that it is waiting for one and starts by itself once one frees, its time counted from then. A node
# from before Nov 23 has only fleetd-check-slot, and sets only FLEETD_CHECK_SLOT.
if [ -z "${FLEETD_HEAVY_SLOT:-}${FLEETD_CHECK_SLOT:-}" ]; then
  heavy=$(command -v fleetd-heavy || command -v fleetd-check-slot) && exec "$heavy" "$PWD/scripts/check.sh" "$@"
fi

all=(fleetd site desktop qa)
for name in "$@"; do
  [[ " ${all[*]} " == *" $name "* ]] || { echo "unknown check: $name (checks: ${all[*]})" >&2; exit 2; }
done
named=("$@")
tmp=$(mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

git fetch -q origin main || echo "check.sh: couldn't fetch origin/main; comparing with the one fetched before" >&2
base=$(git merge-base origin/main HEAD) || exit 1
marks=$(git rev-parse --git-path fleetd-checked)

failed=()
missing=''
# step <check> <command>...: runs it, and on failure keeps the check and the command for the summary.
step() {
  local check=$1
  shift
  echo "==> $check: $*"
  if ! "$@"; then
    failed+=("$check: $*")
    echo "==> FAILED $check: $*"
  fi
}
# npm ci, unless its node_modules is already newer than its lockfile.
npm_ci() {
  [ "$1/node_modules/.package-lock.json" -nt "$1/package-lock.json" ] || npm ci --prefix "$1" --no-audit --no-fund
}

# The worktree's tree: committed or not, untracked files too, but not ignored ones. What it checks, read before any
# check runs.
worktree_tree() {
  local index=$tmp/index
  cp "$(git rev-parse --git-path index)" "$index" && GIT_INDEX_FILE=$index git add -A && GIT_INDEX_FILE=$index git write-tree
}
checked_tree=$(worktree_tree) || exit 1
echo "check.sh: checking tree ${checked_tree:0:12} (past a command's time limit: scripts/check.sh --background, or one check at a time)"

# The worktree as CI's merge commit would hold it, merged onto origin/main. A merge that conflicts still writes its
# tree, the conflicts marked.
merged() {
  local commit out
  commit=$(git commit-tree "$checked_tree" -p HEAD -m check.sh) || return
  out=$(git merge-tree --write-tree origin/main "$commit")
  [ -n "$out" ] && echo "${out%%$'\n'*}"
}

# The plan (fleetd/scripts/check_scope.ts): needed, the checks the changes touch, which a tree must pass to be pushed;
# covered, those an earlier pass still covers whole; run_<check> with its fleetd_tests and qa_files, what to run of the
# others; notes, what it skips and why.
needed=() covered=() notes=() fleetd_tests=() qa_files=() run_fleetd='' run_site='' run_desktop='' run_qa=''
plan=$(cd fleetd && bun scripts/check_scope.ts plan "$checked_tree" "$base" "$marks") || {
  echo "check.sh: failed (fleetd/scripts/check_scope.ts couldn't plan the run)"
  exit 1
}
eval "$plan"
if [ ${#named[@]} -gt 0 ]; then
  run_fleetd='' run_site='' run_desktop='' run_qa=''
  for name in "${named[@]}"; do
    case $name in
      fleetd) run_fleetd=1 fleetd_tests=(all) ;;
      site) run_site=full ;;
      desktop) run_desktop=1 ;;
      qa) run_qa=all ;;
    esac
  done
else
  for n in "${notes[@]}"; do echo "==> $n"; done
fi

# bun install in fleetd/, unless its node_modules is already newer than its lockfile.
bun_install() {
  [ fleetd/node_modules/.bun-tag -nt fleetd/bun.lock ] || { (cd fleetd && bun install --frozen-lockfile) && touch fleetd/node_modules/.bun-tag; }
}
in_fleetd() { (cd fleetd && "$@"); }

if [ -n "$run_fleetd" ]; then
  step fleetd bun_install
  # Fix: cd fleetd && bun run gen, and commit what it wrote.
  step fleetd in_fleetd bun run gen:check
  # Fix: rename a new migration to the current UTC time (date -u +%Y%m%d%H%M), after main's newest.
  head=$(merged) || { echo "check.sh: couldn't merge the worktree onto origin/main; checking HEAD's migrations" >&2; head=HEAD; }
  step fleetd node .github/migrations-check.mjs origin/main "$head"
  # Fix: write the migration it names in SQL the oldest supported SQLite runs (OLDEST_SQLITE, hub/store/migrations.ts).
  step fleetd in_fleetd bun scripts/old-sqlite-check.ts
  step fleetd in_fleetd bun run typecheck
  # SQLite's temp files (a big sort's spill) in /var/tmp, on the machine's disk: never /tmp, which may be held in memory.
  if [ "${fleetd_tests[*]}" = all ]; then
    SQLITE_TMPDIR=${SQLITE_TMPDIR:-/var/tmp} step fleetd in_fleetd bun test --parallel=4
  elif [ ${#fleetd_tests[@]} -eq 0 ]; then
    echo "==> fleetd: no test reaches the change (scripts/check.sh fleetd runs them all)"
  else
    echo "==> fleetd: the ${#fleetd_tests[@]} test files that reach the change (scripts/check.sh fleetd runs them all)"
    # The files, too many to name in its line: bun test --parallel=4 <each>.
    picked_tests() { in_fleetd bun test --parallel=4 "${fleetd_tests[@]}"; }
    SQLITE_TMPDIR=${SQLITE_TMPDIR:-/var/tmp} step fleetd picked_tests
  fi
fi

help=$tmp/fleetd-help.txt
if [ -n "$run_site" ]; then
  step site npm_ci docs/site
  step site npm run build --prefix docs/site
  if bun_install && (cd fleetd && bun src/main.ts help) >"$help"; then
    step site node .github/site-check.mjs "$help"
  else
    failed+=("site: bun fleetd/src/main.ts help")
  fi
  step site node .github/docs-links.mjs
  # The landing and pricing pages in Chrome at every width, about a minute: they change only with the site's own files.
  [ "$run_site" = help ] || step site node .github/site-layout-check.mjs
fi
step site node .github/personal-check.mjs --untracked
step site node .github/supplier-check.mjs --untracked
step reverts scripts/reverts.sh origin/main

if [ -n "$run_desktop" ]; then
  # macOS checkouts are case-insensitive: Composer.tsx beside composer.ts breaks the Mac build.
  case_clashes() {
    local clashes
    clashes=$(git ls-files | sed -E 's/\.[^./]+$//' | awk '{ l = tolower($0) } (l in seen) && seen[l] != $0 { print seen[l] " / " $0; next } { seen[l] = $0 }')
    [ -z "$clashes" ] || { echo "Paths that differ only in case (rename one):"; echo "$clashes"; return 1; }
  }
  step desktop case_clashes
  step desktop pnpm -C app/desktop install --frozen-lockfile
  step desktop pnpm -C app/desktop typecheck
  step desktop pnpm -C app/desktop lint
  step desktop pnpm -C app/desktop test
  step desktop pnpm -C app/desktop build:web
fi

# pnpm fixtures, unless what it reads is what it last built from (scripts/fixtures-key.ts, CI's cache key for them).
fixtures() {
  local key stamp=app/desktop/node_modules/.fixtures-key
  key=$(cd app/desktop && node scripts/fixtures-key.ts) || return
  [ "$(cat "$stamp" 2>/dev/null)" = "$key" ] && [ -e app/desktop/fixtures/typical.json ] && return
  pnpm -C app/desktop fixtures && echo "$key" >"$stamp"
}
# Past this many tests, the screens a change reaches through imports are too many to run: only its own ones run.
qa_most=150
# touched <var> <arg>...: app/desktop/qa/touched.ts on the changed files, into <var>; a failure of its own fails qa.
touched() {
  local -n into=$1
  shift
  # shellcheck disable=SC2034 # a nameref: it sets the caller's <var>.
  into=$(cd app/desktop && node qa/touched.ts --base="$base" "$@" "${qa_files[@]}") && return
  failed+=("qa: node app/desktop/qa/touched.ts $*")
  echo "==> FAILED qa: node app/desktop/qa/touched.ts $*"
  return 1
}
# The picked screens' tests: pnpm -C app/desktop qa --grep <touched.ts's regex>.
qa_picked() { pnpm -C app/desktop qa --grep "$grep"; }
if [ "$run_qa" = all ]; then
  step qa pnpm -C app/desktop install --frozen-lockfile
  step qa pnpm -C app/desktop exec install-electron
  step qa fixtures
  step qa pnpm -C app/desktop qa:build
  step qa pnpm -C app/desktop qa:selftest
  step qa pnpm -C app/desktop qa
elif [ -n "$run_qa" ]; then
  tests='' grep=''
  if touched tests --count && touched grep; then
    if [ "$tests" -gt $qa_most ]; then
      echo "==> qa: the change reaches $tests screens' tests, too many to run here: only its own run (scripts/check.sh qa runs every screen)"
      touched tests --near --most=$qa_most --count && touched grep --near --most=$qa_most || grep=''
    fi
    if [ -z "$grep" ]; then
      echo "==> qa: no screen shows the change; if one shows something new, scripts/check.sh qa runs them all"
    else
      echo "==> qa: $tests screens' tests"
      step qa pnpm -C app/desktop exec install-electron
      step qa fixtures
      step qa pnpm -C app/desktop qa:build
      step qa qa_picked
    fi
  fi
elif [ ${#named[@]} -eq 0 ] && [[ " ${needed[*]} " == *" desktop "* && " ${needed[*]} " != *" qa "* ]]; then
  echo "==> qa: app/desktop changed; if a screen shows something new, scripts/check.sh qa runs the screens CI runs"
fi

# For fleetd's pre-push gate, newest last: "<tree> <base> <check>" for each check that passed on the tree, or that an
# earlier pass covers (the plan's notes), and "<tree>" once every check the tree needs has. A check run on every call
# (reverts, the identifier check) that fails records none, and a run that fails anything never marks its tree whole: a
# later run that passes does.
ran=()
[ -n "$run_fleetd" ] && ran+=(fleetd)
[ -n "$run_site" ] && ran+=(site)
[ -n "$run_desktop" ] && ran+=(desktop)
[ -n "$run_qa" ] && ran+=(qa)
passed=()
for c in "${covered[@]}" "${ran[@]}"; do
  [[ " ${passed[*]} " == *" $c "* ]] || printf '%s\n' "${failed[@]}" | grep -q "^$c:" || passed+=("$c")
done
for f in "${failed[@]}"; do
  [[ " ${ran[*]} " == *" ${f%%:*} "* ]] || passed=()
done
{
  tail -n 199 "$marks" 2>/dev/null
  for c in "${passed[@]}"; do echo "$checked_tree $base $c"; done
} >"$tmp/checked"
whole=true
[ ${#failed[@]} -eq 0 ] || whole=false
for c in "${needed[@]}"; do grep -qxF "$checked_tree $base $c" "$tmp/checked" || { whole=false; missing+=" $c"; }; done
$whole && echo "$checked_tree" >>"$tmp/checked"
mv "$tmp/checked" "$marks"

took="in $((SECONDS / 60))m$((SECONDS % 60))s"
if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "${#failed[@]} failed:"
  printf '  %s\n' "${failed[@]}"
  echo "Not pushable yet: rerun what failed (scripts/check.sh <check> runs one) once it's fixed."
  echo "check.sh: failed $(printf '%s\n' "${failed[@]%%:*}" | awk '!seen[$0]++' | tr '\n' ' ')($took)"
  exit 1
fi
echo
if $whole; then
  echo "check.sh: pushable $checked_tree ($took)"
else
  echo "check.sh: passed ${ran[*]}; still to pass on $checked_tree:$missing ($took)"
fi
