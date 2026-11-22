#!/bin/bash
# The phone app's screens on iOS simulators, for judging a phone change while no agents' Mac is joined: mac.yml's
# `ios screens` job (a manual run, only: screens) on GitHub's xcode-27 image, the one with the iPhone Duo simulator.
# It starts a phone lab on the runner (tests/lab/phoneLab.ts, as scripts/phone-lab.sh does on the devbox), pairs each
# simulator with it and drives the app with agent-device (fleetd's pinned version):
#
# - phone: an ordinary iPhone, on Chats, a chat and the chat's Info.
# - duo: the iPhone Duo unfolded each way up, folded each way up, and unfolded again under the running app, on Chats,
#   a chat and its Info in each.
#
#   app/mobile/scripts/screens.sh <fleetd.app> <out dir> <prefix> phone|duo...
#
# Each screen is <prefix>-<device>-<pose>-<screen>.png at 3x (the point size is in screens.log) with its
# accessibility snapshot, frames included, as .json beside it. A step that fails is logged and the rest go on, so one
# missing screen leaves the others. Needs Node 24, fleetd/dist/fleetd (bun run compile) and tests/lab's npm ci.
set -euo pipefail

APP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
OUT=$2
PREFIX=$3
shift 3
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
WORK=${RUNNER_TEMP:-${TMPDIR:-/tmp}}/screens
LAB=$WORK/lab
FLEETD_BIN=$REPO/fleetd/dist/fleetd
mkdir -p "$OUT" "$LAB" "$WORK/tools"
LOG=$OUT/screens.log

say() { echo "$*" | tee -a "$LOG"; }

version=$(sed -n 's/^export const AGENT_DEVICE_VERSION = "\(.*\)";$/\1/p' "$REPO/fleetd/src/node/device/pins.ts")
npm i --prefix "$WORK/tools" --no-audit --no-fund --silent "agent-device@$version"
AD=$WORK/tools/node_modules/.bin/agent-device

# The lab, on the runner's loopback, which its simulators share.
FLEETD_BIN=$FLEETD_BIN node "$REPO/tests/lab/phoneLab.ts" "$LAB" 127.0.0.1 >"$OUT/lab.log" 2>&1 &
lab_pid=$!
trap 'kill -TERM "$lab_pid" 2>/dev/null || true' EXIT
for _ in $(seq 600); do
  [ -f "$LAB/lab.json" ] && break
  kill -0 "$lab_pid" 2>/dev/null || { tail -n 40 "$OUT/lab.log"; echo "screens: the phone lab failed to start" >&2; exit 1; }
  sleep 1
done
[ -f "$LAB/lab.json" ] || { tail -n 40 "$OUT/lab.log"; echo "screens: the phone lab wasn't seeded in 10 minutes" >&2; exit 1; }
home=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fleetdHome)' "$LAB/lab.json")
say "phone lab up: $(cat "$LAB/lab.json" | tr -d '\n')"

# A pairing link of its own for each simulator: a code pairs once.
pair_link() { FLEETD_HOME=$home HOME=$home/hub-user "$FLEETD_BIN" pair --no-qr --name "$1" | sed -n 's/^Pairing link: //p'; }

# The newest runtime's simulator of that name, as the image installs them.
udid_of() {
  xcrun simctl list devices available -j | node -e '
    const name = process.argv[1];
    const all = JSON.parse(require("fs").readFileSync(0, "utf8")).devices;
    const v = (r) => (r.match(/iOS-(\d+)-(\d+)/u) ?? []).slice(1).map(Number);
    const runtimes = Object.keys(all).filter((r) => r.includes(".iOS-") && all[r].some((d) => d.name === name));
    runtimes.sort((a, b) => v(b)[0] - v(a)[0] || v(b)[1] - v(a)[1]);
    const d = runtimes.length === 0 ? undefined : all[runtimes[0]].find((x) => x.name === name);
    if (d === undefined) process.exit(1);
    process.stdout.write(`${d.udid} ${runtimes[0]}`);
  ' "$1"
}

UDID=
ad() { "$AD" "$@" --platform ios --udid "$UDID" --session "screens-$UDID"; }
# A step that may fail without stopping the rest.
try() { "$@" >>"$LOG" 2>&1 || say "  failed: $*"; }

shot() {
  local name=$PREFIX-$1
  sleep 2
  if ad screenshot "$OUT/$name.png" --pixel-density 3 --json >"$WORK/shot.json" 2>>"$LOG"; then
    say "  $name: $(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const d = r.data ?? r; process.stdout.write(JSON.stringify({ width: d.width, height: d.height, size: d.size, screen: d.screen, displayRotation: d.displayRotation }))' "$WORK/shot.json" 2>/dev/null || true)"
  else
    say "  failed: screenshot $name"
  fi
  ad snapshot --raw --json >"$OUT/$name.json" 2>>"$LOG" || say "  failed: snapshot $name"
}

# Opens the app, paired with the lab, on Chats.
start() {
  local device=$1 found
  found=$(udid_of "$device") || { say "no $device simulator on this image"; return 1; }
  UDID=${found%% *}
  say "$device: $found"
  try ad boot --timeout 900000
  # agent-device's XCTest runner, built and started once, before any wait counts on it.
  try ad prepare --timeout 900000
  try ad install "$APP"
  try ad open sh.fleetd.app --timeout 900000
  try ad open "$(pair_link "$device")"
  # iOS's "Open in “fleetd”?", then the app's own "Connect" to the hub.
  if ad alert wait 30000 >>"$LOG" 2>&1; then try ad alert accept; fi
  try ad wait 'label="Connect"' 120000
  try ad press 'label="Connect"'
  # Notifications, asked once paired: declined.
  if ad alert wait 30000 >>"$LOG" 2>&1; then try ad alert dismiss; fi
  try ad wait text "inventory" 180000
}

open_chat() { try ad find "inventory" click --first; try ad wait text "Low-stock alerts" 30000; }
open_info() { try ad press 'label="Info"'; try ad wait text "Agents" 30000; }
back() { try ad back; sleep 1; }

for device in "$@"; do
  case $device in
    phone)
      start "iPhone 18 Pro" || continue
      shot phone-chats
      open_chat
      shot phone-chat
      open_info
      shot phone-info
      ;;
    duo)
      start "iPhone Duo" || continue
      try ad fold open
      try ad orientation portrait
      shot duo-open-portrait-chats
      open_chat
      shot duo-open-portrait-chat
      open_info
      shot duo-open-portrait-info
      back
      try ad orientation landscape-left
      shot duo-open-landscape-chat
      open_info
      shot duo-open-landscape-info
      back
      try ad orientation portrait
      try ad fold closed
      shot duo-closed-portrait-chat
      open_info
      shot duo-closed-portrait-info
      back
      back
      shot duo-closed-portrait-chats
      try ad orientation landscape-left
      shot duo-closed-landscape-chats
      open_chat
      shot duo-closed-landscape-chat
      back
      try ad orientation portrait
      # Unfolded under the running app: its window grows from the outer panel's to the inner one's.
      try ad fold open
      shot duo-reopened-chats
      open_chat
      shot duo-reopened-chat
      ;;
    *) say "unknown device $device" ;;
  esac
  try ad close
done
