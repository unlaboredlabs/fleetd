#!/usr/bin/env bash
# Wraps fleetd-app in fleetd.app. macOS only shows an app's notifications (UNUserNotificationCenter) when it runs
# from a bundle with an identifier; run as a bare binary, the app works but posts none.
#
#   app/packaging/macos-bundle.sh [binary...]
#
# No binary: builds release for this Mac. Two binaries (one per arch, as the release build passes): lipo'd into one
# universal binary. Writes fleetd.app next to the first binary and prints its path. FLEETD_VERSION sets the
# bundle version (default 0.0.0). The bundle gets an ad-hoc signature; the release workflow re-signs it with a
# Developer ID when one is configured.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

bins=()
for b in "$@"; do bins+=("$(cd "$(dirname "$b")" && pwd)/$(basename "$b")"); done
if [ ${#bins[@]} -eq 0 ]; then
  (cd "$here" && cargo build --release --locked -p fleetd-app >&2)
  bins=("${CARGO_TARGET_DIR:-$here/../../target}/release/fleetd-app")
fi
version="${FLEETD_VERSION:-0.0.0}"
# CFBundleVersion must be dot-separated integers; 0.4.0-nightly.20261017.abc1234 -> 0.4.0.
short="${version%%-*}"

app="$(dirname "${bins[0]}")/fleetd.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
if [ ${#bins[@]} -gt 1 ]; then
  lipo -create "${bins[@]}" -output "$app/Contents/MacOS/fleetd-app"
else
  cp "${bins[0]}" "$app/Contents/MacOS/fleetd-app"
fi

# The identifier must match cx.set_app_identity in fleetd-app/src/main.rs.
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>sh.fleetd.app</string>
  <key>CFBundleName</key><string>fleetd</string>
  <key>CFBundleDisplayName</key><string>fleetd</string>
  <key>CFBundleExecutable</key><string>fleetd-app</string>
  <key>CFBundleIconFile</key><string>fleetd</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$short</string>
  <key>CFBundleVersion</key><string>$short</string>
  <key>FleetdVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- fleetd://pair links (printed by fleetd pair) open the app and pair it. -->
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>sh.fleetd.app.pair</string>
      <key>CFBundleURLSchemes</key><array><string>fleetd</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

if [ "$(uname -s)" = Darwin ]; then
  iconset="$(mktemp -d)/fleetd.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$here/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z $((size * 2)) $((size * 2)) "$here/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/fleetd.icns"
  rm -rf "$(dirname "$iconset")"
  plutil -lint "$app/Contents/Info.plist" >&2
  # Ad-hoc signature: enough for a bundle fetched with curl (no quarantine) or built on this Mac.
  codesign --force --deep --sign - "$app" >&2
fi
echo "$app"
