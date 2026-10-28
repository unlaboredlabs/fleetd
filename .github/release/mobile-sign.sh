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
#   APPLE_TEAM_ID             the team's 10-character id
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64
#                             an App Store Connect API key (App Manager role): without it the signed .ipa is kept
#                             as an artifact and not sent to TestFlight
#
#   mobile-sign.sh android-enabled        prints true when the keystore secrets are set (else logs and prints false)
#   mobile-sign.sh android <file>...      signs APKs (apksigner) and app bundles (jarsigner) in place
#   mobile-sign.sh ios-enabled            prints true when the certificate, profile and team are set
#   mobile-sign.sh testflight-enabled     prints true when the App Store Connect key is set
#   mobile-sign.sh ios-keychain           a temporary keychain with the identity, and the profile installed
#   mobile-sign.sh ios-project            signs the app target manually (only it: the pods' bundles stay unsigned)
#   mobile-sign.sh ios-export <archive> <out> upload|export
#                                         an .ipa from the archive: sent to TestFlight, or written to <out>
#   mobile-sign.sh cleanup                deletes the keychain and any decoded key material (run it with always())
set -euo pipefail
tmp="${RUNNER_TEMP:?}"
keychain="$tmp/fleetd-mobile.keychain-db"
p12="$tmp/fleetd-mobile.p12"
profile="$tmp/fleetd-mobile.mobileprovision"
p8="$tmp/fleetd-asc.p8"
jks="$tmp/fleetd-mobile.jks"

die() { echo "::error::$*"; exit 1; }
set_all() { for v in "$@"; do [ -n "${!v:-}" ] || return 1; done; }
profile_uuid() { security cms -D -i "$profile" | plutil -extract UUID raw -o - -; }

case "${1:-}" in
android-enabled)
  if set_all ANDROID_KEYSTORE_BASE64 ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS ANDROID_KEY_PASSWORD; then
    echo true
  else
    echo "Android keystore secrets absent; the APK stays debug-signed" >&2
    echo false
  fi
  ;;

android)
  shift
  (umask 077 && printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$jks")
  tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
  for file in "$@"; do
    case "$file" in
    *.apk)
      "$tools/apksigner" sign --ks "$jks" --ks-pass env:ANDROID_KEYSTORE_PASSWORD --ks-key-alias "$ANDROID_KEY_ALIAS" \
        --key-pass env:ANDROID_KEY_PASSWORD "$file"
      "$tools/apksigner" verify --print-certs "$file" | grep -v -i 'sha-1'
      ;;
    *.aab)
      jarsigner -keystore "$jks" -storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env ANDROID_KEY_PASSWORD \
        -sigalg SHA256withRSA -digestalg SHA-256 "$file" "$ANDROID_KEY_ALIAS"
      ;;
    *) die "$file is neither an .apk nor an .aab" ;;
    esac
  done
  rm -f "$jks"
  ;;

ios-enabled)
  if set_all IOS_CERT_P12_BASE64 IOS_CERT_PASSWORD IOS_PROFILE_BASE64 APPLE_TEAM_ID; then
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
  (umask 077 && printf '%s' "$IOS_CERT_P12_BASE64" | base64 --decode > "$p12")
  security import "$p12" -k "$keychain" -P "$IOS_CERT_PASSWORD" -f pkcs12 -T /usr/bin/codesign >/dev/null
  rm -f "$p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$pass" "$keychain" >/dev/null
  # shellcheck disable=SC2046 # one keychain per word
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  security find-identity -v -p codesigning "$keychain" | grep -q "Apple Distribution" ||
    die "the .p12 holds no valid Apple Distribution identity"
  printf '%s' "$IOS_PROFILE_BASE64" | base64 --decode > "$profile"
  uuid="$(profile_uuid)"
  # Where Xcode 16 and later look, and where earlier ones did.
  for dir in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
    mkdir -p "$dir"
    cp "$profile" "$dir/$uuid.mobileprovision"
  done
  ;;

ios-project)
  uuid="$(profile_uuid)"
  TEAM="$APPLE_TEAM_ID" UUID="$uuid" ruby -rxcodeproj -e '
    project = Xcodeproj::Project.open(ARGV[0])
    target = project.targets.find { |t| t.name == "fleetd" } or abort "no fleetd target"
    target.build_configurations.each do |c|
      c.build_settings.merge!(
        "CODE_SIGN_STYLE" => "Manual",
        "DEVELOPMENT_TEAM" => ENV["TEAM"],
        "CODE_SIGN_IDENTITY" => "Apple Distribution",
        "PROVISIONING_PROFILE_SPECIFIER" => ENV["UUID"],
      )
    end
    project.save' "ios/fleetd.xcodeproj"
  echo "The app target signs with profile $uuid"
  ;;

ios-export)
  archive="$2"
  out="$3"
  destination="$4"
  uuid="$(profile_uuid)"
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
  <key>provisioningProfiles</key><dict><key>$bundle</key><string>$uuid</string></dict>
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
  rm -f "$p12" "$p8" "$jks" "$profile"
  ;;

*)
  die "usage: mobile-sign.sh android-enabled|android|ios-enabled|testflight-enabled|ios-keychain|ios-project|ios-export|cleanup"
  ;;
esac
