#!/usr/bin/env bash
# The darwin fleetd binaries are cross-built on Linux with cargo-zigbuild, which has no macOS SDK, so fleetd must not
# depend on a crate that links a macOS framework (Security, CoreFoundation, SystemConfiguration, ...). Use rustls with
# webpki-roots: not rustls-native-certs, rustls-platform-verifier, native-tls, keyring or reqwest's default features.
# This names the offending crate before the link fails with "unable to find system framework".
set -euo pipefail
deny='^(core-foundation|core-foundation-sys|security-framework|security-framework-sys|system-configuration|system-configuration-sys|objc2|objc|cocoa|core-graphics|keyring|rustls-native-certs|rustls-platform-verifier|native-tls|openssl-sys) '
status=0
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  found="$(cargo tree --locked -p fleetd --target "$target" -e normal --prefix none | sort -u | grep -E "$deny" || true)"
  if [ -n "$found" ]; then
    status=1
    echo "::error::fleetd for $target depends on crates that link macOS frameworks:"
    echo "$found"
    for crate in $(echo "$found" | cut -d' ' -f1 | sort -u); do
      echo "--- why $crate:"
      cargo tree --locked -p fleetd --target "$target" -e normal -i "$crate" | head -20
    done
  fi
done
[ "$status" = 0 ] && echo "fleetd links no macOS framework crates"
exit "$status"
