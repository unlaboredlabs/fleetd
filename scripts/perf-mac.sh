#!/bin/bash
# Measures the desktop app's budgets on a Mac, with one command, and prints the numbers:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/unlaboredlabs/fleetd/main/scripts/perf-mac.sh)
#
# first paint (< 600 ms), idle memory (< 300 MB, deduplicated: summed physical footprint; summed RSS is shown, not gated), 60 fps scroll back through a
# long chat and keypress-to-screen (< 16 ms) in its composer, as app/desktop/perf/run.ts measures them on the chat-long fixture, each marked ok or MISS.
# It builds app/desktop at main (or the checkout it runs from) and launches it about six times; windows open and
# close on their own, so leave the Mac alone for the two minutes it takes.
#
# Everything lives in FLEETD_PERF_DIR (default ~/fleetd-perf): the checkout, a pinned Node if yours is older than
# 24, pnpm (through Node's corepack when there's none on PATH). Each launch keeps its state in a temporary
# directory; nothing of your fleetd is read or written. Environment:
#   FLEETD_PERF_DIR      the work directory (default ~/fleetd-perf)
#   FLEETD_PERF_REF      the branch or tag to measure (default main; ignored in a checkout)
set -euo pipefail

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'perf-mac: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this is the Mac command; elsewhere run pnpm perf in app/desktop"
git --version >/dev/null 2>&1 || die "git needs the Command Line Tools: xcode-select --install"
command -v curl >/dev/null || die "curl is missing"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P || true)"
work="${FLEETD_PERF_DIR:-$HOME/fleetd-perf}"
mkdir -p "$work"
work="$(cd "$work" && pwd -P)"
if [ -n "$here" ] && [ -f "$here/app/desktop/perf/run.ts" ]; then
  repo="$here"
else
  repo="$work/fleetd"
  [ -d "$repo/.git" ] || git clone -q https://github.com/unlaboredlabs/fleetd "$repo"
  git -C "$repo" fetch -q origin "${FLEETD_PERF_REF:-main}"
  git -C "$repo" checkout -q --detach FETCH_HEAD
fi
say "Measuring app/desktop at $(git -C "$repo" log -1 --format='%h %cs %s')"

# Node 24 or newer; else a pinned build in the work directory, checked against nodejs.org's SHASUMS256.
NODE_VERSION=v24.22.0
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; }
if ! node_ok; then
  case "$(uname -m)" in
    arm64) arch=arm64 sum=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5 ;;
    x86_64) arch=x64 sum=495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91 ;;
    *) die "no Node build for $(uname -m)" ;;
  esac
  dir="$work/node-$NODE_VERSION-darwin-$arch"
  if [ ! -x "$dir/bin/node" ]; then
    say "Fetching Node $NODE_VERSION"
    tgz="$work/node-$NODE_VERSION-darwin-$arch.tar.gz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$arch.tar.gz" -o "$tgz"
    echo "$sum  $tgz" | shasum -a 256 -c - >/dev/null || { rm -f "$tgz"; die "the Node download does not match its checksum"; }
    tar -xzf "$tgz" -C "$work" && rm -f "$tgz"
  fi
  PATH="$dir/bin:$PATH"
fi
# The pnpm version app/desktop/package.json pins, through corepack when there's no pnpm on PATH.
pn() {
  if command -v pnpm >/dev/null; then pnpm "$@"
  else COREPACK_HOME="$work/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"
  fi
}

cd "$repo/app/desktop"
say "Installing and building (the first run fetches Electron)"
pn install --frozen-lockfile --silent
pn build:test >/dev/null
say "Measuring; windows will open and close"
pn perf
