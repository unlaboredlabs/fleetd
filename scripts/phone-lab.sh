#!/bin/bash
# A throwaway hub with real-looking data for the phone app on a simulator of the agents' Mac:
#
#   scripts/phone-lab.sh up      start it, seeded, and print what the simulator needs to pair
#   scripts/phone-lab.sh pair    a new pairing code and link (single use, 15 minutes) for one more pairing
#   scripts/phone-lab.sh down    stop what `up` started and delete its folder
#
# It is the factory lab's offline fleet (tests/lab/factory/kit.ts): a hub and a node of their own, run in the
# foreground with no service, under $TMPDIR/phone-lab (FLEETD_HOME and HOME both there, never ~/.fleetd), the hub on
# this machine's tailnet address (`tailscale ip -4`; PHONE_LAB_HOST another) at a free port, so the Mac reaches it.
# tests/lab/phoneLab.ts seeds it: four projects, two with a picture, chats with the person's messages and the lead's
# replies, and an order waiting on an approval. No real claude runs: the leads are the lab's claude stand-in, which
# answers a new message `lab-ok`. `down` stops only the PIDs `up` started.
#
# The fleetd it runs is FLEETD_BIN, else this checkout's target/release/fleetd, else the fleetd on PATH. Needs Node 24
# (and runs `npm ci` in tests/lab the first time).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
DIR=${PHONE_LAB_DIR:-${TMPDIR:-/tmp}/phone-lab}
PID_FILE=$DIR/lab.pid

running() { [[ -f $PID_FILE ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

fleetd_bin() {
  if [[ -n ${FLEETD_BIN:-} ]]; then echo "$FLEETD_BIN"
  elif [[ -x $REPO/target/release/fleetd ]]; then echo "$REPO/target/release/fleetd"
  else command -v fleetd || { echo "phone-lab: no fleetd: set FLEETD_BIN or build target/release/fleetd" >&2; exit 1; }
  fi
}

lab_field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? ""))' "$DIR/lab.json" "$1"; }

pair() {
  running && [[ -f $DIR/lab.json ]] || { echo "phone-lab: not up; run scripts/phone-lab.sh up" >&2; exit 1; }
  local home out link
  home=$(lab_field fleetdHome)
  # The lab's own FLEETD_HOME and HOME: `pair` mints the code in the lab hub's database, never the real hub's.
  out=$(FLEETD_HOME=$home HOME=$home/hub-user "$(cat "$DIR/fleetd.bin")" pair --no-qr --name "iPhone simulator")
  link=$(sed -n 's/^Pairing link: //p' <<<"$out")
  echo "$out" | grep -E '^(Pairing code|Hub address):'
  echo "Pairing link: $link"
  echo
  echo "Pair a simulator on the agents' Mac (the app installed in it already):"
  echo "  mac sim start"
  echo "  mac run -- 'xcrun simctl --set \"\$FLEETD_MAC_SIM_SET\" openurl \"\$FLEETD_MAC_SIM\" \"$link\"'"
  echo "Or type the code and hub address into the app's pairing screen."
}

up() {
  if running; then echo "phone-lab: already up ($(lab_field hubUrl))"; pair; return; fi
  [[ -d $DIR ]] && rm -rf "$DIR"
  mkdir -p "$DIR"
  local host bin
  host=${PHONE_LAB_HOST:-$(tailscale ip -4 2>/dev/null | head -n1)}
  [[ -n $host ]] || { echo "phone-lab: no tailnet address (tailscale ip -4); set PHONE_LAB_HOST" >&2; exit 1; }
  bin=$(fleetd_bin)
  echo "$bin" >"$DIR/fleetd.bin"
  [[ -d $REPO/tests/lab/node_modules ]] || npm ci --prefix "$REPO/tests/lab" --silent
  # Its own session, so a closed terminal leaves it running until `down`.
  FLEETD_BIN=$bin setsid node "$REPO/tests/lab/phoneLab.ts" "$DIR" "$host" >"$DIR/up.log" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  echo "phone-lab: starting on $host with $bin (log: $DIR/up.log)"
  for _ in $(seq 300); do
    [[ -f $DIR/lab.json ]] && break
    running || { tail -n 30 "$DIR/up.log" >&2; echo "phone-lab: failed to start; scripts/phone-lab.sh down cleans up" >&2; exit 1; }
    sleep 1
  done
  [[ -f $DIR/lab.json ]] || { tail -n 30 "$DIR/up.log" >&2; echo "phone-lab: not seeded after 5 minutes" >&2; exit 1; }
  echo "phone-lab: up on $(lab_field hubUrl), seeded"
  pair
}

down() {
  if running; then
    local pid
    pid=$(cat "$PID_FILE")
    # SIGTERM: phoneLab.ts stops its hub, node and their sessions by PID, then exits.
    kill -TERM "$pid"
    for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    # Still there: its process group (setsid made it the leader), which holds only what it started.
    kill -0 "$pid" 2>/dev/null && kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -rf "$DIR"
  echo "phone-lab: down"
}

case ${1:-} in
  up) up ;;
  pair) pair ;;
  down) down ;;
  *) echo "usage: scripts/phone-lab.sh up|pair|down" >&2; exit 2 ;;
esac
