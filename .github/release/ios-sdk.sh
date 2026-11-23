#!/usr/bin/env bash
# Fails when the phone app was built against an iOS SDK older than 27, which the iPhone Duo unfolded runs letterboxed,
# phone-sized, and App Store Connect stops taking in April 2027 (ITMS-90725). A runner image's default Xcode moves on
# its own schedule: this holds each iOS build (mac.yml's simulator ones, mobile-release.yml's) to the SDK it needs.
#
# ios-sdk.sh <the built app's Info.plist>, on macOS.
set -euo pipefail
sdk="$(plutil -extract DTPlatformVersion raw "$1")"
if [ "${sdk%%.*}" -lt 27 ]; then
  echo "::error::Built against the iOS $sdk SDK ($(xcodebuild -version | head -1)): the iPhone Duo unfolded runs it letterboxed. Build on a runner image with Xcode 27 or newer (runs-on: xcode-27)."
  exit 1
fi
echo "Built against the iOS $sdk SDK."
