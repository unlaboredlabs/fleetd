#!/bin/bash
# Records the fleetd demo on a Mac, native window chrome and all, with one command:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/fleetd/main/scripts/demo-mac.sh)
#
# It runs the lab's demo order (tests/lab/demoFanout.ts: one tier-L order, three writers, reviewers and a verifier,
# the public testbed unlaboredlabs/fleetd-testbed through the merge train) on a hub and node of its own, with the
# desktop app (app/desktop, Electron) recording its own window and prints the MP4's path. The app records its page
# through Chromium's own capture (FLEETD_RECORD), so there is no Screen Recording permission and no ffmpeg; the
# macOS traffic lights are not in the picture.
#
# The fleetd it runs is the nightly release: the CLI and the desktop app (fleetd-desktop-macos-universal.zip) from
# https://github.com/unlaboredlabs/fleetd/releases/download/nightly/, each checked against the release's SHA256SUMS
# as site/install.sh does, and the lab driver (tests/lab) checked out at the commit release.json names, so the two
# match. It prints that commit and its date, and refuses a nightly without the board pass (#138). FLEETD_DEMO_BUILD=1,
# or running it from a checkout, builds from source instead (cargo for the CLI, pnpm for the app).
#
# Everything lives in FLEETD_DEMO_DIR (default ~/fleetd-demo): the binaries, the fleetd checkout, a pinned Node if
# yours is older than 24, a sandbox HOME for the hub, node, agents and app, the lab, the recordings. Your own
# ~/.fleetd and ~/.claude are never written; the hub and node run on lab ports and are stopped by PID.
# Installs nothing system-wide.
#
# Logins, read and copied into the sandbox, never changed:
# - GitHub: `gh auth token`, written into the sandbox's gh config for the run and deleted after it.
# - Claude: CLAUDE_CODE_OAUTH_TOKEN if you set it; else the login variables (gateway URL and token, API key) or
#   apiKeyHelper of your ~/.claude/settings.json, hooks and everything else left out; else a `claude setup-token`
#   token (one browser approval, pasted once, kept 0600 in the sandbox for the next run). Your /login itself sits in
#   the macOS Keychain, which a sandbox can't borrow without writing to it when claude refreshes it.
#
# Needs git, gh (logged in), claude and curl (and cargo and pnpm to build). Costs about 20 haiku turns and 15 minutes.
# Ctrl-C stops everything it started; then run it again. Environment:
#   FLEETD_DEMO_DIR          the sandbox (default ~/fleetd-demo)
#   FLEETD_DEMO_BUILD=1      build from source instead of using the nightly
#   FLEETD_DEMO_REF          with FLEETD_DEMO_BUILD=1 and no checkout: the branch or tag to build (default main)
#   FLEETD_DEMO_ANY_COMMIT=1 skip the board-pass check (for trying the script itself)
#
# It drives lab slot 9 (ports 4975 and up) against unlaboredlabs/fleetd-testbed. Ctrl-C, or any exit, stops the
# demo driver, which closes this run's PRs and stops the hub, node and app by their PIDs; then this script stops
# whatever is still running from the PIDs it recorded, closes what its testbed ledger lists, and deletes every copy
# of the logins it made.
set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'demo-mac: %s\n' "$*" >&2; exit 1; }

REPO=unlaboredlabs/fleetd
BOARD_PASS_PR=138

[ "$(uname -s)" = Darwin ] || die "this records the macOS app; on Linux, app/desktop's pnpm perf:record exercises the recorder"
user="${USER:-$(id -un)}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P || true)"
in_checkout=0
if [ -n "$here" ] && [ -f "$here/tests/lab/demoFanout.ts" ] && [ -f "$here/app/desktop/package.json" ]; then in_checkout=1; fi
build=0
if [ "${FLEETD_DEMO_BUILD:-}" = 1 ] || [ "$in_checkout" = 1 ]; then build=1; fi
# /usr/bin/git is a stub that offers to install the Command Line Tools; run it to know.
git --version >/dev/null 2>&1 || die "git needs the Command Line Tools: xcode-select --install"
needs="gh claude curl shasum ditto"
[ "$build" = 1 ] && needs="$needs cargo pnpm"
for c in $needs; do
  case "$c" in cargo) hint=' (install Rust from https://rustup.rs)' ;; pnpm) hint=' (https://pnpm.io/installation)' ;; *) hint='' ;; esac
  command -v "$c" >/dev/null || die "$c is missing$hint"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in: gh auth login"

# The sandbox: checked before anything is created or changed, then again once symlinks are resolved.
SANDBOX="${FLEETD_DEMO_DIR:-$HOME/fleetd-demo}"
refuse() {
  case "${1%/}/" in
    "${2%/}/" | "${2%/}/.fleetd/"* | "${2%/}/.claude/"*) die "FLEETD_DEMO_DIR must not be your home, ~/.fleetd or ~/.claude (got $SANDBOX)" ;;
  esac
}
refuse "$SANDBOX" "$HOME"
mkdir -p "$SANDBOX"
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
refuse "$SANDBOX" "$(cd "$HOME" && pwd -P)"
chmod 700 "$SANDBOX"
H="$SANDBOX/home"
mkdir -p "$H/.claude" "$H/.config/gh" "$SANDBOX/recordings"

TESTBED_REPO=unlaboredlabs/fleetd-testbed
lab="$SANDBOX/lab"
slot="$lab/slot-9"
run="$slot/e2e-4975"
ledger="$slot/demo-testbed.ledger"
lab_pid=""

# stop_pid <pid> <binary>: only if that pid still runs that binary; TERM, then KILL after 30 s.
stop_pid() {
  ps -p "$1" -o command= 2>/dev/null | grep -qF "$2" || return 0
  kill -TERM "$1" 2>/dev/null || return 0
  for _ in $(seq 30); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  kill -KILL "$1" 2>/dev/null || true
}

# On every exit: the driver cleans up after itself (its PRs, then its processes by PID); this is the backstop for a
# driver that was killed before it could.
cleanup() {
  status=$?
  # A second Ctrl-C would cut the cleanup short, leaving PRs open and processes running.
  trap '' INT TERM HUP
  if [ -n "$lab_pid" ] && kill -0 "$lab_pid" 2>/dev/null; then
    say "Stopping the demo run; it closes its PRs and stops what it started"
    kill -TERM "$lab_pid" 2>/dev/null || true
    for _ in $(seq 180); do kill -0 "$lab_pid" 2>/dev/null || break; sleep 1; done
    kill -KILL "$lab_pid" 2>/dev/null || true
  fi
  if [ -f "$run/pids" ]; then
    while read -r pid bin; do stop_pid "$pid" "$bin"; done <"$run/pids"
  fi
  if [ -s "$ledger" ]; then
    while read -r kind value; do
      case "$kind" in
        pr) if [ "$(gh pr view "$value" -R "$TESTBED_REPO" --json state --jq .state 2>/dev/null)" = OPEN ]; then
          gh pr close "$value" -R "$TESTBED_REPO" --delete-branch >/dev/null 2>&1 || true
        fi ;;
        branch) gh api -X DELETE "repos/$TESTBED_REPO/git/refs/heads/$value" >/dev/null 2>&1 || true ;;
      esac
    done <"$ledger"
    rm -f "$ledger"
  fi
  # Every copy of the logins: the sandbox HOME's gh token and each lab machine's gh and claude copies.
  rm -f "$H/.config/gh/hosts.yml"
  rm -rf "$slot"/e2e-*/home-*/.config/gh
  rm -f "$slot"/e2e-*/home-*/.claude/settings.json "$slot"/e2e-*/home-*/.claude/.credentials.json
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

# fetch <asset> <dest>: one nightly asset, checked against SHA256SUMS exactly as site/install.sh checks it.
base="https://github.com/$REPO/releases/download/nightly"
fetch() {
  expected="$(awk -v n="$1" '$2 == n || $2 == "*" n { print $1 }' "$nightly/SHA256SUMS")"
  [ -n "$expected" ] || die "the nightly has no $1"
  curl -fsSL --retry 3 -o "$2" "$base/$1" || die "download failed: $base/$1"
  actual="$(shasum -a 256 "$2" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || { rm -f "$2"; die "checksum mismatch for $1 (expected $expected, got $actual)"; }
}

# The checkout the lab driver runs from, with main's history for the checks below.
repo="$SANDBOX/fleetd"
clone_at() {
  [ -d "$repo/.git" ] || git clone -q "https://github.com/$REPO" "$repo"
  git -C "$repo" fetch -q origin main
  git -C "$repo" fetch -q origin "$1"
  git -C "$repo" checkout -q --detach FETCH_HEAD
}

# Node 24 or newer for the lab driver (and the app build); else a pinned build in the sandbox, checked against nodejs.org's SHASUMS256.
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
if [ "$build" = 0 ]; then
  nightly="$SANDBOX/nightly"
  rm -rf "$nightly" && mkdir -p "$nightly"
  curl -fsSL --retry 3 -o "$nightly/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS"
  curl -fsSL --retry 3 -o "$nightly/release.json" "$base/release.json" || die "could not download $base/release.json"
  field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$nightly/release.json" | head -1; }
  # A nightly republishes the CLI and the app only when they changed, so each can come from an older commit than
  # the release's: the app's is appCommit, the CLI's the commit its version ends in.
  cli_version="$(field cliVersion)"
  app_commit="$(field appCommit)"
  [ -n "$cli_version" ] && [ -n "$app_commit" ] || die "release.json names no cliVersion or appCommit"
  clone_at "$app_commit"
  cli_commit="$(git -C "$repo" rev-parse -q --verify "${cli_version##*.}^{commit}")" ||
    die "can't find the commit of the nightly's CLI ($cli_version)"
  git -C "$repo" checkout -q --detach "$cli_commit"
  say "Nightly published $(field date): CLI $cli_version (${cli_commit:0:7}), app $(field appVersion) (${app_commit:0:7})"
  case "$(uname -m)" in arm64) cli_asset=fleetd-darwin-arm64 ;; x86_64) cli_asset=fleetd-darwin-x64 ;; *) die "no fleetd for $(uname -m)" ;; esac
  fetch "$cli_asset" "$nightly/fleetd"
  chmod 755 "$nightly/fleetd"
  awk '$2 == "fleetd-desktop-macos-universal.zip" || $2 == "*fleetd-desktop-macos-universal.zip" { found = 1 } END { exit !found }' "$nightly/SHA256SUMS" ||
    die "the nightly has no desktop app yet (its release builds it once FLEETD_RELEASE_DESKTOP is on); set FLEETD_DEMO_BUILD=1 to build it"
  fetch fleetd-desktop-macos-universal.zip "$nightly/app.zip"
  rm -rf "$nightly/fleetd.app"
  ditto -x -k "$nightly/app.zip" "$nightly" && rm -f "$nightly/app.zip"
  app="$nightly/fleetd.app/Contents/MacOS/fleetd"
  [ -x "$app" ] || die "the app archive has no fleetd.app"
  fleetd_bin="$nightly/fleetd"
else
  if [ "$in_checkout" = 1 ]; then repo="$here"; else clone_at "${FLEETD_DEMO_REF:-main}"; fi
  cli_commit="$(git -C "$repo" rev-parse HEAD)"
  app_commit="$cli_commit"
  say "Building fleetd ${cli_commit:0:7} from $repo (release; the first build takes a while)"
  (cd "$repo" && cargo build --release --locked -p fleetd)
  (cd "$repo/app/desktop" && pnpm install --frozen-lockfile && pnpm build)
  # The driver starts the app as one executable with no arguments; this one runs Electron on the built app. Its own
  # path stays on the command line (the unused switch), so the PID checks below still find it.
  app="$SANDBOX/fleetd-desktop"
  # Requiring the package fetches Electron's binary on first use; its progress goes to stderr, the path to $electron.
  (cd "$repo/app/desktop" && node -e 'require("electron")' >&2)
  electron="$(cd "$repo/app/desktop" && node -p 'require("electron")')"
  # shellcheck disable=SC2016 # $0 and $@ belong to the wrapper.
  printf '#!/bin/sh\nexec "%s" "%s" --fleetd-launcher="$0" "$@"\n' "$electron" "$repo/app/desktop" >"$app"
  chmod 755 "$app"
  fleetd_bin="$repo/target/release/fleetd"
fi

# The app must have the desktop recorder and the lab driver FLEETD_DEMO_APP (#136); both must have the board pass (#138).
git -C "$repo" cat-file -e "$app_commit:app/desktop/src/main/instrument/record.ts" 2>/dev/null ||
  die "the app (${app_commit:0:7}) predates the desktop app's recorder; wait for a nightly with it, or set FLEETD_DEMO_BUILD=1"
grep -q FLEETD_DEMO_APP "$repo/tests/lab/demoFanout.ts" ||
  die "the lab driver at ${cli_commit:0:7} predates the demo recorder (#136); wait for a nightly with it"
if [ "${FLEETD_DEMO_ANY_COMMIT:-}" != 1 ]; then
  # The commit that landed it on main, whatever became of the PR: its own squash or a train batch's, whose subject
  # lists every PR it carries.
  git -C "$repo" fetch -q origin main
  merged="$(git -C "$repo" log --fixed-strings --grep "(#$BOARD_PASS_PR)" -1 --format=%H origin/main)"
  [ -n "$merged" ] || die "the board pass (#$BOARD_PASS_PR) isn't on main yet; run this again once it is and a nightly has it"
  for part in "CLI $cli_commit" "app $app_commit"; do
    git -C "$repo" merge-base --is-ancestor "$merged" "${part#* }" ||
      die "the nightly's ${part% *} (${part#* }) predates the board pass (#$BOARD_PASS_PR); wait for the next nightly, or set FLEETD_DEMO_BUILD=1 to build main"
  done
fi

# The sandbox HOME, so npm reads no ~/.npmrc and caches nothing in ~/.npm; no package needs an install script.
(cd "$repo/tests/lab" && HOME="$H" npm ci --ignore-scripts --no-audit --no-fund --silent)

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
reply="$(cd "$SANDBOX" && env -i HOME="$H" PATH="$PATH" USER="$user" LANG="${LANG:-en_US.UTF-8}" CLAUDE_CONFIG_DIR="$H/.claude" \
  claude -p "Reply with the single word OK and nothing else." --model claude-haiku-5-5 2>&1 || true)"
case "$reply" in *OK*) say "Claude answers" ;; *) die "claude in the sandbox did not answer: $reply" ;; esac

[ -d "$slot/testbed/.git" ] || HOME="$H" git clone -q "https://github.com/$TESTBED_REPO" "$slot/testbed"

rec="$SANDBOX/recordings/$(date +%Y%m%d-%H%M%S)"
say "Running the demo order; the app opens and records itself. Leave the Mac awake."
# In the background, so a signal reaches the trap at once and the trap hands it on to the driver.
(cd "$repo/tests/lab" && exec env -i HOME="$H" PATH="$PATH" USER="$user" LANG="${LANG:-en_US.UTF-8}" \
  FLEETD_LAB="$lab" FLEETD_LAB_SLOT=9 FLEETD_BIN="$fleetd_bin" FLEETD_DEMO_APP="$app" FLEETD_DEMO_RECORD="$rec" \
  node testLab.ts demo) &
lab_pid=$!
status=0
wait "$lab_pid" || status=$?
lab_pid=""
mp4="$rec/clip.mp4"
[ -f "$run/demo/timeline.jsonl" ] && cp "$run/demo/timeline.jsonl" "$rec/"
if [ -s "$mp4" ]; then
  say "Recording: $mp4"
  echo "From just before the order is typed to 3 s after the last merge. The whole capture: $rec/fleetd.mp4;"
  echo "milestones (wall clock): $rec/timeline.jsonl; stills every 2 s: $rec/frames/"
fi
[ "$status" -eq 0 ] || die "the demo run failed (exit $status); its logs are in $run/logs"
[ -s "$mp4" ] || die "no recording at $mp4; see $run/demo/app.log"
