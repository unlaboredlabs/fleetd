#!/usr/bin/env bash
# CI's quick Linux checks, run before a push, for what changed since origin/main (committed or not):
#
#   scripts/check.sh              the checks the changes touch
#   scripts/check.sh <check>...   these, changed or not: rust-lint rust-docs rust-tests site desktop qa
#   scripts/check.sh --background [<check>...]   the same, detached, its output in the git dir's fleetd-check.log
#   scripts/check.sh --wait       waits for the background run to end, and prints its last line
#   scripts/check.sh --keys       each check's key on the worktree's tree: the hash of the files it reads (below)
#
# Each runs the commands of its ci.yml job, scoped as CI scopes it (.github/rust-scope.sh's paths for the Rust ones):
# - rust-lint: cargo fmt --check, clippy -D warnings, and the hub migrations check: the worktree (untracked files too)
#   merged onto origin/main, fetched fresh, as CI checks its merge commit.
# - rust-docs: the docs' generated pages (docsgen --check), `fleetd help` for the site check, the lab scenarios.
# - rust-tests: the workspace tests of the modules the changed files are in, two levels deep (a change to
#   crates/fleetd/src/hub/train/batch.rs runs hub::train::), and the other crates' tests whole. CI's `rust (linux)`
#   runs every test. A change to crates/fleetd-contracts or the files generated from it runs `fleetd-schema --check`
#   (the drift that test generated_contracts_are_current fails on).
# - site: a build of docs/site, the site's pages and links, no personal identifiers, and the landing page fits every
#   width. The identifier check runs on every call; it reads every tracked file, and the untracked ones not ignored.
# - desktop: app/desktop's case clashes, typecheck, lint and unit tests.
# - reverts: on every call, whether HEAD would undo work already on origin/main (scripts/reverts.sh, the merge train's
#   own check before review): a commit made on a fresh main while its files were an older tree's.
# - qa: desktop-qa.yml's screens, all shards in one run; no PR runs that workflow (it took minutes), so this is where
#   they run. It takes long, so it runs only when named. With no check named, a change to app/desktop's renderer or
#   fixtures runs the screens it shows (app/desktop/qa/touched.ts picks them; past 150 tests, only its own: its
#   fixtures' and its page's or directory's): a screen that asks the hub something new fails there when one of its
#   fixtures has no answer for it.
#
# The binaries they run (fleetd, docsgen, fleetd-schema) build in one cargo, and so do the tests picked: a run of them
# all waits for a build slot 3 times: clippy, that build, the tests. The tests' build takes two slots when it builds
# fleetd's lib tests beside its integration tests or another crate's (node/build_slots.rs: two of its biggest rustc).
#
# It runs them all, then names each one that failed, with its command, and exits 1. Its last line is one of:
#   check.sh: pushable <tree>                                  every check the changes touch passed on the tree
#   check.sh: passed <check>...; still to pass on <tree>: ...  the checks named passed, others are still to pass
#   check.sh: failed <check>...                                these failed (their commands are listed above it)
# It fetches origin/main first, and doesn't install toolchains: cargo, node 24 and pnpm, and cargo-nextest if it's there (else cargo test).
#
# A fleetd writer's push of a branch is refused unless its tree passed (.fleetd/pre-push.json): it records the tree it
# checked (the worktree's, committed or not) in the git dir's fleetd-checked once every check the changes touch has
# passed on it, in one run or in several (scripts/check.sh rust-tests reruns only the one that failed). A check's pass
# is kept under its key, the hash of its inputs: the Rust ones .github/rust-scope.sh's paths, the site those and its
# own, desktop and qa the whole tree (their tests read files across it), each with this script. So a
# run with none named skips a check that already passed on the same inputs, and says so: a desktop fix on a branch
# whose Rust passed doesn't run the Rust checks again. So run it after your final rebase onto origin/main, and commit
# exactly what it checked. One too long for a command's time limit runs with --background, and --wait, run with
# Claude's Monitor tool, says how it ended (never a sleep loop): it records its pass when it ends either way.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

log=$(git rev-parse --path-format=absolute --git-path fleetd-check.log)
pid_file=$(git rev-parse --path-format=absolute --git-path fleetd-check.pid)
last_line='^check\.sh: (pushable|passed|failed) '
if [ "${1:-}" = --background ]; then
  shift
  detach=(nohup)
  command -v setsid >/dev/null && detach=(setsid nohup)
  "${detach[@]}" "$PWD/scripts/check.sh" "$@" >"$log" 2>&1 </dev/null &
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

all=(rust-lint rust-docs rust-tests site desktop qa)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# .github/rust-scope.sh's paths, read from it so the two never differ.
eval "$(sed -n '/^paths=(/,/^)$/p' .github/rust-scope.sh)"
# shellcheck disable=SC2154
rust_paths=("${paths[@]}")
site_paths=(docs/site site .github/site-check.mjs .github/site-layout-check.mjs .github/docs-links.mjs
  .github/docs-serve.mjs "${rust_paths[@]}")

# key <tree> <check>: a hash of the check's inputs in the tree, every file it reads, this script among them. A check
# that passed on a tree passes on any tree with the same key: a run with none named doesn't run it again.
key() {
  local tree=$1 check=$2
  case $check in
    rust-lint | rust-docs | rust-tests) set -- "${rust_paths[@]}" ;;
    site) set -- "${site_paths[@]}" ;;
    # The desktop app's tests and screens read files across the repo (the Rust crates' features, the phone app's
    # sources, every path's name for the case clashes): the whole tree. Neither waits for a build slot.
    desktop | qa)
      echo "$tree"
      return
      ;;
  esac
  git ls-tree -r "$tree" -- scripts/check.sh "$@" | git hash-object --stdin
}

# The worktree's tree: committed or not, untracked files too, but not ignored ones.
worktree_tree() {
  local index=$tmp/index
  cp "$(git rev-parse --git-path index)" "$index" && GIT_INDEX_FILE=$index git add -A && GIT_INDEX_FILE=$index git write-tree
}

# --keys: each check's key on the worktree's tree, "<check> <key>" a line.
if [ "${1:-}" = --keys ]; then
  tree=$(worktree_tree) || exit 1
  for c in "${all[@]}"; do echo "$c $(key "$tree" "$c")"; done
  exit 0
fi

for name in "$@"; do
  [[ " ${all[*]} " == *" $name "* ]] || { echo "unknown check: $name (checks: ${all[*]})" >&2; exit 2; }
done

git fetch -q origin main || echo "check.sh: couldn't fetch origin/main; comparing with the one fetched before" >&2
base=$(git merge-base origin/main HEAD) || exit 1
marks=$(git rev-parse --git-path fleetd-checked)
target=${CARGO_TARGET_DIR:-target}
[[ $target == /* ]] || target=$PWD/$target
# A target dir another worktree builds into too: both build the same deps/fleetd-<hash>, and cargo's lock doesn't cover
# the test run, so one check can run the other tree's tests (it happened on the devbox). Said, not refused.
case $target in
  "$(git rev-parse --show-toplevel)"/*) ;;
  *) echo "check.sh: warning: the Rust target dir $target is outside this worktree; another worktree's check building there can swap the test binary this one runs" >&2 ;;
esac

# changed <path>...: whether a path under these differs from the base, in a commit, the worktree or an untracked file.
changed() {
  ! git diff --quiet "$base" -- "$@" || [ -n "$(git ls-files --others --exclude-standard -- "$@")" ]
}
changed_files() {
  { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u
}
# wanted <check> <path>...: named on the command line, or (with none named) one of its paths changed and it hasn't
# passed on the same inputs before.
wanted() {
  local check=$1
  shift
  if [ ${#named[@]} -gt 0 ]; then [[ " ${named[*]} " == *" $check "* ]]; return; fi
  changed "$@" && ! passed_before "$check"
}
# passed_before <check>: whether it passed in an earlier run on a tree with the checked tree's key for it; says so.
passed_before() {
  local k
  k=$(key "$checked_tree" "$1")
  grep -qxF "$k $1" "$marks" 2>/dev/null || return
  echo "==> $1: passed before on the same inputs (key ${k:0:12}), so it doesn't run again (scripts/check.sh $1 runs it)"
}
named=("$@")

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

# What it checks, read before any check runs.
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

if wanted rust-lint "${rust_paths[@]}"; then
  step rust-lint cargo fmt --all --check
  step rust-lint cargo clippy --locked --workspace --all-targets -- -D warnings
  # Fix: rename a new migration to the current UTC time (date -u +%Y%m%d%H%M), after main's newest.
  head=$(merged) || { echo "check.sh: couldn't merge the worktree onto origin/main; checking HEAD's migrations" >&2; head=HEAD; }
  step rust-lint node .github/migrations-check.mjs origin/main "$head"
fi

# The checks the changes touch: what a run with none named runs, and what a tree must pass to be pushed.
needed=()
changed "${rust_paths[@]}" && needed+=(rust-lint rust-docs rust-tests)
changed "${site_paths[@]}" && needed+=(site)
changed app/desktop .github/workflows/ci.yml && needed+=(desktop)
changed app/desktop/src/renderer app/desktop/fixtures && needed+=(qa)

help=$tmp/fleetd-help.txt
site_wanted=false docs_wanted=false tests_wanted=false schema_wanted=false
wanted site "${site_paths[@]}" && site_wanted=true
wanted rust-docs "${rust_paths[@]}" && docs_wanted=true
wanted rust-tests "${rust_paths[@]}" && tests_wanted=true
if $tests_wanted && { [ ${#named[@]} -gt 0 ] || changed crates/fleetd-contracts app/desktop/src/shared/contracts/generated; }; then
  schema_wanted=true
fi

# The binaries the checks run, built by one cargo so they wait for one build slot: fleetd (the lab scenarios, the
# site's `fleetd help`), docsgen and fleetd-schema. When it fails, so does each check that runs one of them.
uses=() packages=()
$docs_wanted && uses+=(rust-docs)
$site_wanted && uses+=(site)
$schema_wanted && uses+=(rust-tests)
{ $docs_wanted || $site_wanted; } && packages+=(-p fleetd)
$docs_wanted && packages+=(-p docsgen)
$schema_wanted && packages+=(-p fleetd-contracts)
built=true
if [ ${#packages[@]} -gt 0 ]; then
  build=(cargo build --locked "${packages[@]}")
  # With the features the tests' build resolves (fleetd's dev-dependency on tokio adds test-util), so both build one
  # copy of the deps and of fleetd's lib: without them the tests' build compiled tokio and all that depends on it a
  # second time in a new worktree, and fleetd's lib a third time for the integration tests or another crate's.
  [[ " ${packages[*]} " == *" fleetd "* ]] && build+=(--features tokio/test-util)
  echo "==> ${uses[*]}: ${build[*]}"
  if ! "${build[@]}"; then
    built=false
    for c in "${uses[@]}"; do failed+=("$c: ${build[*]}"); done
    echo "==> FAILED ${uses[*]}: ${build[*]}"
  fi
fi

if $docs_wanted && $built; then
  # Fix: cargo run -q -p docsgen, and commit the pages it wrote.
  step rust-docs "$target/debug/docsgen" --check
  step rust-docs npm_ci tests/lab
  # A short directory: the node's socket path in it must fit in SUN_LEN (108 bytes).
  export FLEETD_BIN=$target/debug/fleetd FLEETD_FACTORY_DIR=$tmp/f
  step rust-docs npm run factory --prefix tests/lab
fi

if $tests_wanted; then
  # The modules the changed files of crates/fleetd are in (src/hub/train/batch.rs, src/hub/train/tests.rs and
  # src/hub/train.rs are hub::train; the prompts are hub::prompts), its integration tests that changed, and the other
  # crates whole. Its root files (lib.rs, main.rs) and anything else in it pick no tests.
  mods=() itests=() crates=()
  while read -r f; do
    case $f in
      crates/fleetd/assets/prompts/*) mods+=(hub::prompts::) ;;
      crates/fleetd/src/*/*)
        rel=${f#crates/fleetd/src/}
        IFS=/ read -ra seg <<<"${rel%.*}"
        case ${seg[-1]} in mod | tests | *_tests) unset 'seg[-1]' ;; esac
        [ ${#seg[@]} -gt 0 ] && mods+=("${seg[0]}${seg[1]:+::${seg[1]}}::")
        ;;
      crates/fleetd/src/*.rs)
        rel=${f#crates/fleetd/src/}
        case $rel in lib.rs | main.rs) ;; *) mods+=("${rel%.rs}::") ;; esac
        ;;
      crates/fleetd/tests/*.rs) [ -e "$f" ] && itests+=("$(basename "$f" .rs)") ;;
      crates/fleetd/*) ;;
      crates/*/*) c=${f#crates/}; crates+=("${c%%/*}") ;;
    esac
  done < <(changed_files)
  if $schema_wanted && $built; then
    # Fix: cargo run -p fleetd-contracts --bin fleetd-schema, and commit what it wrote.
    step rust-tests "$target/debug/fleetd-schema" --check
  fi
  mapfile -t mods < <(printf '%s\n' "${mods[@]}" | sort -u | sed '/^$/d')
  mapfile -t itests < <(printf '%s\n' "${itests[@]}" | sort -u | sed '/^$/d')
  mapfile -t crates < <(printf '%s\n' "${crates[@]}" | sort -u | sed '/^$/d')
  # The tests picked build in one cargo, so they wait for a build slot once (two slots for the lib's tests beside other
  # targets). Without other crates, only the lib and the integration tests picked build (a target flag would apply to
  # every package).
  packages=() targets=()
  { [ ${#mods[@]} -gt 0 ] || [ ${#itests[@]} -gt 0 ]; } && packages+=(-p fleetd)
  for c in "${crates[@]}"; do packages+=(-p "$c"); done
  if [ ${#crates[@]} -eq 0 ]; then
    [ ${#mods[@]} -gt 0 ] && targets+=(--lib)
    for t in "${itests[@]}"; do targets+=(--test "$t"); done
  fi
  if cargo nextest --version >/dev/null 2>&1; then
    run_tests() { cargo nextest run --locked --no-tests=pass "$@"; }
    # The picked tests under one nextest, a filterset choosing them.
    picked_tests() {
      local m t c filter=''
      for m in "${mods[@]}"; do filter+="${filter:+ | }(package(fleetd) & kind(lib) & test(/^$m/))"; done
      for t in "${itests[@]}"; do filter+="${filter:+ | }binary_id(fleetd::$t)"; done
      for c in "${crates[@]}"; do filter+="${filter:+ | }package($c)"; done
      run_tests "${packages[@]}" "${targets[@]}" -E "$filter"
    }
  else
    run_tests() { cargo test --locked "$@"; }
    # The picked tests' binaries, built by one `cargo test --no-run`, each run as cargo test runs it, from its package's
    # directory: the lib's with the modules as its filters, the integration tests picked, the other crates' every one.
    test_binaries='select(.reason == "compiler-artifact" and .profile.test and .executable != null)
      | [.manifest_path, .target.name, .target.kind[0], .executable] | @tsv'
    picked_tests() {
      local manifest name kind exe dir status=0
      cargo test --locked --no-run --message-format=json-render-diagnostics "${packages[@]}" "${targets[@]}" \
        >"$tmp/tests.json" || return
      while IFS=$'\t' read -r manifest name kind exe; do
        dir=$(dirname "$manifest")
        filters=()
        if [ "$(basename "$dir")" = fleetd ]; then
          if [ "$kind" = lib ] && [ ${#mods[@]} -gt 0 ]; then
            filters=("${mods[@]}")
          elif [ "$kind" != test ] || [[ " ${itests[*]} " != *" $name "* ]]; then
            continue
          fi
        fi
        echo "     Running $name ($kind of ${dir#"$PWD"/}) ${filters[*]}"
        (cd "$dir" && CARGO_MANIFEST_DIR=$dir "$exe" "${filters[@]}") || status=1
      done < <(jq -r "$test_binaries" "$tmp/tests.json")
      return $status
    }
  fi
  if [ ${#mods[@]} -eq 0 ] && [ ${#itests[@]} -eq 0 ] && [ ${#crates[@]} -eq 0 ]; then
    if [ ${#named[@]} -gt 0 ]; then
      step rust-tests run_tests --workspace
    else
      echo "==> rust-tests: no change picks a test module; CI runs them all"
    fi
  fi
  if [ ${#packages[@]} -gt 0 ]; then
    echo "==> rust-tests: the tests of ${packages[*]} ${targets[*]}, in one cargo; in the lib, ${mods[*]:-none}"
    step rust-tests picked_tests
  fi
fi

if $site_wanted; then
  step site npm_ci docs/site
  step site npm run build --prefix docs/site
  if $built && [ -x "$target/debug/fleetd" ]; then
    "$target/debug/fleetd" help >"$help"
    step site node .github/site-check.mjs "$help"
  fi
  step site node .github/docs-links.mjs
  step site node .github/site-layout-check.mjs
fi
step site node .github/personal-check.mjs --untracked
step reverts scripts/reverts.sh origin/main

if wanted desktop app/desktop .github/workflows/ci.yml; then
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
  into=$(cd app/desktop && node qa/touched.ts "$@" "${touched[@]}") && return
  failed+=("qa: node app/desktop/qa/touched.ts $*")
  echo "==> FAILED qa: node app/desktop/qa/touched.ts $*"
  return 1
}
# The picked screens' tests: pnpm -C app/desktop qa --grep <touched.ts's regex>.
qa_picked() { pnpm -C app/desktop qa --grep "$grep"; }
if [[ " ${named[*]} " == *" qa "* ]]; then
  step qa pnpm -C app/desktop install --frozen-lockfile
  step qa pnpm -C app/desktop exec install-electron
  step qa fixtures
  step qa pnpm -C app/desktop qa:build
  step qa pnpm -C app/desktop qa:selftest
  step qa pnpm -C app/desktop qa
elif [ ${#named[@]} -eq 0 ] && changed app/desktop/src/renderer app/desktop/fixtures && ! passed_before qa; then
  mapfile -t touched < <(changed_files | sed -n 's|^app/desktop/||p')
  tests='' grep=''
  if touched tests --count && touched grep; then
    if [ "$tests" -gt $qa_most ]; then
      echo "==> qa: the change reaches $tests screens' tests, too many to run here: only its own run (scripts/check.sh qa runs every screen)"
      touched tests --near --count && touched grep --near || grep=''
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
elif [ ${#named[@]} -eq 0 ] && changed app/desktop .github/workflows/desktop-qa.yml &&
  ! changed app/desktop/src/renderer app/desktop/fixtures; then
  echo "==> qa: app/desktop changed; if a screen shows something new, scripts/check.sh qa runs every screen"
fi

# For fleetd's pre-push gate, newest last: "<key> <check>" for each check that passed (its key on the tree), and "<tree>"
# once every check the tree needs has passed on its key. A check run on every call (reverts, the identifier check) that
# fails records none, and a run that fails anything never marks its tree whole: a later run that passes does.
ran=("${named[@]}")
[ ${#named[@]} -gt 0 ] || ran=("${needed[@]}")
passed=("${ran[@]}")
whole=true
[ ${#failed[@]} -eq 0 ] || whole=false
for f in "${failed[@]}"; do
  [[ " ${ran[*]} " == *" ${f%%:*} "* ]] || passed=()
done
{
  tail -n 199 "$marks" 2>/dev/null
  for c in "${passed[@]}"; do
    printf '%s\n' "${failed[@]}" | grep -q "^$c:" || echo "$(key "$checked_tree" "$c") $c"
  done
} >"$tmp/checked"
for c in "${needed[@]}"; do grep -qxF "$(key "$checked_tree" "$c") $c" "$tmp/checked" || { whole=false; missing+=" $c"; }; done
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
