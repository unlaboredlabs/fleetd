#!/usr/bin/env bash
# CI's quick Linux checks, run before a push, for what changed since origin/main (committed or not):
#
#   scripts/check.sh              the checks the changes touch
#   scripts/check.sh <check>...   these, changed or not: rust-lint rust-docs rust-tests site desktop qa
#
# Each runs the commands of its ci.yml job, scoped as CI scopes it (.github/rust-scope.sh's paths for the Rust ones):
# - rust-lint: cargo fmt --check, clippy -D warnings, and the hub migrations check against origin/main.
# - rust-docs: the docs' generated pages (docsgen --check), `fleetd help` for the site check, the lab scenarios.
# - rust-tests: the workspace tests of the modules the changed files are in, two levels deep (a change to
#   crates/fleetd/src/hub/train/batch.rs runs hub::train::), and the other crates' tests whole. CI's `rust (linux)`
#   runs every test and the doctests.
# - site: a build of docs/site, the site's pages and links, no personal identifiers, and the landing page fits every
#   width. The identifier check runs on every call; it reads every tracked file.
# - desktop: app/desktop's case clashes, typecheck, lint and unit tests.
# - reverts: on every call, whether HEAD would undo work already on origin/main (scripts/reverts.sh, the merge train's
#   own check before review): a commit made on a fresh main while its files were an older tree's.
# - qa: desktop-qa.yml's screens, all shards in one run. It takes long, so it runs only when named; a run that touches
#   app/desktop says so.
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

if wanted rust-lint "${rust_paths[@]}"; then
  step rust-lint cargo fmt --all --check
  step rust-lint cargo clippy --locked --workspace --all-targets -- -D warnings
  step rust-lint node .github/migrations-check.mjs origin/main
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
step site node .github/personal-check.mjs
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

if [[ " ${named[*]} " == *" qa "* ]]; then
  step qa pnpm -C app/desktop install --frozen-lockfile
  step qa pnpm -C app/desktop fixtures
  step qa pnpm -C app/desktop qa:build
  step qa pnpm -C app/desktop qa:selftest
  step qa pnpm -C app/desktop qa
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
