#!/usr/bin/env bash
# Staples a release's already-published fleetd.app once Apple accepts its notarization, without rebuilding: the
# release job ships the app signed but unstapled when Apple's queue outlasts its wait (see macos-sign.sh).
#
#   TAG=nightly [SUBMISSION=<id>] .github/release/macos-staple.sh
#
# It downloads the release's app zip and checks the submission's ticket covers that exact code (the cdhash of each
# architecture), so it never staples a ticket onto a different build. Without SUBMISSION it takes the newest
# accepted fleetd-app-notarize.zip submission whose ticket matches. Then it staples, requires Gatekeeper to say
# "accepted, source=Notarized Developer ID", and replaces the zip and its SHA256SUMS line as publish.sh writes them.
# Env: TAG, GH_TOKEN, NOTARY_KEY_ID, NOTARY_ISSUER, NOTARY_KEY_P8_BASE64, optional SUBMISSION.
set -euo pipefail
: "${TAG:?}" "${NOTARY_KEY_ID:?}" "${NOTARY_ISSUER:?}" "${NOTARY_KEY_P8_BASE64:?}"
asset=fleetd-app-macos-universal.zip
work="${RUNNER_TEMP:?}/staple"
p8="$RUNNER_TEMP/fleetd-notary.p8"
trap 'rm -f "$p8"' EXIT
rm -rf "$work" && mkdir -p "$work/app"
(umask 077 && printf '%s' "$NOTARY_KEY_P8_BASE64" | base64 --decode > "$p8")
auth=(--key "$p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
die() { echo "::error::$*"; exit 1; }

gh release download "$TAG" -p "$asset" -p SHA256SUMS -D "$work"
ditto -x -k "$work/$asset" "$work/app"
app="$work/app/fleetd.app"
[ -d "$app" ] || die "$asset has no fleetd.app"
if xcrun stapler validate "$app" >/dev/null 2>&1; then
  echo "the $TAG app is already stapled"
  spctl -a -vv -t exec "$app" 2>&1 || true
  exit 0
fi
cdhashes="$(for arch in $(lipo -archs "$app/Contents/MacOS/fleetd-app"); do
  codesign -dvvv -a "$arch" "$app" 2>&1 | sed -n 's/^CDHash=//p'
done | sort -u)"
echo "published app cdhashes: $(echo "$cdhashes" | tr '\n' ' ')"

# Every cdhash of the published app is in the submission's ticket.
covers() {
  local ticket
  ticket="$(xcrun notarytool log "$1" "${auth[@]}" 2>/dev/null |
    python3 -I -c 'import json, sys; print("\n".join(t.get("cdhash", "") for t in json.load(sys.stdin).get("ticketContents") or []))' 2>/dev/null)" || return 1
  while IFS= read -r h; do grep -qx "$h" <<< "$ticket" || return 1; done <<< "$cdhashes"
}
status() { xcrun notarytool info "$1" "${auth[@]}" --output-format json | plutil -extract status raw -o - - 2>/dev/null || echo unknown; }

if [ -n "${SUBMISSION:-}" ]; then
  candidates="$SUBMISSION"
else
  candidates="$(xcrun notarytool history "${auth[@]}" --output-format json | python3 -I -c '
import json, sys
for s in sorted(json.load(sys.stdin)["history"], key=lambda s: s["createdDate"], reverse=True):
    if s["name"] == "fleetd-app-notarize.zip" and s["status"] == "Accepted":
        print(s["id"])')"
fi
chosen=""
for id in $candidates; do
  st="$(status "$id")"
  echo "submission $id: $st"
  [ "$st" = Accepted ] || continue
  if covers "$id"; then chosen="$id"; break; fi
  echo "submission $id's ticket doesn't cover the published app"
done
[ -n "$chosen" ] || die "no accepted submission covers the $TAG app yet"
echo "stapling the ticket of submission $chosen"

xcrun stapler staple "$app"
xcrun stapler validate "$app"
verdict="$(spctl -a -vv -t exec "$app" 2>&1 || true)"
echo "$verdict"
if ! grep -q ': accepted' <<< "$verdict" || ! grep -q 'source=Notarized Developer ID' <<< "$verdict"; then
  die "Gatekeeper doesn't accept the stapled app"
fi

mkdir -p "$work/out"
ditto -c -k --keepParent "$app" "$work/out/$asset"
(cd "$work/out" && shasum -a 256 "$asset") > "$work/new"
awk 'NR == FNR { built[$2] = 1; next } !($2 in built)' "$work/new" "$work/SHA256SUMS" | cat "$work/new" - | sort -k2 > "$work/out/SHA256SUMS"
cat "$work/out/SHA256SUMS"
gh release upload "$TAG" "$work/out/$asset" --clobber
gh release upload "$TAG" "$work/out/SHA256SUMS" --clobber
echo "stapled and replaced $asset on $TAG"
