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
#   macos-sign.sh sign <binary>...    bare binaries (the CLI); the app is signed by electron-builder, with this
#                                     job's keychain
#   macos-sign.sh verify <path>...    checks a signature: Team ID, hardened runtime, team-based requirement
#   macos-sign.sh notarize <zip>      submits and waits: 0 Accepted, 3 still in progress, else fails with Apple's log
#   macos-sign.sh staple <app>        staples the accepted ticket onto the app and validates it, else fails
#   macos-sign.sh validate <app>      0 when the app's stapled ticket validates, else 1 (no ::error::)
#   macos-sign.sh cleanup             deletes the keychain and any decoded key material (run it with always())
#
# Only Apple's transient answers are retried, NOTARY_TRIES times (default 5) with backoff from RETRY_DELAY seconds
# (default 15, doubling), each retry logged with Apple's answer: notarytool submit that couldn't reach Apple or got a
# 5xx, and a stapler CloudKit lookup that got no answer. A rejection, a missing ticket or a bad signature fails at once.
set -euo pipefail
tmp="${RUNNER_TEMP:?}"
keychain="$tmp/fleetd-signing.keychain-db"
p12="$tmp/fleetd-signing.p12"
p8="$tmp/fleetd-notary.p8"

die() { echo "::error::$*"; exit 1; }
# retry <what> <transient> <out> <command>...: the command's stdout goes to <out>, its stderr to <out>.err. On a
# failure <transient> recognises, it tries again; otherwise, or after the last try, it prints Apple's answer and
# returns the command's status.
retry() {
  local what="$1" transient="$2" out="$3" try=1 rc answer wait
  shift 3
  while :; do
    rc=0
    "$@" > "$out" 2> "$out.err" || rc=$?
    [ "$rc" != 0 ] || return 0
    answer="$(cat "$out" "$out.err")"
    if ! "$transient" "$answer"; then
      printf '%s\n' "$answer"
      return "$rc"
    fi
    if [ "$try" -ge "${NOTARY_TRIES:-5}" ]; then
      printf '%s\n' "$answer"
      echo "$what: Apple's answer is still transient after $try tries; giving up"
      return "$rc"
    fi
    wait=$((${RETRY_DELAY:-15} << (try - 1)))
    echo "::warning::$what failed (try $try of ${NOTARY_TRIES:-5}), retrying in ${wait}s. Apple said: $(tr '\n' ' ' <<< "$answer")"
    sleep "$wait"
    try=$((try + 1))
  done
}
# notarytool couldn't reach Apple, or Apple answered 5xx: nothing was judged, so submitting again is safe.
submit_transient() {
  grep -Eqi 'HTTPClientError|NSURLErrorDomain|timed out|network connection was lost|could not connect|connection (reset|refused)|(status ?code|statusCode|HTTP)[^0-9]{0,20}5[0-9][0-9]|internal server error|bad gateway|service unavailable|gateway time-?out' <<< "$1"
}
# stapler's CloudKit lookup of the ticket got no answer, as `failed due to "(null)"` right after an Accepted
# notarization. "Record not found" is an answer (Apple has no ticket for this code), so it fails at once.
cloudkit_transient() {
  grep -q 'CloudKit query for .* failed due to' <<< "$1" && ! grep -q 'failed due to "Record not found"' <<< "$1"
}
# stapler <staple|validate> <app>: Apple's own check, so it never vouches for a ticket it hasn't seen.
stapler() {
  local rc=0
  retry "stapler $1 $(basename "$2")" cloudkit_transient "$tmp/stapler.out" xcrun stapler "$1" "$2" || rc=$?
  [ "$rc" != 0 ] || cat "$tmp/stapler.out" "$tmp/stapler.out.err"
  return "$rc"
}
verify() {
  codesign --verify --deep --strict --verbose=2 "$1"
  codesign -dvv "$1" 2>&1 | grep -E '^(Identifier|Format|TeamIdentifier|Runtime Version|Timestamp)='
  codesign -dvv "$1" 2>&1 | grep -q '^TeamIdentifier=[A-Z0-9]\{10\}$' || die "$1 has no Team ID"
  codesign -dvv "$1" 2>&1 | grep -q 'flags=0x10000(runtime)' || die "$1 lacks the hardened runtime"
  codesign -d -r- "$1" 2>&1 | grep '^designated'
  codesign -d -r- "$1" 2>&1 | grep -q 'certificate leaf\[subject.OU\]' || die "$1 has no team-based designated requirement"
}

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
  for path in "$@"; do
    # One identifier for the CLI, whatever the asset is called (it's installed as `fleetd`).
    codesign --force --options runtime --timestamp --sign "$MACOS_SIGN_IDENTITY" --identifier sh.fleetd.cli "$path"
    verify "$path"
  done
  ;;

verify)
  shift
  for path in "$@"; do verify "$path"; done
  ;;

notarize)
  # Exit 0: Accepted. Exit 3: Apple is still processing after NOTARY_WAIT (a new team's first submissions can
  # take hours); the asset ships signed but not stapled, and Gatekeeper accepts it once Apple finishes. Anything
  # else (Invalid, Rejected) fails with Apple's log.
  zip="$2"
  auth=(--key "$p8" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  (umask 077 && printf '%s' "$NOTARY_KEY_P8_BASE64" | base64 --decode > "$p8")
  out="$tmp/notary-$(basename "$zip").json"
  retry "notarytool submit $(basename "$zip")" submit_transient "$out" \
    xcrun notarytool submit "$zip" "${auth[@]}" --output-format json || { rm -f "$p8"; die "notarytool submit failed"; }
  id="$(plutil -extract id raw -o - "$out")"
  echo "notarization of $(basename "$zip"): submission $id"
  xcrun notarytool wait "$id" "${auth[@]}" --timeout "${NOTARY_WAIT:-40m}" --output-format json > "$out" || true
  status="$(plutil -extract status raw -o - "$out" 2>/dev/null || true)"
  [ -n "$status" ] || status="$(xcrun notarytool info "$id" "${auth[@]}" --output-format json | plutil -extract status raw -o - - 2>/dev/null || true)"
  echo "notarization of $(basename "$zip"): submission $id, status ${status:-unknown}"
  case "$status" in
  Accepted) rm -f "$p8" ;;
  "In Progress")
    rm -f "$p8"
    echo "::warning::notarization $id still in progress after ${NOTARY_WAIT:-40m}; shipping signed, not stapled"
    exit 3
    ;;
  *)
    xcrun notarytool log "$id" "${auth[@]}" || true
    rm -f "$p8"
    die "notarization $id of $(basename "$zip") is ${status:-unknown}"
    ;;
  esac
  ;;

staple)
  stapler staple "$2" || die "stapling $2 failed"
  stapler validate "$2" || die "the ticket stapled to $2 doesn't validate"
  ;;

validate)
  stapler validate "$2" || exit 1
  ;;

cleanup)
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -f "$p12" "$p8"
  ;;

*)
  echo "usage: macos-sign.sh enabled|keychain|sign <binary>...|verify <path>...|notarize <zip>|staple <app>|validate <app>|cleanup" >&2
  exit 2
  ;;
esac
