#!/usr/bin/env bash
# Launches a packaged desktop app against a local update feed that offers the release asset as version 99.0.0, and
# requires the app to stay up and take the update. On macOS Squirrel.Mac must accept the download, which it only does
# when the update is signed like the running app; on Linux the AppImage updater must download it and match the
# sha512 in the feed, differentially (its blockmap, the feed's blockMapSize and range requests, which the feed
# answers as GitHub does). So it proves the hardened runtime's entitlements (without allow-jit the app dies at its first
# script), the feed update-yml.sh writes (which names the package's pinned copy, never the plain name edge republishes),
# and the signature chain an update needs. Nothing is installed: the app and
# its helpers are killed, not quit (a normal quit installs the update and relaunches it). Run it on a copy anyway.
#
#   desktop-update-check.sh <asset> <command> [args...]
#
# Env: FEED_PORT (default 8765), CHECK_WAIT seconds (default 180), DONE_MARKER (the log line that means success; the
# deb, which can't update itself, only says an update is available).
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
done_marker="${DONE_MARKER:-$done_marker}"
cp "$asset" "$feed/"
"$here/update-yml.sh" "$feed/$(basename "$asset")" 99.0.0 > "$feed/$yml"
# The feed names the package's pinned copy, as a release holds it (publish.sh). The plain name then holds another
# build's bytes, as when edge republishes mid-update: an app that downloaded it would fail the feed's sha512.
pin="$(awk '$1 == "path:" { print $2 }' "$feed/$yml")"
plain="$feed/$(basename "$asset")"
mv "$plain" "$feed/$pin"
[ ! -f "$plain.blockmap" ] || mv "$plain.blockmap" "$feed/$pin.blockmap"
printf 'the next build\n' > "$plain"

python3 -I "$here/feed-server.py" "$feed" "$port" > "$feed/http.log" 2>&1 &
server=$!
# Serving this feed, not an older one still on the port (a server that can't bind exits within the first second).
sleep 1
for _ in $(seq 20); do
  kill -0 "$server" 2>/dev/null || { cat "$feed/http.log"; echo "::error::the feed server didn't start"; exit 1; }
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/$yml" 2>/dev/null && kill -0 "$server" 2>/dev/null; then break; fi
  sleep 0.5
done
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
  if grep -q "$done_marker" "$log"; then
    # And it survives what follows (the deb shows a dialog).
    sleep 5
    if kill -0 "$app" 2>/dev/null; then result=ok; else result="the app exited after: $done_marker"; fi
    break
  fi
  if ! kill -0 "$app" 2>/dev/null; then
    result="the app exited"
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
# The AppImage's update went block by block (electron-updater logs the plan), not the whole file after a failure.
if [ "$result" = ok ] && [ -z "${DONE_MARKER:-}" ] && grep -q '^    blockMapSize:' "$feed/$yml" &&
  { ! grep -q '^Full: .*To download: ' "$log" || grep -q 'Cannot download differentially' "$log"; }; then
  result="the update didn't download differentially"
fi
case "$result" in
ok) echo "the app is running and took the update from the local feed ($done_marker)" ;;
"") echo "::error::the app didn't take the update within ${CHECK_WAIT:-180}s" && exit 1 ;;
*) echo "::error::$result" && exit 1 ;;
esac
