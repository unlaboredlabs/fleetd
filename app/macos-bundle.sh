#!/usr/bin/env bash
# Wraps fleetd-app in fleetd.app. macOS only shows an app's notifications (UNUserNotificationCenter) when it runs
# from a bundle with an identifier; run as a bare binary, the app works but posts none.
#
#   app/macos-bundle.sh [binary]    # default: build release; writes fleetd.app next to the binary
set -euo pipefail
cd "$(dirname "$0")"

bin="${1:-}"
if [ -z "$bin" ]; then
  cargo build --release --locked -p fleetd-app >&2
  bin="${CARGO_TARGET_DIR:-target}/release/fleetd-app"
fi
app="$(dirname "$bin")/fleetd.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/fleetd-app"
# The identifier must match cx.set_app_identity in fleetd-app/src/main.rs.
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.fleetd.app</string>
  <key>CFBundleName</key><string>fleetd</string>
  <key>CFBundleExecutable</key><string>fleetd-app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
if [ "$(uname -s)" = Darwin ]; then
  plutil -lint "$app/Contents/Info.plist" >&2
  # Ad-hoc signature: enough for a bundle built and run on the same Mac.
  codesign --force --sign - "$app" >&2
fi
echo "$app"
