#!/usr/bin/env bash
# Developer ID signing and notarization for the macOS release assets, on a GitHub macOS runner. Secrets (never
# echoed; the runner masks them too):
#
#   MACOS_CERT_P12_BASE64  base64 of a .p12 with the "Developer ID Application" key, its certificate and the
#                          Developer ID G2 CA
#   MACOS_CERT_PASSWORD    the .p12's export password
#   MACOS_SIGN_IDENTITY    e.g. "Developer ID Application: Unlabored Labs LLC (TEAMID)"
#   NOTARY_KEY_ID, NOTARY_ISSUER, NOTARY_KEY_P8_BASE64
#                          an App Store Connect API key (Developer role) for notarytool; without them the assets
#                          are signed but not notarized
#
#   macos-sign.sh enabled             prints true when the signing secrets are set (else logs and prints false)
#   macos-sign.sh keychain            a temporary keychain with the identity, on this job's search list
#   macos-sign.sh sign <path>...      a .app (nested code first, never --deep) or bare binaries
#   macos-sign.sh notarize <zip>      submits and waits; fails with Apple's log unless Accepted
#   macos-sign.sh cleanup             deletes the keychain and any decoded key material (run it with always())
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="${RUNNER_TEMP:?}"
keychain="$tmp/fleetd-signing.keychain-db"
p12="$tmp/fleetd-signing.p12"
p8="$tmp/fleetd-notary.p8"
entitlements="$here/../../app/packaging/fleetd.entitlements"

die() { echo "::error::$*"; exit 1; }

case "${1:-}" in
enabled)
  if [ -n "${MACOS_CERT_P12_BASE64:-}" ] && [ -n "${MACOS_CERT_PASSWORD:-}" ] && [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
    echo true
  else
    echo "signing secrets absent; shipping ad-hoc" >&2
    echo false
  fi
  ;;

keychain)
  pass="$(uuidgen)"
  security create-keychain -p "$pass" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$pass" "$keychain"
  (umask 077 && printf '%s' "$MACOS_CERT_P12_BASE64" | base64 --decode > "$p12")
  security import "$p12" -k "$keychain" -P "$MACOS_CERT_PASSWORD" -f pkcs12 -T /usr/bin/codesign >/dev/null
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$keychain" >/dev/null
  # This job's search list only: the runner is discarded after it.
  # shellcheck disable=SC2046 # one keychain per word
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  security find-identity -v -p codesigning "$keychain" | grep -q "Developer ID Application" ||
    die "the .p12 holds no valid Developer ID Application identity"
  ;;

sign)
  shift
  verify() {
    codesign --verify --strict --verbose=2 "$1"
    codesign -dvv "$1" 2>&1 | grep -E '^(Identifier|Format|TeamIdentifier|Runtime Version|Timestamp)='
    codesign -dvv "$1" 2>&1 | grep -q '^TeamIdentifier=[A-Z0-9]\{10\}$' || die "$1 has no Team ID"
    codesign -dvv "$1" 2>&1 | grep -q 'flags=0x10000(runtime)' || die "$1 lacks the hardened runtime"
    codesign -d -r- "$1" 2>&1 | grep '^designated'
    codesign -d -r- "$1" 2>&1 | grep -q 'certificate leaf\[subject.OU\]' || die "$1 has no team-based designated requirement"
  }
  sign() { codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" "$@"; }
  for path in "$@"; do
    if [ -d "$path" ]; then
      main="$path/Contents/MacOS/$(defaults read "$path/Contents/Info.plist" CFBundleExecutable)"
      # Inside out: every other Mach-O in the bundle (helpers, dylibs; none today), deepest first, then the bundle,
      # which signs its main executable with the entitlements.
      find "$path/Contents" -type f -print0 | xargs -0 file | awk -F': ' '/Mach-O/ { print $1 }' |
        awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2- | while IFS= read -r nested; do
          [ "$nested" = "$main" ] || sign "$nested"
        done
      sign --entitlements "$entitlements" "$path"
    else
      sign "$path"
    fi
    verify "$path"
  done
  ;;

notarize)
  zip="$2"
  (umask 077 && printf '%s' "$NOTARY_KEY_P8_BASE64" | base64 --decode > "$p8")
  out="$tmp/notary-$(basename "$zip").json"
  xcrun notarytool submit "$zip" --key "$p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" --wait \
    --output-format json > "$out" || true
  id="$(plutil -extract id raw -o - "$out" 2>/dev/null || true)"
  status="$(plutil -extract status raw -o - "$out" 2>/dev/null || true)"
  echo "notarization of $(basename "$zip"): submission ${id:-none}, status ${status:-unknown}"
  if [ "$status" != Accepted ]; then
    cat "$out" || true
    [ -n "$id" ] && xcrun notarytool log "$id" --key "$p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER" || true
    rm -f "$p8"
    die "notarization of $(basename "$zip") was ${status:-not submitted}"
  fi
  rm -f "$p8"
  ;;

cleanup)
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -f "$p12" "$p8"
  ;;

*)
  echo "usage: macos-sign.sh enabled|keychain|sign <path>...|notarize <zip>|cleanup" >&2
  exit 2
  ;;
esac
