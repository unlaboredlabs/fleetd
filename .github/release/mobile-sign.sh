#!/usr/bin/env bash
# Signing for the phone app's release builds (mobile-release.yml), on GitHub runners. Secrets (never echoed; the
# runner masks them too):
#
#   ANDROID_KEYSTORE_BASE64   base64 of a Java keystore (.jks) with the app's upload or release key
#   ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
#
#   IOS_CERT_P12_BASE64       base64 of a .p12 with an "Apple Distribution" key and its certificate
#   IOS_CERT_PASSWORD         the .p12's export password
#   IOS_PROFILE_BASE64        base64 of an App Store provisioning profile for the app's bundle id
#   IOS_EXTENSION_PROFILE_BASE64
#                             base64 of one for the Notification Service Extension's: the app's plus ".notifications"
#   APPLE_TEAM_ID             the team's 10-character id
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64
#                             an App Store Connect API key (App Manager role): without it the signed .ipa is kept
#                             as an artifact and not sent to TestFlight
#
#   mobile-sign.sh android-enabled        prints true when the keystore secrets are set (else logs and prints false)
#   mobile-sign.sh android-keystore       decodes the keystore and names it in FLEETD_ANDROID_KEYSTORE for the build:
#                                         gradle then signs the APK and the app bundle with it, and only with it
#                                         (plugins/android-signing.js)
#   mobile-sign.sh android-verify <file>... prints the certificates that signed APKs and app bundles: one each
#   mobile-sign.sh ios-enabled            prints true when the certificate, both profiles and team are set
#   mobile-sign.sh testflight-enabled     prints true when the App Store Connect key is set
#   mobile-sign.sh ios-keychain           a temporary keychain with the identity and Apple's intermediates, and the
#                                         profiles installed
#   mobile-sign.sh ios-project            signs the app and extension targets manually (only them: the pods' bundles
#                                         stay unsigned)
#   mobile-sign.sh ios-export <archive> <out> upload|export
#                                         an .ipa from the archive: sent to TestFlight, or written to <out>
#   mobile-sign.sh cleanup                deletes the keychain and any decoded key material (run it with always())
set -euo pipefail
tmp="${RUNNER_TEMP:?}"
keychain="$tmp/fleetd-mobile.keychain-db"
p12="$tmp/fleetd-mobile.p12"
profile="$tmp/fleetd-mobile.mobileprovision"
extension_profile="$tmp/fleetd-mobile-extension.mobileprovision"
p8="$tmp/fleetd-asc.p8"
jks="$tmp/fleetd-mobile.jks"

die() { echo "::error::$*"; exit 1; }
set_all() { for v in "$@"; do [ -n "${!v:-}" ] || return 1; done; }
profile_uuid() { security cms -D -i "${1:-$profile}" | plutil -extract UUID raw -o - -; }

# Apple's WWDR intermediates, by SHA-256 of the .cer: a distribution certificate is valid only with its issuer's in
# reach, and the runner's own keychains needn't hold it. G3 to G5 chain to Apple Root CA, G6 to Apple Root CA - G3.
wwdr_certs="AppleWWDRCAG3 dcf21878c77f4198e4b4614f03d696d89c66c66008d4244e1b99161aac91601f
AppleWWDRCAG4 ea4757885538dd8cb59ff4556f676087d83c85e70902c122e42c0808b5bce14c
AppleWWDRCAG5 53fd008278e5a595fe1e908ae9c5e5675f26243264a5a6438c023e3ce2870760
AppleWWDRCAG6 bdd4ed6e74691f0c2bfd01be0296197af1379e0418e2d300efa9c3bef642ca30"

wwdr_import() {
  while read -r name sha; do
    cer="$tmp/$name.cer"
    curl -fsSL --proto '=https' --retry 3 "https://www.apple.com/certificateauthority/$name.cer" -o "$cer"
    [ "$(shasum -a 256 "$cer" | cut -d ' ' -f 1)" = "$sha" ] || die "$name.cer from apple.com isn't the pinned one"
    security import "$cer" -k "$keychain" >/dev/null
    rm -f "$cer"
  done <<< "$wwdr_certs"
}

# Fails, saying which fix applies, unless the keychain holds a valid Apple Distribution identity. Prints no key material:
# a count of private keys, the identities' names and the certificate's issuer.
ios_identity_check() {
  valid="$(security find-identity -v -p codesigning "$keychain")"
  grep -q "Apple Distribution" <<< "$valid" && return 0
  all="$(security find-identity -p codesigning "$keychain")"
  echo "Code signing identities, valid or not:"
  echo "$all"
  keys="$(security dump-keychain "$keychain" | grep -c '^class: 0x00000010' || true)"
  echo "Private keys the .p12 held: $keys"
  if security find-certificate -c "Apple Distribution" -p "$keychain" > "$tmp/fleetd-dist.pem" 2>/dev/null; then
    openssl x509 -in "$tmp/fleetd-dist.pem" -noout -subject -issuer -enddate
  fi
  rm -f "$tmp/fleetd-dist.pem"
  if [ "$keys" = 0 ]; then
    die "the .p12 holds no private key: export it again from Keychain Access (My Certificates, the Apple Distribution certificate with its key under it) and set IOS_CERT_P12_BASE64 again"
  fi
  if ! grep -q "Apple Distribution" <<< "$all"; then
    die "the .p12's key isn't an Apple Distribution certificate's: export the Apple Distribution certificate together with its own key"
  fi
  die "the .p12 holds the key, but its Apple Distribution certificate isn't valid (the reason is above): its issuer isn't one of Apple's WWDR intermediates, or it's expired or revoked"
}

case "${1:-}" in
android-enabled)
  if set_all ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; then
    echo true
  else
    echo "Android keystore secrets absent; the APK stays debug-signed" >&2
    echo false
  fi
  ;;

android-keystore)
  (umask 077 && printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$jks")
  echo "FLEETD_ANDROID_KEYSTORE=$jks" >> "${GITHUB_ENV:?}"
  ;;

android-verify)
  shift
  tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
  for file in "$@"; do
    case "$file" in
    *.apk) "$tools/apksigner" verify --print-certs "$file" | grep -v -i 'sha-1' ;;
    # A bundle's signatures are its META-INF/*.RSA (or .EC, .DSA) files: exactly one, the release key's.
    *.aab)
      jarsigner -verify "$file" >/dev/null || die "$file isn't signed"
      count="$(unzip -Z1 "$file" | grep -c -E '^META-INF/[^/]+\.(RSA|EC|DSA)$' || true)"
      [ "$count" = 1 ] || die "$file has $count signatures, not one"
      echo "$file: signed once"
      ;;
    *) die "$file is neither an .apk nor an .aab" ;;
    esac
  done
  ;;

ios-enabled)
  if set_all IOS_CERT_P12_BASE64 IOS_CERT_PASSWORD IOS_PROFILE_BASE64 IOS_EXTENSION_PROFILE_BASE64 APPLE_TEAM_ID; then
    echo true
  else
    echo "iOS signing secrets absent; no signed iOS build" >&2
    echo false
  fi
  ;;

testflight-enabled)
  if set_all ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8_BASE64; then echo true; else echo false; fi
  ;;

ios-keychain)
  pass="$(uuidgen)"
  security create-keychain -p "$pass" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$pass" "$keychain"
  wwdr_import
  (umask 077 && printf '%s' "$IOS_CERT_P12_BASE64" | base64 --decode > "$p12")
  security import "$p12" -k "$keychain" -P "$IOS_CERT_PASSWORD" -f pkcs12 -T /usr/bin/codesign >/dev/null
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$keychain" >/dev/null
  # shellcheck disable=SC2046 # one keychain per word
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  ios_identity_check
  printf '%s' "$IOS_PROFILE_BASE64" | base64 --decode > "$profile"
  printf '%s' "$IOS_EXTENSION_PROFILE_BASE64" | base64 --decode > "$extension_profile"
  for file in "$profile" "$extension_profile"; do
    uuid="$(profile_uuid "$file")"
    # Where Xcode 16 and later look, and where earlier ones did.
    for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
      mkdir -p "$dir"
      cp "$file" "$dir/$uuid.mobileprovision"
    done
  done
  ;;

ios-project)
  uuid="$(profile_uuid)"
  extension_uuid="$(profile_uuid "$extension_profile")"
  TEAM="$APPLE_TEAM_ID" APP="$uuid" EXTENSION="$extension_uuid" ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ARGV[0])
    { "fleetd" => ENV["APP"], "FleetdNotifications" => ENV["EXTENSION"] }.each do |name, uuid|
      target = project.targets.find { |t| t.name == name } or abort "no #{name} target"
      target.build_configurations.each do |c|
        c.build_settings.merge!(
          "CODE_SIGN_STYLE" => "Manual",
          "DEVELOPMENT_TEAM" => ENV["TEAM"],
          "CODE_SIGN_IDENTITY" => "Apple Distribution",
          "PROVISIONING_PROFILE_SPECIFIER" => uuid,
        )
      end
    end
    project.save' "ios/fleetd.xcodeproj"
  echo "The app target signs with profile $uuid, the extension with $extension_uuid"
  ;;

ios-export)
  archive="$2"
  out="$3"
  destination="$4"
  uuid="$(profile_uuid)"
  extension_uuid="$(profile_uuid "$extension_profile")"
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleIdentifier' "$archive/Info.plist")"
  plist="$tmp/ExportOptions.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$bundle</key><string>$uuid</string>
    <key>$bundle.notifications</key><string>$extension_uuid</string>
  </dict>
</dict>
</plist>
EOF
  if [ "$destination" = upload ]; then
    (umask 077 && printf '%s' "$ASC_KEY_P8_BASE64" | base64 --decode > "$p8")
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$plist" -exportPath "$out" \
      -authenticationKeyPath "$p8" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
    rm -f "$p8"
  else
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$plist" -exportPath "$out"
  fi
  ;;

cleanup)
  security delete-keychain "$keychain" 2>/dev/null || true
  rm -f "$p12" "$p8" "$jks" "$profile" "$extension_profile"
  ;;

*)
  die "usage: mobile-sign.sh android-enabled|android-keystore|android-verify|ios-enabled|testflight-enabled|ios-keychain|ios-project|ios-export|cleanup"
  ;;
esac
