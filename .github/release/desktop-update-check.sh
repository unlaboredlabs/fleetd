#!/usr/bin/env bash
# Launches a packaged desktop app against a local update feed that offers the release asset as version 99.0.0, and
# requires the app to stay up and take the update. On macOS Squirrel.Mac must accept the download, which it only does
# when the update is signed like the running app; on Linux the AppImage updater must download it and match the
# sha512 in the feed. So it proves the hardened runtime's entitlements (without allow-jit the app dies at its first
# script), the feed update-yml.sh writes, and the signature chain an update needs. Nothing is installed: the app and
# its helpers are killed, not quit (a normal quit installs the update and relaunches it). Run it on a copy anyway.
#
#   desktop-update-check.sh <asset> <command> [args...]
#
# Env: FEED_PORT (default 8765), CHECK_WAIT seconds (default 180).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
asset="$1"
shift
port="${FEED_PORT:-8765}"
feed="$(mktemp -d)"
log="$feed/app.log"
case "$(uname -s)" in
Darwin)
  yml=latest-mac.yml
  # Squirrel.Mac took the zip after checking its signature (electron-updater's debug line).
  done_marker="nativeUpdater.update-downloaded"
  ;;
*)
  yml=latest-linux.yml
  done_marker="has been downloaded to"
  ;;
esac
cp "$asset" "$feed/"
"$here/update-yml.sh" "$feed/$(basename "$asset")" 99.0.0 > "$feed/$yml"

(cd "$feed" && exec python3 -I -m http.server "$port" --bind 127.0.0.1) > "$feed/http.log" 2>&1 &
server=$!
# Its own process group, so the stop below reaches every helper (and the AppImage runtime's child).
set -m
FLEETD_BASE_URL="http://127.0.0.1:$port" "$@" > "$log" 2>&1 &
app=$!
set +m
stop() {
  kill -KILL -- "-$app" 2>/dev/null || true
  kill "$server" 2>/dev/null || true
  wait "$app" "$server" 2>/dev/null || true
}
trap stop EXIT

# Chromium's GPU and display noise on a headless runner isn't the app's.
show() { grep -vE '^\[[0-9:./]+:(ERROR|WARNING):|^ERR: |dbus|Gtk-|^File exists and file size matches' "$log" | tail -n 40 || true; }
result=""
for _ in $(seq "${CHECK_WAIT:-180}"); do
  if ! kill -0 "$app" 2>/dev/null; then
    result="the app exited"
    break
  fi
  if grep -q "$done_marker" "$log"; then
    result=ok
    break
  fi
  if grep -qE '^Error: |ERR_UPDATER' "$log"; then
    result="the update failed"
    break
  fi
  sleep 1
done
show
echo "feed requests:"
cat "$feed/http.log"
case "$result" in
ok) echo "the app is running and took the update from the local feed" ;;
"") echo "::error::the app didn't take the update within ${CHECK_WAIT:-180}s" && exit 1 ;;
*) echo "::error::$result" && exit 1 ;;
esac
