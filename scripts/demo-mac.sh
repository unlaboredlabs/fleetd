#!/bin/bash
# Records the fleetd demo on a Mac, native window chrome and all, with one command:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/fleetd/main/scripts/demo-mac.sh)
#
# It runs the lab's demo order (tests/lab/demoFanout.ts: one tier-L order, three writers, reviewers and a verifier,
# the public testbed unlaboredlabs/fleetd-testbed through the merge train) on a hub and node of its own, with the
# app recording its own window (FLEETD_RECORD, no Screen Recording permission), and prints the MP4's path.
#
# The fleetd it runs is the nightly release: the CLI and fleetd.app from
# https://github.com/unlaboredlabs/fleetd/releases/download/nightly/, each checked against the release's SHA256SUMS
# as site/install.sh does, and the lab driver (tests/lab) checked out at the commit release.json names, so the two
# match. It prints that commit and its date, and refuses a nightly without the board pass (#138). FLEETD_DEMO_BUILD=1,
# or running it from a checkout, builds from source with cargo instead.
#
# Everything lives in FLEETD_DEMO_DIR (default ~/fleetd-demo): the binaries, the fleetd checkout, a pinned Node if
# yours is older than 24, a sandbox HOME for the hub, node, agents and app, the lab, the recordings. Your own
# ~/.fleetd and ~/.claude are never written; the hub and node run on lab ports (4795) and are stopped by PID.
# Installs nothing system-wide.
#
# Logins, read and copied into the sandbox, never changed:
# - GitHub: `gh auth token`, written into the sandbox's gh config for the run and deleted after it.
# - Claude: CLAUDE_CODE_OAUTH_TOKEN if you set it; else the login variables (gateway URL and token, API key) or
#   apiKeyHelper of your ~/.claude/settings.json, hooks and everything else left out; else a `claude setup-token`
#   token (one browser approval, pasted once, kept 0600 in the sandbox for the next run). Your /login itself sits in
#   the macOS Keychain, which a sandbox can't borrow without writing to it when claude refreshes it.
#
# Needs git, gh (logged in), claude and curl (and cargo to build). Costs about 20 haiku turns and 15 minutes.
# Ctrl-C stops everything it started; then run it again. Environment:
#   FLEETD_DEMO_DIR          the sandbox (default ~/fleetd-demo)
#   FLEETD_DEMO_BUILD=1      build from source instead of using the nightly
#   FLEETD_DEMO_REF          with FLEETD_DEMO_BUILD=1 and no checkout: the branch or tag to build (default main)
#   FLEETD_DEMO_ANY_COMMIT=1 skip the board-pass check (for trying the script itself)
set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'demo-mac: %s\n' "$*" >&2; exit 1; }

REPO=unlaboredlabs/fleetd
BOARD_PASS_PR=138

[ "$(uname -s)" = Darwin ] || die "this records the macOS app; on Linux use app/bench/record.sh"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P || true)"
in_checkout=0
if [ -n "$here" ] && [ -f "$here/tests/lab/demoFanout.ts" ] && [ -d "$here/app/record" ]; then in_checkout=1; fi
build=0
if [ "${FLEETD_DEMO_BUILD:-}" = 1 ] || [ "$in_checkout" = 1 ]; then build=1; fi
needs="git gh claude curl shasum"
[ "$build" = 1 ] && needs="$needs cargo"
for c in $needs; do
  command -v "$c" >/dev/null || die "$c is missing$([ "$c" = cargo ] && echo ' (install Rust from https://rustup.rs)')"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login"

SANDBOX="${FLEETD_DEMO_DIR:-$HOME/fleetd-demo}"
mkdir -p "$SANDBOX" && chmod 700 "$SANDBOX"
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
case "$SANDBOX/" in "$HOME/.fleetd/"* | "$HOME/.claude/"*) die "FLEETD_DEMO_DIR must not be inside ~/.fleetd or ~/.claude" ;; esac
H="$SANDBOX/home"
mkdir -p "$H/.claude" "$H/.config/gh" "$SANDBOX/recordings"
# The GitHub token is only on disk while the demo runs.
trap 'rm -f "$H/.config/gh/hosts.yml"' EXIT

# fetch <asset> <dest>: one nightly asset, checked against SHA256SUMS exactly as site/install.sh checks it.
base="https://github.com/$REPO/releases/download/nightly"
fetch() {
  expected="$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1 }' "$nightly/SHA256SUMS")"
  [ -n "$expected" ] || die "the nightly has no $1"
  curl -fsSL --retry 3 -o "$2" "$base/$1" || die "download failed: $base/$1"
  actual="$(shasum -a 256 "$2" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || { rm -f "$2"; die "checksum mismatch for $1 (expected $expected, got $actual)"; }
}

# Also the checkout the lab driver runs from: at the nightly's commit, at FLEETD_DEMO_REF, or this one.
clone_at() {
  [ -d "$repo/.git" ] || git clone -q "https://github.com/$REPO" "$repo"
  git -C "$repo" fetch -q origin "$1"
  git -C "$repo" checkout -q --detach FETCH_HEAD
}

repo="$SANDBOX/fleetd"
if [ "$build" = 0 ]; then
  nightly="$SANDBOX/nightly"
  rm -rf "$nightly" && mkdir -p "$nightly"
  curl -fsSL --retry 3 -o "$nightly/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS"
  curl -fsSL --retry 3 -o "$nightly/release.json" "$base/release.json" || die "could not download $base/release.json"
  field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$nightly/release.json" | head -1; }
  commit="$(field commit)"
  app_commit="$(field appCommit)"
  [ -n "$commit" ] || die "release.json names no commit"
  [ -z "$app_commit" ] || [ "$app_commit" = "$commit" ] || die "the nightly's app ($app_commit) and CLI ($commit) come from different commits"
  say "Nightly $(field version): commit $commit, built $(field date)"
  clone_at "$commit"
  case "$(uname -m)" in arm64) cli_asset=fleetd-darwin-arm64 ;; x86_64) cli_asset=fleetd-darwin-x64 ;; *) die "no fleetd for $(uname -m)" ;; esac
  fetch "$cli_asset" "$nightly/fleetd"
  chmod 755 "$nightly/fleetd"
  fetch fleetd-app-macos-universal.zip "$nightly/app.zip"
  ditto -x -k "$nightly/app.zip" "$nightly" && rm -f "$nightly/app.zip"
  app="$nightly/fleetd.app/Contents/MacOS/fleetd-app"
  [ -x "$app" ] || die "the app archive has no fleetd.app"
  fleetd_bin="$nightly/fleetd"
else
  if [ "$in_checkout" = 1 ]; then repo="$here"; else clone_at "${FLEETD_DEMO_REF:-main}"; fi
  commit="$(git -C "$repo" rev-parse HEAD)"
  say "Building fleetd $(git -C "$repo" rev-parse --short HEAD) from $repo (release; the first build takes a while)"
  (cd "$repo" && cargo build --release --locked -p fleetd -p fleetd-app)
  app="$repo/target/release/fleetd-app"
  fleetd_bin="$repo/target/release/fleetd"
fi

# The recording is only worth making with the board pass in; and the lab driver must know FLEETD_DEMO_APP (#136).
grep -q FLEETD_DEMO_APP "$repo/tests/lab/demoFanout.ts" ||
  die "fleetd $commit predates the demo recorder (#136); wait for a nightly that has it"
if [ "${FLEETD_DEMO_ANY_COMMIT:-}" != 1 ]; then
  merged="$(gh pr view "$BOARD_PASS_PR" -R "$REPO" --json mergeCommit --jq '.mergeCommit.oid // ""')"
  [ -n "$merged" ] || die "the board pass (#$BOARD_PASS_PR) isn't merged yet, so fleetd $commit doesn't have it; run this again once it is and a nightly has been built"
  git -C "$repo" cat-file -e "$merged^{commit}" 2>/dev/null || git -C "$repo" fetch -q origin main
  git -C "$repo" merge-base --is-ancestor "$merged" "$commit" ||
    die "fleetd $commit predates the board pass (#$BOARD_PASS_PR, $merged); wait for the next nightly, or set FLEETD_DEMO_BUILD=1 to build main"
fi

# Node 24 or newer for the lab driver; else a pinned build in the sandbox, checked against nodejs.org's SHASUMS256.
NODE_VERSION=v24.22.0
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; }
if ! node_ok; then
  case "$(uname -m)" in
    arm64) arch=arm64 sum=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5 ;;
    x86_64) arch=x64 sum=495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91 ;;
    *) die "no Node build for $(uname -m)" ;;
  esac
  dir="$SANDBOX/node-$NODE_VERSION-darwin-$arch"
  if [ ! -x "$dir/bin/node" ]; then
    say "Fetching Node $NODE_VERSION into the sandbox"
    tgz="$SANDBOX/node-$NODE_VERSION-darwin-$arch.tar.gz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz" -o "$tgz"
    echo "$sum  $tgz" | shasum -a 256 -c - >/dev/null || { rm -f "$tgz"; die "the Node download does not match its checksum"; }
    tar -xzf "$tgz" -C "$SANDBOX" && rm -f "$tgz"
  fi
  PATH="$dir/bin:$PATH"
fi
(cd "$repo/tests/lab" && npm ci --no-audit --no-fund --silent)

# The sandbox HOME: git identity, gh login and claude login, copied in.
name="$(git config --global user.name || echo 'fleetd demo')"
email="$(git config --global user.email || echo 'demo@localhost')"
printf '[user]\n\tname = %s\n\temail = %s\n[init]\n\tdefaultBranch = main\n' "$name" "$email" >"$H/.gitconfig"
(umask 077 && printf 'github.com:\n    oauth_token: %s\n    user: %s\n    git_protocol: https\n' \
  "$(gh auth token)" "$(gh api user --jq .login)" >"$H/.config/gh/hosts.yml")

token_file="$SANDBOX/claude-oauth-token"
login_json=""
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  login_json="$(node -e 'console.log(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } }))')"
  say "Claude: CLAUDE_CODE_OAUTH_TOKEN from your environment"
elif [ ! -s "$token_file" ] && [ -f "$HOME/.claude/settings.json" ]; then
  # Only the login variables and apiKeyHelper; never hooks, plugins or permissions.
  login_json="$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const keys = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];
    const env = Object.fromEntries(keys.filter((k) => typeof s.env?.[k] === "string" && s.env[k] !== "").map((k) => [k, s.env[k]]));
    const out = { env, ...(typeof s.apiKeyHelper === "string" ? { apiKeyHelper: s.apiKeyHelper } : {}) };
    if (Object.keys(env).length > 0 || out.apiKeyHelper) console.log(JSON.stringify(out));
  ' "$HOME/.claude/settings.json")"
  [ -z "$login_json" ] || say "Claude: the login settings of your ~/.claude/settings.json"
fi
if [ -z "$login_json" ]; then
  if [ ! -s "$token_file" ]; then
    say "Claude: a token for the sandbox. Approve in the browser, then paste the token it prints."
    # Its own config dir, so nothing of this lands in ~/.claude.
    CLAUDE_CONFIG_DIR="$SANDBOX/claude-setup" claude setup-token </dev/tty
    printf 'Paste the token (sk-ant-oat...): ' >/dev/tty
    IFS= read -rs token </dev/tty
    echo >/dev/tty
    case "$token" in sk-ant-*) ;; *) die "that does not look like a claude setup-token token" ;; esac
    (umask 077 && printf '%s\n' "$token" >"$token_file")
  fi
  login_json="$(CLAUDE_CODE_OAUTH_TOKEN="$(cat "$token_file")" node -e 'console.log(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN } }))')"
  say "Claude: the sandbox token in $token_file"
fi
(umask 077 && printf '%s\n' "$login_json" >"$H/.claude/settings.json")

# One tiny turn, so a bad login stops here and not ten minutes in.
reply="$(cd "$SANDBOX" && env -i HOME="$H" PATH="$PATH" USER="$USER" LANG="${LANG:-en_US.UTF-8}" CLAUDE_CONFIG_DIR="$H/.claude" \
  claude -p "Reply with the single word OK and nothing else." --model claude-haiku-5-5 2>&1 || true)"
case "$reply" in *OK*) say "Claude answers" ;; *) die "claude in the sandbox did not answer: $reply" ;; esac

lab="$SANDBOX/lab"
[ -d "$lab/testbed/.git" ] || HOME="$H" git clone -q https://github.com/unlaboredlabs/fleetd-testbed "$lab/testbed"

rec="$SANDBOX/recordings/$(date +%Y%m%d-%H%M%S)"
say "Running the demo order; the app opens and records itself. Leave the Mac awake and the window in view."
set +e
(cd "$repo/tests/lab" && env -i HOME="$H" PATH="$PATH" USER="$USER" LANG="${LANG:-en_US.UTF-8}" \
  FLEETD_LAB="$lab" FLEETD_LAB_SLOT=0 FLEETD_BIN="$fleetd_bin" FLEETD_DEMO_APP="$app" FLEETD_DEMO_RECORD="$rec" \
  node testLab.ts demo)
status=$?
set -e
mp4="$rec/fleetd.mp4"
timeline="$lab/e2e-4795/demo/timeline.jsonl"
[ -f "$timeline" ] && cp "$timeline" "$rec/"
if [ -s "$mp4" ]; then
  say "Recording: $mp4"
  echo "Milestones (wall clock, for the cut): $rec/timeline.jsonl; stills every 2 s: $rec/frames/"
fi
[ "$status" -eq 0 ] || die "the demo run failed (exit $status); its logs are in $lab/e2e-4795/logs"
[ -s "$mp4" ] || die "no recording at $mp4; see $lab/e2e-4795/demo/app.log"
