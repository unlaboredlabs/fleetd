#!/bin/bash
# Makes crates/fleetd/src/node/browser/agent_browser_shapes.json: the shapes of the scripts agent-browser evaluates,
# which a browser session that filled a login from 1Password lets through and no others (shapes.rs). Run it after
# changing agent-browser's version in agent_browser.rs, and commit the file:
#
#   scripts/agent-browser-shapes.sh
#
# It installs that version from npm into a temporary directory (without its install scripts), runs each of its commands
# against a local page on a Chrome (FLEETD_TEST_CHROME, Playwright's headless shell or google-chrome) through a relay
# that keeps every script, and writes their shapes. Needs Node.js (npm) and Rust.
set -euo pipefail

die() { printf 'agent-browser-shapes: %s\n' "$*" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/^pub const VERSION: &str = "\(.*\)";$/\1/p' "$root/crates/fleetd/src/node/browser/agent_browser.rs")"
[ -n "$version" ] || die "no VERSION in agent_browser.rs"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) binary=agent-browser-linux-x64 ;;
  Linux-aarch64) binary=agent-browser-linux-arm64 ;;
  Darwin-arm64) binary=agent-browser-darwin-arm64 ;;
  Darwin-x86_64) binary=agent-browser-darwin-x64 ;;
  *) die "agent-browser has no build for $(uname -s) $(uname -m)" ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
npm install --ignore-scripts --no-audit --no-fund --prefix "$work" "agent-browser@$version" >/dev/null
bin="$work/node_modules/agent-browser/bin/$binary"
chmod +x "$bin"

cd "$root"
FLEETD_TEST_AGENT_BROWSER="$bin" FLEETD_WRITE_SHAPES=1 \
  cargo test -p fleetd --lib -- --exact node::browser::tests::shapes::agent_browsers_scripts_are_all_pinned_shapes
printf 'wrote crates/fleetd/src/node/browser/agent_browser_shapes.json for agent-browser %s\n' "$version"
