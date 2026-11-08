#!/usr/bin/env bash
# Builds the Bun flavour of the CLI (experimental/bun, `bun build --compile`) for every platform it ships on, into
# dist/ as fleetd-bun-<os>-<arch>: the names the Bun build's own `fleetd update` asks for (src/update `assetOf`), never
# the Rust build's fleetd-<os>-<arch>, so a machine on Rust doesn't pick one up by accident (docs/cutover/bun.md).
#
# FLEETD_VERSION goes in at build time: a Bun build reads `process.env.FLEETD_VERSION` for its version, which a
# service's environment doesn't have. Linux x64 is the baseline build (no AVX2), which runs on any x64 CPU, VMs that
# hide AVX2 included. The binary for this machine is checked to start and say the version.
#
# Env: FLEETD_VERSION. Run from the repo's root after `bun install` in experimental/bun.
set -euo pipefail
: "${FLEETD_VERSION:?}"
root="$(pwd)"
work="$(mktemp -d)"
mkdir -p dist
cd experimental/bun
for pair in linux-x64:bun-linux-x64-baseline linux-arm64:bun-linux-arm64 darwin-arm64:bun-darwin-arm64; do
  asset="fleetd-bun-${pair%%:*}"
  # The entry points and flags of package.json's `compile`, for one target.
  bun build --compile --minify --bytecode --sourcemap --target="${pair#*:}" \
    --define "process.env.FLEETD_VERSION=\"$FLEETD_VERSION\"" \
    --root . src/main.ts src/hub/store/read-worker.ts src/hub/projects/avatar-worker.ts --outfile "$work/$asset"
  cp "$work/$asset" "$root/dist/$asset"
done
cd "$root"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) own=dist/fleetd-bun-linux-x64 ;;
  Linux-aarch64) own=dist/fleetd-bun-linux-arm64 ;;
  Darwin-arm64) own=dist/fleetd-bun-darwin-arm64 ;;
  *) own= ;;
esac
if [ -n "$own" ]; then
  said="$("$own" --version)"
  echo "$own: $said"
  case "$said" in
    *"($FLEETD_VERSION,"*) ;;
    *) echo "::error::$own doesn't say it is $FLEETD_VERSION"; exit 1 ;;
  esac
fi
rm -rf "$work"
ls -l dist/fleetd-bun-*
