#!/usr/bin/env bash
# Writes the electron-updater feed for one desktop asset: latest-mac.yml for the macOS zip, latest-linux.yml for the
# AppImage. The app (app/desktop/src/main/updater.ts) reads it from the release's download URL next to the asset and
# checks the download against its sha512. Run again whenever the asset changes (macos-staple.sh does, after
# stapling), or every app that reads the old file rejects the new download.
#
#   update-yml.sh <asset> <version> > latest-mac.yml
set -euo pipefail
asset="$1"
version="$2"
name="$(basename "$asset")"
sha512="$(openssl dgst -sha512 -binary "$asset" | base64 | tr -d '\n')"
size="$(wc -c < "$asset" | tr -d ' ')"
cat <<YML
version: $version
files:
  - url: $name
    sha512: $sha512
    size: $size
path: $name
sha512: $sha512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
YML
