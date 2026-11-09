#!/bin/bash
# Makes experimental/bun/src/node/browser/agent_browser_shapes.json: the shapes of the scripts agent-browser evaluates,
# which a browser session that filled a login from 1Password lets through and no others (shapes.ts). Run it after
# changing agent-browser's version in agent_browser.ts, and commit the file:
#
#   scripts/agent-browser-shapes.sh
#
# It installs that version from npm into a temporary directory (without its install scripts), runs each of its commands
# against a local page on a Chrome (FLEETD_TEST_CHROME, else Playwright's headless shell) through a relay that keeps
# every script, and writes their shapes (test/agent-browser-shapes.test.ts). Needs Node.js (npm) and Bun.
set -euo pipefail

die() { printf 'agent-browser-shapes: %s\n' "$*" >&2; exit 1; }

root="$(cd "$(dirname "$0")/.." && pwd)"
bun_dir="$root/experimental/bun"
version="$(sed -n 's/^export const VERSION = "\(.*\)";$/\1/p' "$bun_dir/src/node/browser/agent_browser.ts")"
[ -n "$version" ] || die "no VERSION in agent_browser.ts"
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

cd "$bun_dir"
FLEETD_TEST_AGENT_BROWSER="$bin" FLEETD_WRITE_SHAPES=1 FLEETD_REQUIRE_AGENT_BROWSER=1 bun test test/agent-browser-shapes.test.ts
printf 'wrote experimental/bun/src/node/browser/agent_browser_shapes.json for agent-browser %s\n' "$version"
