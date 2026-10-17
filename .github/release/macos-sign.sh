#!/usr/bin/env bash
# Signs fleetd.app with a Developer ID and notarizes it. The release workflow runs this only when the secrets exist.
#
#   APPLE_DEVELOPER_ID_P12           base64 of the "Developer ID Application" certificate + key, exported as .p12
#   APPLE_DEVELOPER_ID_P12_PASSWORD  the .p12's export password
#   APPLE_ID                         the Apple ID that submits for notarization
#   APPLE_TEAM_ID                    the 10-character team id
#   APPLE_APP_PASSWORD               an app-specific password for that Apple ID (appleid.apple.com)
#
#   .github/release/macos-sign.sh <path/to/fleetd.app>
set -euo pipefail
app="$1"
: "${APPLE_DEVELOPER_ID_P12:?}" "${APPLE_DEVELOPER_ID_P12_PASSWORD:?}" "${APPLE_ID:?}" "${APPLE_TEAM_ID:?}" "${APPLE_APP_PASSWORD:?}"

keychain="$RUNNER_TEMP/fleetd-signing.keychain-db"
keychain_pass="$(uuidgen)"
security create-keychain -p "$keychain_pass" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_pass" "$keychain"
echo "$APPLE_DEVELOPER_ID_P12" | base64 --decode > "$RUNNER_TEMP/cert.p12"
security import "$RUNNER_TEMP/cert.p12" -k "$keychain" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign
rm -f "$RUNNER_TEMP/cert.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_pass" "$keychain" >/dev/null
# shellcheck disable=SC2046 # the existing search list, one keychain per word
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
identity="$(security find-identity -v -p codesigning "$keychain" | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
[ -n "$identity" ] || { echo "::error::no Developer ID Application identity in APPLE_DEVELOPER_ID_P12"; exit 1; }

codesign --force --timestamp --options runtime --sign "$identity" "$app/Contents/MacOS/fleetd-app"
codesign --force --timestamp --options runtime --sign "$identity" "$app"
codesign --verify --strict --verbose=2 "$app"

zip="$RUNNER_TEMP/fleetd-notarize.zip"
ditto -c -k --keepParent "$app" "$zip"
xcrun notarytool submit "$zip" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
xcrun stapler staple "$app"
security delete-keychain "$keychain"
