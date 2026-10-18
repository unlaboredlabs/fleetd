#!/usr/bin/env bash
# CI on a disposable macOS runner: proves the app's hub key costs no keychain prompt on a normal launch, including
# after an update. Overwrites this user's fleetd keychain items and app files, so never run it on your own Mac.
#
#   app/packaging/macos-key-store-check.sh <fleetd.app> <file|keychain>
#
# `file` for an ad-hoc build, `keychain` for a Developer ID build. It seeds the old `fleetd`/`hub` keychain item
# (readable by any app, since a runner can't answer a prompt) and launches the app three times against a stand-in
# hub that only records the app's first request, so a launch passes once the app has loaded its key and dialled:
#   1. moves the old item, reading it exactly once;
#   2. a normal relaunch;
#   3. a relaunch of a rebuilt app (same signer, new code hash), as after an update.
# Before 2 and 3 the old item is replaced by one only /usr/bin/security may read, so a read would prompt and stall.
# fs_usage (sudo) records whether the app process touches a keychain file at all: launch 1 must (the control),
# and in `file` mode launches 2 and 3 must not.
set -euo pipefail
app="$(cd "$1" && pwd)"
mode="$2"
case "$mode" in file | keychain) ;; *) echo "mode is file or keychain" >&2; exit 2 ;; esac
work="${RUNNER_TEMP:-$(mktemp -d)}/key-store-check"
rm -rf "$work" && mkdir -p "$work"
dir="$HOME/Library/Application Support/fleetd"
port=4797
url="http://127.0.0.1:$port"
saved="{\"url\":\"$url\",\"key\":\"fld_ci_check\"}"
fail() { echo "::error::$*"; exit 1; }

# A keychain of our own, made this user's default for the run, so its password is known: the old item needs a
# partition list naming the app, or even an any-app item would prompt.
kc="$work/check.keychain-db"
security create-keychain -p check "$kc"
security unlock-keychain -p check "$kc"
security set-keychain-settings "$kc"
old_default="$(security default-keychain -d user | tr -d ' "')"
old_list="$(security list-keychains -d user | tr -d '"')"
restore() {
  security default-keychain -d user -s "$old_default" || true
  # shellcheck disable=SC2086 # one keychain per word
  security list-keychains -d user -s $old_list || true
  security delete-keychain "$kc" || true
}
trap restore EXIT
# shellcheck disable=SC2086
security list-keychains -d user -s "$kc" $old_list
security default-keychain -d user -s "$kc"
team="$(codesign -dvv "$app" 2>&1 | sed -n 's/^TeamIdentifier=\([A-Z0-9]\{10\}\)$/\1/p')"
partition="apple-tool:,apple:,unsigned:,cdhash:$(codesign -dvvv "$app" 2>&1 | sed -n 's/^CDHash=//p')${team:+,teamid:$team}"
rm -f "$dir/hub.json" "$dir/keychain-migrated"
security add-generic-password -A -s fleetd -a hub -w "$saved" "$kc"
security set-generic-password-partition-list -S "$partition" -s fleetd -a hub -k check "$kc" >/dev/null

first_opens='' second_opens='' updated_opens=''
launch() { # <label> <app>
  local label="$1" bin="$2/Contents/MacOS/fleetd-app" log="$work/$1.log" trace="$work/$1.fs" hub="$work/$1.hub"
  : > "$hub"
  nc -l 127.0.0.1 "$port" < /dev/null > "$hub" &
  local nc_pid=$!
  # shellcheck disable=SC2024 # the trace belongs to this user on purpose
  sudo fs_usage -w -f filesys fleetd-app > "$trace" 2>/dev/null &
  local fs_pid=$!
  sleep 2
  env -u FLEETD_HUB_URL -u FLEETD_AGENT_KEY "$bin" > "$log" 2>&1 &
  local app_pid=$!
  local ok=0
  for _ in $(seq 120); do
    if grep -q "GET " "$hub"; then ok=1; break; fi
    kill -0 "$app_pid" 2>/dev/null || break
    sleep 0.5
  done
  sleep 1
  # A keychain prompt is SecurityAgent's window.
  local agent=no
  if pgrep -x SecurityAgent >/dev/null; then agent=yes; fi
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  kill "$nc_pid" 2>/dev/null || true
  sudo kill "$fs_pid" 2>/dev/null || true
  wait "$fs_pid" 2>/dev/null || true
  echo "--- launch $label: app log"
  cat "$log"
  local opens
  opens="$(grep -c '\.keychain' "$trace" || true)"
  echo "--- launch $label: the stand-in hub got: $(head -1 "$hub" | tr -d '\r')"
  echo "--- launch $label: app file events on a keychain: $opens"
  echo "--- launch $label: SecurityAgent (keychain prompt) running at the end: $agent"
  [ "$ok" = 1 ] || fail "launch $label: the app never dialled the hub with its saved key (a keychain prompt would stall it here)"
  printf -v "${label}_opens" %s "$opens"
}

expect_store() { # <label>
  if [ "$mode" = file ]; then
    grep -q "hub key store: in a file only you can read" "$work/$1.log" || fail "launch $1: not using the file"
  else
    grep -q "hub key store: in the OS keychain" "$work/$1.log" || fail "launch $1: not using the keychain"
  fi
}

launch first "$app"
expect_store first
grep -q "reading the hub key an earlier version kept in the keychain (once)" "$work/first.log" || fail "launch 1 didn't move the old item"
[ "$first_opens" -gt 0 ] || fail "fs_usage saw no keychain access even for the migration; the detector is broken"
[ -f "$dir/keychain-migrated" ] || fail "no migration marker"
if [ "$mode" = file ]; then
  [ "$(stat -f %Lp "$dir/hub.json")" = 600 ] || fail "hub.json is not 0600"
  [ "$(stat -f %Lp "$dir")" = 700 ] || fail "$dir is not 0700"
  [ "$(cat "$dir/hub.json")" = "$saved" ] || fail "hub.json doesn't hold the moved key"
  written="$(stat -f %m "$dir/hub.json")"
else
  [ ! -e "$dir/hub.json" ] || fail "a Developer ID build left the key in a file"
  security find-generic-password -s fleetd -a hub-developer-id "$kc" >/dev/null || fail "no hub-developer-id item"
fi

# From here, any read of the old item would raise a prompt.
security delete-generic-password -s fleetd -a hub "$kc" >/dev/null
security add-generic-password -s fleetd -a hub -w '{"url":"http://127.0.0.1:9","key":"fld_must_not_be_read"}' -T /usr/bin/security "$kc"

launch second "$app"
expect_store second

# An update: the same bundle, a new code hash, re-signed by the same signer (ad-hoc or the Developer ID).
next="$work/next/fleetd.app"
mkdir -p "$(dirname "$next")" && ditto "$app" "$next"
plutil -replace FleetdVersion -string "key-store-check-next" "$next/Contents/Info.plist"
identity="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p' | head -1)"
if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp=none --sign "$identity" "$next"
else
  codesign --force --sign - "$next"
fi
before="$(codesign -dvvv "$app" 2>&1 | sed -n 's/^CDHash=//p')"
after="$(codesign -dvvv "$next" 2>&1 | sed -n 's/^CDHash=//p')"
echo "cdhash before $before, after the update $after"
[ "$before" != "$after" ] || fail "the rebuilt app has the same cdhash"
launch updated "$next"
expect_store updated

for label in second updated; do
  if grep -q "reading the hub key an earlier version" "$work/$label.log"; then fail "launch $label read the old item again"; fi
done
if [ "$mode" = file ]; then
  [ "$second_opens" = 0 ] || fail "launch 2 touched the keychain ($second_opens events)"
  [ "$updated_opens" = 0 ] || fail "launch 3 touched the keychain ($updated_opens events)"
  [ "$(stat -f %m "$dir/hub.json")" = "$written" ] || fail "hub.json was rewritten on a relaunch"
fi
echo "key store check ($mode): migrated once; two relaunches, one after an update, with no prompt"
