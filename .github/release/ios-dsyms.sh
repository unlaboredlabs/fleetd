#!/usr/bin/env bash
# Puts the dSYMs of the app's prebuilt frameworks into an iOS archive before it's exported, so App Store Connect can
# symbolicate TestFlight testers' crashes in them. Xcode writes dSYMs only for what it compiles: React Native's
# React, ReactNativeDependencies and hermesvm come prebuilt from Maven, Expo's precompiled modules and their Swift
# packages (ExpoCameraBarcodeScanning, SDWebImage…) as xcframeworks, and each export warned "Upload Symbols Failed"
# for them. React Native publishes their dSYMs beside the frameworks on Maven, checked here against its SHA-256; the
# xcframeworks carry theirs in each slice. A dSYM goes in only when its UUIDs are the archived binary's.
#
# Run from app/mobile after the archive: ios-dsyms.sh <archive>. A framework left without one is a warning, not a
# failure: the build is still good, its crashes in that framework just aren't symbolicated.
set -euo pipefail
archive="$1"
app="$archive/Products/Applications/fleetd.app"
out="$archive/dSYMs"
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fleetd-dsyms"
rm -rf "$work"
mkdir -p "$work" "$out"

rn="$(node -p 'require("react-native/package.json").version')"
hermes="$(sed -n 's/^HERMES_VERSION_NAME=//p' node_modules/react-native/sdks/hermes-engine/version.properties)"
maven=https://repo1.maven.org/maven2/com/facebook

# One Maven dSYM tarball, its device slice alone unpacked into $work/<name>.
fetch() {
  name="$1" url="$2" slice="$3"
  tgz="$work/$name.tar.gz"
  if ! curl -fsSL --proto '=https' --retry 3 --max-time 600 "$url" -o "$tgz" || ! sum="$(curl -fsSL --proto '=https' --retry 3 --max-time 60 "$url.sha256")"; then
    echo "::warning::No $name dSYMs from Maven ($url)."
    return 0
  fi
  if [ "$(shasum -a 256 "$tgz" | cut -d ' ' -f 1)" != "$(printf %s "$sum" | tr -d '[:space:]' | cut -c 1-64)" ]; then
    echo "::warning::$name dSYMs from Maven don't match their SHA-256: left out."
    rm -f "$tgz"
    return 0
  fi
  mkdir -p "$work/$name"
  tar -xzf "$tgz" -C "$work/$name" "./$slice" 2>/dev/null || tar -xzf "$tgz" -C "$work/$name"
  rm -f "$tgz"
}
fetch core "$maven/react/react-native-artifacts/$rn/react-native-artifacts-$rn-reactnative-core-dSYM-release.tar.gz" ios-arm64
fetch dependencies "$maven/react/react-native-artifacts/$rn/react-native-artifacts-$rn-reactnative-dependencies-dSYM-release.tar.gz" ios-arm64
fetch hermes "$maven/hermes/hermes-ios/$hermes/hermes-ios-$hermes-hermes-framework-dSYM-release.tar.gz" iphoneos

# Expo's precompiled modules, release flavour, as their packages ship them; their Swift packages' are unpacked already.
for tgz in node_modules/*/prebuilds/output/release/xcframeworks/*.tar.gz node_modules/@*/*/prebuilds/output/release/xcframeworks/*.tar.gz; do
  [ -f "$tgz" ] || continue
  dir="$work/expo/$(basename "$tgz" .tar.gz)"
  mkdir -p "$dir"
  tar -xzf "$tgz" -C "$dir"
done

uuids() { dwarfdump --uuid "$1" 2>/dev/null | awk '{ print $2 }' | sort; }

# Every dSYM that could be one of them: Maven's, the precompiled modules', and any CocoaPods or Swift packages put in ios/.
candidates="$work/candidates"
find "$work" node_modules ios -name '*.framework.dSYM' -type d -prune 2>/dev/null > "$candidates" || true

added=0
missing=""
for fw in "$app"/Frameworks/*.framework; do
  [ -d "$fw" ] || continue
  name="$(basename "$fw" .framework)"
  bin="$fw/$name"
  [ -f "$bin" ] || continue
  want="$(uuids "$bin")"
  [ -n "$want" ] || continue
  [ -d "$out/$name.framework.dSYM" ] && [ "$(uuids "$out/$name.framework.dSYM")" = "$want" ] && continue
  found=""
  while read -r dsym; do
    [ "$(basename "$dsym")" = "$name.framework.dSYM" ] || continue
    # The device slice's dSYM holds the binary's UUIDs; a simulator slice's has others.
    if [ -z "$(comm -23 <(printf '%s\n' "$want") <(uuids "$dsym"))" ]; then
      found="$dsym"
      break
    fi
  done < "$candidates"
  if [ -n "$found" ]; then
    rm -rf "$out/$name.framework.dSYM"
    cp -R "$found" "$out/"
    echo "dSYM for $name.framework: $(printf '%s' "$want" | tr '\n' ' ')"
    added=$((added + 1))
  else
    missing="$missing $name"
  fi
done
echo "$added dSYMs added to the archive"
[ -z "$missing" ] || echo "::warning::No dSYM for:$missing. Crashes in them won't be symbolicated."
rm -rf "$work"
