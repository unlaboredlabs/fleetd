#!/usr/bin/env bash
# The Mac app's disk image, fleetd-desktop-macos-universal.dmg: what "Download for Mac" on fleetd.sh hands a person
# (fleetd.sh/download/mac, site/vercel.json). It opens on a window with the app beside an Applications shortcut
# (dmg-settings.py), laid out by dmgbuild, which writes the window's .DS_Store itself, so no Finder runs. The zip stays
# what the installer and the app's updates download. A zip opened from ~/Downloads runs translocated, where the app
# can't update itself; dragged to Applications from the image, it can.
#
#   macos-dmg.sh build <fleetd.app> <out.dmg>   the image, unsigned (dmgbuild, pinned by hash in dmg-requirements.txt)
#   macos-dmg.sh check <dmg> [notarized]        mounts it read-only: the window's two items are there, the app inside
#                                               has a valid signature and Gatekeeper accepts it as notarized. With
#                                               `notarized`, the image itself is signed, carries its stapled ticket
#                                               and Gatekeeper accepts opening it
#
# build-release.yml signs the image (codesign, no hardened runtime: that's for code), notarizes and staples it with
# macos-sign.sh, and makes one only from an app whose ticket is stapled, so both carry their tickets offline.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
die() { echo "::error::$*"; exit 1; }
# accepted <spctl answer>: Gatekeeper's verdict for something notarized.
accepted() { grep -q ': accepted' <<< "$1" && grep -q 'source=Notarized Developer ID' <<< "$1"; }

case "${1:-}" in
build)
  app="${2:?app}" out="${3:?out.dmg}"
  [ -d "$app/Contents" ] || die "$app is no app"
  [ "$(basename "$app")" = fleetd.app ] || die "the window's layout names fleetd.app, not $(basename "$app")"
  venv="$tmp/dmgbuild-venv"
  rm -rf "$venv"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet --disable-pip-version-check --no-deps --require-hashes -r "$here/dmg-requirements.txt"
  rm -f "$out"
  "$venv/bin/dmgbuild" -s "$here/dmg-settings.py" -D app="$app" fleetd "$out"
  ls -l "$out"
  ;;

check)
  dmg="${2:?dmg}" notarized="${3:-}"
  hdiutil verify -quiet "$dmg"
  if [ "$notarized" = notarized ]; then
    codesign --verify --strict --verbose=2 "$dmg"
    xcrun stapler validate "$dmg"
    out="$(spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1 || true)"
    echo "$out"
    accepted "$out" || die "Gatekeeper doesn't accept opening $dmg"
  fi
  mnt="$(mktemp -d "$tmp/fleetd-dmg.XXXXXX")"
  hdiutil attach -readonly -nobrowse -noautoopen -mountpoint "$mnt" "$dmg" > /dev/null
  trap 'hdiutil detach -quiet "$mnt" || hdiutil detach -force -quiet "$mnt"' EXIT
  ls -la "$mnt"
  [ "$(readlink "$mnt/Applications")" = /Applications ] || die "$dmg has no Applications shortcut"
  [ -f "$mnt/.DS_Store" ] || die "$dmg has no window layout (.DS_Store)"
  [ -d "$mnt/fleetd.app" ] || die "$dmg has no fleetd.app"
  codesign --verify --deep --strict --verbose=2 "$mnt/fleetd.app" 2>&1 | tail -2
  out="$(spctl -a -vv -t exec "$mnt/fleetd.app" 2>&1 || true)"
  echo "$out"
  accepted "$out" || die "Gatekeeper doesn't accept the app in $dmg"
  xcrun stapler validate "$mnt/fleetd.app"
  ;;

*)
  echo "usage: macos-dmg.sh build <fleetd.app> <out.dmg> | check <dmg> [notarized]" >&2
  exit 2
  ;;
esac
