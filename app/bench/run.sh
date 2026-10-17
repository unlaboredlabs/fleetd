#!/usr/bin/env bash
# One command: build fleetd-app in release, run every speed measurement, print a markdown table.
#
#   app/bench/run.sh [--runs N] [--precompiled-shaders]
#
# --precompiled-shaders (macOS with full Xcode): build without gpui's runtime_shaders feature.
#
# Linux without a display (or FLEETD_HEADLESS=1): runs under a private Xvfb from the user-space
# sysroot (app/bench/linux-sysroot.sh) with Mesa lavapipe unless FLEETD_VK_ICD names another driver.
# macOS: see app/bench/MAC-RUN.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

RUNS=10
features=()
shaders="runtime shaders"
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --precompiled-shaders) features=(--no-default-features); shaders="precompiled shaders"; shift ;;
    *) echo "usage: $0 [--runs N] [--precompiled-shaders]" >&2; exit 2 ;;
  esac
done

os="$(uname -s)"
keep=(HOME PATH USER LANG)
xvfb_pid=""
cleanup() { if [ -n "$xvfb_pid" ]; then kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; fi; }
trap cleanup EXIT

if [ "$os" = Linux ]; then
  if ! pkg-config --exists xkbcommon-x11 fontconfig 2>/dev/null; then
    FLEETD_SYSROOT="${FLEETD_SYSROOT:-$HOME/src/fleetd-lab/sysroot}"
    [ -x "$FLEETD_SYSROOT/usr/bin/Xvfb-fleetd" ] || app/bench/linux-sysroot.sh "$FLEETD_SYSROOT" >&2
    export FLEETD_SYSROOT
    # shellcheck source=app/bench/linux-env.sh disable=SC1091
    source app/bench/linux-env.sh
    keep+=(LD_LIBRARY_PATH VK_ICD_FILENAMES)
  fi
fi

echo "building ..." >&2
cargo build --release --locked -p fleetd-app ${features[@]+"${features[@]}"} >&2
cargo build --release --locked -p fleetd-bench >&2

if [ "$os" = Linux ]; then
  if [ -z "${DISPLAY:-}" ] || [ "${FLEETD_HEADLESS:-0}" = 1 ]; then
    : "${FLEETD_SYSROOT:?headless runs need the sysroot Xvfb; run app/bench/linux-sysroot.sh}"
    # Xvfb-fleetd looks for xkbcomp in /tmp/xk (see linux-sysroot.sh). Refuse a directory we don't own.
    mkdir -m 700 /tmp/xk 2>/dev/null || true
    [ -O /tmp/xk ] || { echo "/tmp/xk is not owned by $USER" >&2; exit 1; }
    ln -sf "$FLEETD_SYSROOT/usr/bin/xkbcomp" /tmp/xk/xkbcomp
    for n in $(seq 47 99); do [ -e "/tmp/.X$n-lock" ] || { disp=":$n"; break; }; done
    "$FLEETD_SYSROOT/usr/bin/Xvfb-fleetd" "$disp" -screen 0 1600x1000x24 -nolisten tcp >/dev/null 2>&1 &
    xvfb_pid=$!
    for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X${disp#:}" ] && break; sleep 0.1; done
    export DISPLAY="$disp"
    unset WAYLAND_DISPLAY
  fi
  keep+=(DISPLAY)
  case "${VK_ICD_FILENAMES:-}" in
    *lvp*) render="software-rendered (lavapipe, no GPU)" ;;
    "") render="system Vulkan driver" ;;
    *) render="Vulkan ICD $(basename "$VK_ICD_FILENAMES")" ;;
  esac
  where="Linux $(uname -r), $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs), ${xvfb_pid:+Xvfb 1600x1000, }$render"
else
  where="macOS $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string), Metal ($shaders)"
fi

label="**$(hostname -s)**, $where. $(date -u +%Y-%m-%dT%H:%MZ), fleetd $(git rev-parse --short HEAD), gpui zed v1.24.2 (fb69067)."

# Scrubbed environment: nothing from the calling agent's session (CLAUDE*, etc.) reaches the app.
envs=()
for v in "${keep[@]}"; do [ -n "${!v:-}" ] && envs+=("$v=${!v}"); done
env -i "${envs[@]}" target/release/fleetd-bench target/release/fleetd-app --runs "$RUNS" --label "$label"
