#!/usr/bin/env bash
# Records fleetd-app on a private headless X display, in real time, to H.264 MP4 (and WebM).
#
#   app/bench/record.sh start --out DIR [--fps 60] [--app PATH] [--size 1400x900] [-- ENV=VAL ...]
#       Starts Xvfb, the app (dark theme, with the given environment, e.g. FLEETD_HUB_URL/FLEETD_AGENT_KEY) and
#       the grabber. Prints `DISPLAY=:N` and `T0_MS=<unix ms the capture started>`, then returns; drive the app
#       with `DISPLAY=:N target/release/fleetd-bench type "..."`.
#   app/bench/record.sh stop --out DIR
#       Ends the capture (DIR/full.mp4), then the app and Xvfb.
#   app/bench/record.sh cut --out DIR --from SECONDS [--for 25]
#       DIR/demo.mp4 (H.264, yuv420p, faststart), DIR/demo.webm and key frames DIR/frame-*.png from the full capture.
#       For an event logged at unix ms E, --from is (E - T0_MS) / 1000 minus a lead-in.
#   app/bench/record.sh fixture --out DIR [--seconds 25] [--fps 60]
#       start + stop + cut on the live fixture board (FLEETD_BENCH=live FLEETD_LIVE=demo), for a preview.
#
# ffmpeg: $FLEETD_FFMPEG, else ~/.local/opt/ffmpeg/ffmpeg (a static build with libx264; see app/bench/BASELINE.md),
# else ffmpeg on PATH. Linux only; uses the user-space sysroot (app/bench/linux-sysroot.sh). Only processes this
# script started are stopped, by the PIDs it recorded.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="$PWD"

cmd="${1:-}"; shift || true
out=""; fps=60; app="$repo/target/release/fleetd-app"; size="1400x900"; from=""; dur=25; seconds=25; envs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --fps) fps="$2"; shift 2 ;;
    --app) app="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --for) dur="$2"; shift 2 ;;
    --seconds) seconds="$2"; shift 2 ;;
    --) shift; envs=("$@"); break ;;
    *) echo "record.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo "record.sh: --out DIR is required" >&2; exit 2; }
mkdir -p "$out"
out="$(cd "$out" && pwd)"
state="$out/.record"

ffmpeg_bin() {
  if [ -n "${FLEETD_FFMPEG:-}" ]; then echo "$FLEETD_FFMPEG"
  elif [ -x "$HOME/.local/opt/ffmpeg/ffmpeg" ]; then echo "$HOME/.local/opt/ffmpeg/ffmpeg"
  else command -v ffmpeg || { echo "record.sh: no ffmpeg (set FLEETD_FFMPEG)" >&2; exit 1; }
  fi
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
# Waits up to $2 s for pid $1 to exit (it isn't our child once `start` has returned, so `wait` can't).
await() { for _ in $(seq $(( $2 * 10 ))); do alive "$1" || return 0; sleep 0.1; done; return 1; }

start() {
  [ -e "$state" ] && { echo "record.sh: $state exists; run stop first" >&2; exit 1; }
  local ffmpeg; ffmpeg="$(ffmpeg_bin)"
  [ -x "$app" ] || { echo "record.sh: no app at $app (cargo build --release -p fleetd-app)" >&2; exit 1; }
  FLEETD_SYSROOT="${FLEETD_SYSROOT:-$HOME/src/fleetd-lab/sysroot}"
  [ -x "$FLEETD_SYSROOT/usr/bin/Xvfb-fleetd" ] || app/bench/linux-sysroot.sh "$FLEETD_SYSROOT" >&2
  export FLEETD_SYSROOT
  # shellcheck source=app/bench/linux-env.sh disable=SC1091
  source app/bench/linux-env.sh
  mkdir -m 700 /tmp/xk 2>/dev/null || true
  [ -O /tmp/xk ] || { echo "/tmp/xk is not owned by $USER" >&2; exit 1; }
  ln -sf "$FLEETD_SYSROOT/usr/bin/xkbcomp" /tmp/xk/xkbcomp
  local disp=""
  for n in $(seq 47 99); do [ -e "/tmp/.X$n-lock" ] || { disp=":$n"; break; }; done
  # The screen is the window's size, so the centred window fills it and the capture is the whole screen.
  "$FLEETD_SYSROOT/usr/bin/Xvfb-fleetd" "$disp" -screen 0 "${size}x24" -nolisten tcp >"$out/xvfb.log" 2>&1 &
  local xvfb=$!
  for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X${disp#:}" ] && break; sleep 0.1; done
  # Dark theme without touching the real preferences: a private config dir.
  mkdir -p "$out/config/fleetd"
  echo '{"theme":"dark"}' >"$out/config/fleetd/app.json"
  env DISPLAY="$disp" XDG_CONFIG_HOME="$out/config" ${envs[@]+"${envs[@]}"} "$app" >"$out/app.log" 2>&1 &
  local apid=$!
  sleep 2
  alive "$apid" || { echo "record.sh: the app exited; see $out/app.log" >&2; kill "$xvfb"; exit 1; }
  local fifo="$out/.frames"; rm -f "$fifo"; mkfifo "$fifo"
  "$ffmpeg" -hide_banner -loglevel error -y -f image2pipe -c:v mjpeg -framerate "$fps" -i "$fifo" \
    -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p "$out/full.mp4" >"$out/ffmpeg.log" 2>&1 &
  local fpid=$!
  local t0; t0="$(date +%s%3N)"
  python3 -I app/bench/grab.py --display "$disp" --fps "$fps" --region "0,0,${size/x/,}" >"$fifo" 2>"$out/grab.log" &
  local gpid=$!
  printf 'xvfb=%s\napp=%s\nffmpeg=%s\ngrab=%s\ndisplay=%s\nt0=%s\nfps=%s\n' "$xvfb" "$apid" "$fpid" "$gpid" "$disp" "$t0" "$fps" >"$state"
  echo "DISPLAY=$disp"
  echo "T0_MS=$t0"
}

stop() {
  [ -e "$state" ] || { echo "record.sh: nothing recording in $out" >&2; exit 1; }
  local xvfb app ffmpeg grab
  xvfb="$(sed -n 's/^xvfb=//p' "$state")"; app="$(sed -n 's/^app=//p' "$state")"
  ffmpeg="$(sed -n 's/^ffmpeg=//p' "$state")"; grab="$(sed -n 's/^grab=//p' "$state")"
  alive "$grab" && kill "$grab"
  await "$grab" 5 || kill -9 "$grab" 2>/dev/null || true
  # The grabber closing the pipe ends ffmpeg's input; it then finishes the file.
  await "$ffmpeg" 120 || { echo "record.sh: ffmpeg did not finish" >&2; kill "$ffmpeg" 2>/dev/null || true; }
  alive "$app" && kill "$app"; await "$app" 5 || kill -9 "$app" 2>/dev/null || true
  alive "$xvfb" && kill "$xvfb"; await "$xvfb" 5 || true
  rm -f "$state" "$out/.frames"
  cat "$out/grab.log" >&2 || true
  echo "$out/full.mp4"
}

cut() {
  [ -n "$from" ] || { echo "record.sh: cut needs --from SECONDS" >&2; exit 2; }
  local ffmpeg; ffmpeg="$(ffmpeg_bin)"
  "$ffmpeg" -hide_banner -loglevel error -y -ss "$from" -t "$dur" -i "$out/full.mp4" \
    -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart -an "$out/demo.mp4"
  "$ffmpeg" -hide_banner -loglevel error -y -i "$out/demo.mp4" -c:v libvpx-vp9 -b:v 0 -crf 32 -row-mt 1 -an "$out/demo.webm" || true
  local step=$(( dur / 5 ))
  for i in 0 1 2 3 4 5; do
    local at=$(( i * step )); [ "$at" -ge "$dur" ] && at=$(( dur - 1 ))
    "$ffmpeg" -hide_banner -loglevel error -y -ss "$at" -i "$out/demo.mp4" -frames:v 1 "$out/frame-$(printf %02d "$at")s.png"
  done
  ls -l "$out"/demo.mp4 "$out"/demo.webm "$out"/frame-*.png
}

case "$cmd" in
  start) start ;;
  stop) stop ;;
  cut) cut ;;
  fixture)
    envs=(FLEETD_BENCH=live FLEETD_LIVE=demo FLEETD_BENCH_TIMEOUT_MS=0)
    start
    sleep "$seconds"
    stop
    dur="$seconds"; from=0; cut
    ;;
  *) echo "usage: record.sh start|stop|cut|fixture --out DIR ... (see the header)" >&2; exit 2 ;;
esac
