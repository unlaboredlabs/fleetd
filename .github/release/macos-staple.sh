#!/usr/bin/env bash
# Staples a release's already-published fleetd.app once Apple accepts its notarization, without rebuilding: the
# release job ships the app signed but unstapled when Apple's queue outlasts its wait (see macos-sign.sh). The app is
# fleetd-desktop-macos-universal.zip, notarized as fleetd-desktop-notarize.zip; its latest-mac.yml is rewritten for
# the new zip.
#
#   TAG=edge [SUBMISSION=<id>] .github/release/macos-staple.sh
#
# It downloads the release's app zip and checks the submission's ticket covers that exact code (the cdhash of each
# architecture), so it never staples a ticket onto a different build. Without SUBMISSION it takes the newest
# accepted submission of the app whose ticket matches. Then it staples, requires Gatekeeper to say
# "accepted, source=Notarized Developer ID", and replaces the zip and its SHA256SUMS line as publish.sh writes them.
# Without SUBMISSION, "nothing to do yet" (no notary key, an edge build running, nothing accepted) exits 0. With it,
# the submission must cover the app.
#
# The `nightly` release is publish.sh's copy of edge for builds from before the rename (D203), and is never stapled on
# its own: TAG=edge (TAG=nightly means it too) staples edge, then copies edge's app zip, its feed (with the copy's
# nightly-named version) and edge's SHA256SUMS to nightly whenever nightly's line for the zip differs from edge's. So
# both hold the same bytes under the same checksums, and a copy cut short is made on the next run.
# Env: TAG, GH_TOKEN, NOTARY_KEY_ID, NOTARY_ISSUER, NOTARY_KEY_P8_BASE64, optional SUBMISSION.
set -euo pipefail
: "${TAG:?}"
if [ "$TAG" = nightly ]; then TAG=edge; fi
if [ -z "${NOTARY_KEY_ID:-}" ] || [ -z "${NOTARY_ISSUER:-}" ] || [ -z "${NOTARY_KEY_P8_BASE64:-}" ]; then
  echo "no notary key; nothing to staple"
  exit 0
fi
# A release build may be about to replace the asset: leave it to that build's own notarization.
building() {
  [ -n "$(gh run list --workflow edge.yml --branch main --limit 5 --json status \
    -q '[.[] | select(.status != "completed")] | .[0].status // empty')" ]
}
rolling() { [ "$TAG" = edge ]; }
if rolling && building; then
  echo "an edge build is running; trying again later"
  exit 0
fi
here="$(cd "$(dirname "$0")" && pwd)"
p8="${RUNNER_TEMP:?}/fleetd-notary.p8"
trap 'rm -f "$p8"' EXIT
(umask 077 && printf '%s' "$NOTARY_KEY_P8_BASE64" | base64 --decode > "$p8")
auth=(--key "$p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
die() { echo "::error::$*"; exit 1; }
status() { xcrun notarytool info "$1" "${auth[@]}" --output-format json | plutil -extract status raw -o - - 2>/dev/null || echo unknown; }
history="$(xcrun notarytool history "${auth[@]}" --output-format json)"
pending=0
matched=0

# staple <asset> <submission name> [feed]: returns 0 when there was nothing to do or it stapled.
staple() {
  local asset="$1" name="$2" feed="${3:-}"
  local work="$RUNNER_TEMP/staple-$name"
  rm -rf "$work" && mkdir -p "$work/app"
  local files=(-p "$asset" -p SHA256SUMS)
  [ -z "$feed" ] || files+=(-p "$feed")
  if ! gh release download "$TAG" "${files[@]}" -D "$work" 2>/dev/null || [ ! -f "$work/$asset" ]; then
    echo "no $asset on $TAG"
    return 0
  fi
  [ -z "$feed" ] || [ -f "$work/$feed" ] || die "$TAG has $asset but no $feed"
  local published
  published="$(awk -v n="$asset" '$2 == n { print $1 }' "$work/SHA256SUMS")"
  ditto -x -k "$work/$asset" "$work/app"
  local app="$work/app/fleetd.app"
  [ -d "$app" ] || die "$asset has no fleetd.app"
  if xcrun stapler validate "$app" >/dev/null 2>&1; then
    echo "the $TAG $asset is already stapled"
    spctl -a -vv -t exec "$app" 2>&1 || true
    return 0
  fi
  pending=1
  local exe cdhashes
  exe="$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist")"
  cdhashes="$(for arch in $(lipo -archs "$exe"); do
    codesign -dvvv -a "$arch" "$app" 2>&1 | sed -n 's/^CDHash=//p'
  done | sort -u)"
  echo "$asset cdhashes: $(echo "$cdhashes" | tr '\n' ' ')"

  # Every cdhash of the published app is in the submission's ticket.
  covers() {
    local ticket
    ticket="$(xcrun notarytool log "$1" "${auth[@]}" 2>/dev/null |
      python3 -I -c 'import json, sys; print("\n".join(t.get("cdhash", "") for t in json.load(sys.stdin).get("ticketContents") or []))' 2>/dev/null)" || return 1
    while IFS= read -r h; do grep -qx "$h" <<< "$ticket" || return 1; done <<< "$cdhashes"
  }
  local candidates chosen="" id st
  if [ -n "${SUBMISSION:-}" ]; then
    candidates="$SUBMISSION"
  else
    candidates="$(NAME="$name" python3 -I -c '
import json, os, sys
for s in sorted(json.load(sys.stdin)["history"], key=lambda s: s["createdDate"], reverse=True):
    if s["name"] == os.environ["NAME"] and s["status"] == "Accepted":
        print(s["id"])' <<< "$history")"
  fi
  for id in $candidates; do
    st="$(status "$id")"
    echo "submission $id: $st"
    [ "$st" = Accepted ] || continue
    if covers "$id"; then chosen="$id"; break; fi
    echo "submission $id's ticket doesn't cover the published $asset"
  done
  if [ -z "$chosen" ]; then
    echo "no accepted submission covers the $TAG $asset yet"
    return 0
  fi
  matched=1
  echo "stapling the ticket of submission $chosen onto $asset"

  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  local verdict
  verdict="$(spctl -a -vv -t exec "$app" 2>&1 || true)"
  echo "$verdict"
  if ! grep -q ': accepted' <<< "$verdict" || ! grep -q 'source=Notarized Developer ID' <<< "$verdict"; then
    die "Gatekeeper doesn't accept the stapled $asset"
  fi

  mkdir -p "$work/out"
  # --norsrc, as the release job zips it (see build-release.yml): no `._*` entries for a plain unzip to break the seal.
  ditto -c -k --keepParent --norsrc "$app" "$work/out/$asset"
  (cd "$work/out" && shasum -a 256 "$asset") > "$work/new"
  awk 'NR == FNR { built[$2] = 1; next } !($2 in built)' "$work/new" "$work/SHA256SUMS" | cat "$work/new" - | sort -k2 > "$work/out/SHA256SUMS"
  cat "$work/out/SHA256SUMS"
  if [ -n "$feed" ]; then
    # Same version, new bytes: an app reading the old feed would reject the new zip's sha512.
    "$here/update-yml.sh" "$work/out/$asset" "$(awk '$1 == "version:" { print $2 }' "$work/$feed")" > "$work/out/$feed"
    cat "$work/out/$feed"
  fi
  local now
  gh release download "$TAG" -p SHA256SUMS -O "$work/now" --clobber
  now="$(awk -v n="$asset" '$2 == n { print $1 }' "$work/now")"
  if [ "$now" != "$published" ] || { rolling && building; }; then
    echo "the $TAG $asset changed while stapling; leaving the new one alone"
    return 0
  fi
  gh release upload "$TAG" "$work/out/$asset" --clobber
  [ -z "$feed" ] || gh release upload "$TAG" "$work/out/$feed" --clobber
  gh release upload "$TAG" "$work/out/SHA256SUMS" --clobber
  echo "stapled and replaced $asset on $TAG"
}

# mirror <asset> <feed>: nightly gets edge's <asset>, <feed> and SHA256SUMS when its line for <asset> differs.
mirror() {
  local asset="$1" feed="$2"
  local work="$RUNNER_TEMP/mirror"
  rm -rf "$work" && mkdir -p "$work/edge" "$work/nightly"
  gh release download edge -p SHA256SUMS -D "$work/edge" 2>/dev/null || return 0
  gh release download nightly -p SHA256SUMS -D "$work/nightly" 2>/dev/null || true
  local want have
  want="$(awk -v n="$asset" '$2 == n { print $1 }' "$work/edge/SHA256SUMS")"
  have="$(awk -v n="$asset" '$2 == n { print $1 }' "$work/nightly/SHA256SUMS" 2>/dev/null || true)"
  if [ -z "$want" ] || [ "$want" = "$have" ]; then
    echo "nightly has edge's $asset"
    return 0
  fi
  gh release download edge -p "$asset" -p "$feed" -D "$work/edge"
  [ "$(shasum -a 256 "$work/edge/$asset" | cut -d' ' -f1)" = "$want" ] || {
    echo "the edge $asset changed while copying; leaving it to the next run"
    return 0
  }
  sed 's/^\(version: .*\)-edge\./\1-nightly./' "$work/edge/$feed" > "$work/nightly/$feed"
  if building; then
    echo "an edge build started while copying; leaving it to the next run"
    return 0
  fi
  gh release upload nightly "$work/edge/$asset" --clobber
  gh release upload nightly "$work/nightly/$feed" --clobber
  gh release upload nightly "$work/edge/SHA256SUMS" --clobber
  echo "copied edge's $asset to nightly"
}

staple fleetd-desktop-macos-universal.zip fleetd-desktop-notarize.zip latest-mac.yml
if [ "$TAG" = edge ]; then mirror fleetd-desktop-macos-universal.zip latest-mac.yml; fi
# An explicit id that doesn't fit the app is a mistake; the scheduled check just waits for Apple.
if [ -n "${SUBMISSION:-}" ] && [ "$pending" = 1 ] && [ "$matched" = 0 ]; then
  die "submission $SUBMISSION doesn't cover the unstapled app on $TAG"
fi
