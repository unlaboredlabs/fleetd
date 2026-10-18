#!/bin/bash
# Records the fleetd demo on a Mac, native window chrome and all, with one command:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/fleetd/main/scripts/demo-mac.sh)
#
# It runs the lab's demo order (tests/lab/demoFanout.ts: one tier-L order, three writers, reviewers and a verifier,
# the public testbed unlaboredlabs/fleetd-testbed through the merge train) on a hub and node of its own, with the
# app recording its own window (FLEETD_RECORD, no Screen Recording permission), and prints the MP4's path.
#
# Everything lives in FLEETD_DEMO_DIR (default ~/fleetd-demo): the fleetd checkout and build, a pinned Node if
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
# Needs git, gh (logged in), claude, cargo (https://rustup.rs) and curl. Costs about 20 haiku turns and 15 minutes.
# Ctrl-C stops everything it started; then run it again. Environment:
#   FLEETD_DEMO_DIR  the sandbox (default ~/fleetd-demo)
#   FLEETD_DEMO_REF  the fleetd branch or tag to build when not run from a checkout (default main)
set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'demo-mac: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this records the macOS app; on Linux use app/bench/record.sh"
for c in git gh claude cargo curl shasum; do
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

# The checkout: this one when run from it, else a clone of FLEETD_DEMO_REF in the sandbox.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P || true)"
if [ -n "$here" ] && [ -f "$here/tests/lab/demoFanout.ts" ] && [ -d "$here/app/record" ]; then
  repo="$here"
else
  repo="$SANDBOX/fleetd"
  ref="${FLEETD_DEMO_REF:-main}"
  [ -d "$repo/.git" ] || git clone -q https://github.com/unlaboredlabs/fleetd "$repo"
  git -C "$repo" fetch -q origin "$ref"
  git -C "$repo" checkout -q --detach FETCH_HEAD
fi
say "fleetd $(git -C "$repo" rev-parse --short HEAD) in $repo"

say "Building fleetd and the app (release; the first build takes a while)"
(cd "$repo" && cargo build --release --locked -p fleetd -p fleetd-app)
app="$repo/target/release/fleetd-app"

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
  FLEETD_LAB="$lab" FLEETD_LAB_SLOT=0 FLEETD_DEMO_APP="$app" FLEETD_DEMO_RECORD="$rec" \
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
