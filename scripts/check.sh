#!/usr/bin/env bash
# CI's quick Linux checks, run before a push, for what changed since origin/main (committed or not):
#
#   scripts/check.sh              the checks the changes touch
#   scripts/check.sh <check>...   these, changed or not: rust-lint rust-docs rust-tests site desktop qa
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
# - qa: desktop-qa.yml's screens, all shards in one run. It takes long, so it runs only when named. With no check named,
#   a change to app/desktop's renderer or fixtures runs the screens it shows (app/desktop/qa/touched.ts picks them; past
#   150 tests, only its own: its fixtures' and its page's or directory's): a screen that asks the hub something new
#   fails there when one of its fixtures has no answer for it.
#
# It runs them all, then names each one that failed, with its command, and exits 1. It fetches origin/main first, and
# doesn't install toolchains: cargo, node 24 and pnpm, and cargo-nextest if it's there (else cargo test).
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

all=(rust-lint rust-docs rust-tests site desktop qa)
for name in "$@"; do
  [[ " ${all[*]} " == *" $name "* ]] || { echo "unknown check: $name (checks: ${all[*]})" >&2; exit 2; }
done

git fetch -q origin main || echo "check.sh: couldn't fetch origin/main; comparing with the one fetched before" >&2
base=$(git merge-base origin/main HEAD) || exit 1
tmp=$(mktemp -d "${TMPDIR:-/tmp}/check.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
target=${CARGO_TARGET_DIR:-target}
[[ $target == /* ]] || target=$PWD/$target

# changed <path>...: whether a path under these differs from the base, in a commit, the worktree or an untracked file.
changed() {
  ! git diff --quiet "$base" -- "$@" || [ -n "$(git ls-files --others --exclude-standard -- "$@")" ]
}
changed_files() {
  { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u
}
# wanted <check> <path>...: named on the command line, or (with none named) one of its paths changed.
wanted() {
  local check=$1
  shift
  if [ ${#named[@]} -gt 0 ]; then [[ " ${named[*]} " == *" $check "* ]]; return; fi
  changed "$@"
}
named=("$@")

failed=()
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

# .github/rust-scope.sh's paths, read from it so the two never differ.
eval "$(sed -n '/^paths=(/,/^)$/p' .github/rust-scope.sh)"
# shellcheck disable=SC2154
rust_paths=("${paths[@]}")

# The worktree as CI's merge commit would hold it: committed or not (untracked files too, but not ignored ones), merged
# onto origin/main. A merge that conflicts still writes its tree, the conflicts marked.
merged() {
  local index=$tmp/index tree commit out
  cp "$(git rev-parse --git-path index)" "$index" && GIT_INDEX_FILE=$index git add -A &&
    tree=$(GIT_INDEX_FILE=$index git write-tree) && commit=$(git commit-tree "$tree" -p HEAD -m check.sh) || return
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

help=$tmp/fleetd-help.txt
site_wanted=false
wanted site docs/site site .github/site-check.mjs .github/site-layout-check.mjs .github/docs-links.mjs \
  .github/docs-serve.mjs "${rust_paths[@]}" && site_wanted=true
if wanted rust-docs "${rust_paths[@]}"; then
  step rust-docs cargo build --locked -p fleetd -p docsgen
  # Fix: cargo run -q -p docsgen, and commit the pages it wrote.
  step rust-docs cargo run --locked -q -p docsgen -- --check
  step rust-docs npm_ci tests/lab
  # A short directory: the node's socket path in it must fit in SUN_LEN (108 bytes).
  export FLEETD_BIN=$target/debug/fleetd FLEETD_FACTORY_DIR=$tmp/f
  step rust-docs npm run factory --prefix tests/lab
elif $site_wanted; then
  step site cargo build --locked -p fleetd
fi

if wanted rust-tests "${rust_paths[@]}"; then
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
      crates/fleetd/tests/*.rs) [ -e "$f" ] && itests+=(--test "$(basename "$f" .rs)") ;;
      crates/fleetd/*) ;;
      crates/*/*) c=${f#crates/}; crates+=("${c%%/*}") ;;
    esac
  done < <(changed_files)
  if [ ${#named[@]} -gt 0 ] || changed crates/fleetd-contracts app/desktop/src/shared/contracts/generated; then
    # Fix: cargo run -p fleetd-contracts --bin fleetd-schema, and commit what it wrote.
    step rust-tests cargo run --locked -q -p fleetd-contracts --bin fleetd-schema -- --check
  fi
  mapfile -t mods < <(printf '%s\n' "${mods[@]}" | sort -u | sed '/^$/d')
  mapfile -t crates < <(printf '%s\n' "${crates[@]}" | sort -u | sed '/^$/d')
  if cargo nextest --version >/dev/null 2>&1; then
    run_tests() { cargo nextest run --locked --no-tests=pass "$@"; }
  else
    run_tests() {
      local args=() filters=() seen=false
      for a in "$@"; do if [ "$a" = -- ]; then seen=true; elif $seen; then filters+=("$a"); else args+=("$a"); fi; done
      cargo test --locked "${args[@]}" -- "${filters[@]}"
    }
  fi
  if [ ${#mods[@]} -eq 0 ] && [ ${#itests[@]} -eq 0 ] && [ ${#crates[@]} -eq 0 ]; then
    if [ ${#named[@]} -gt 0 ]; then
      step rust-tests run_tests --workspace
    else
      echo "==> rust-tests: no change picks a test module; CI runs them all"
    fi
  fi
  [ ${#mods[@]} -gt 0 ] && step rust-tests run_tests -p fleetd --lib -- "${mods[@]}"
  [ ${#itests[@]} -gt 0 ] && step rust-tests run_tests -p fleetd "${itests[@]}"
  for c in "${crates[@]}"; do step rust-tests run_tests -p "$c"; done
fi

if $site_wanted; then
  step site npm_ci docs/site
  step site npm run build --prefix docs/site
  if [ -x "$target/debug/fleetd" ]; then
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
elif [ ${#named[@]} -eq 0 ] && changed app/desktop/src/renderer app/desktop/fixtures; then
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
elif [ ${#named[@]} -eq 0 ] && changed app/desktop .github/workflows/desktop-qa.yml; then
  echo "==> qa: app/desktop changed; if a screen shows something new, scripts/check.sh qa runs the screens CI runs"
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo
  echo "check.sh: ${#failed[@]} failed:"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi
echo
echo "check.sh: all passed"
