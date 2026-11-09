#!/usr/bin/env bash
# Writes the electron-updater feed for one desktop asset: latest-mac.yml for the macOS zip, latest-linux.yml for the
# AppImage. The app (app/desktop/src/main/updater.ts) reads it from the release's download URL next to the asset and
# checks the download against its sha512. Run again whenever the asset changes (macos-staple.sh does, after
# stapling), or every app that reads the old file rejects the new download.
#
# It also writes what the app's differential download needs, so an update fetches only the blocks that changed: for the
# zip, <asset>.blockmap beside it (blockmap.mjs, which needs app/desktop's node_modules), published with it; for the
# AppImage, whose map electron-builder appended to the file (its size in the last 4 bytes), blockMapSize.
#
# The feed names the asset's pinned copy (pinned.sh), which never changes once uploaded, not its plain name, which edge
# replaces in place: an app reading the feed then downloads the very package its sha512 is for, whatever edge publishes
# meanwhile. Whoever publishes the feed uploads that copy first, and for the zip its blockmap as <pin>.blockmap.
#
#   update-yml.sh <asset> <version> > latest-mac.yml
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=.github/release/pinned.sh
. "$here/pinned.sh"
asset="$1"
version="$2"
name="$(pinned "$(basename "$asset")" "$(shasum -a 256 "$asset" | cut -d' ' -f1)")"
sha512="$(openssl dgst -sha512 -binary "$asset" | base64 | tr -d '\n')"
size="$(wc -c < "$asset" | tr -d ' ')"
blockmap=""
case "$asset" in
*.zip) node "$here/blockmap.mjs" "$asset" ;;
*.AppImage)
  blockmap="$(tail -c 4 "$asset" | od -An -tu1 | awk '{ print $1 * 16777216 + $2 * 65536 + $3 * 256 + $4 }')"
  if [ "$blockmap" -le 0 ] || [ "$blockmap" -ge "$size" ]; then
    echo "$(basename "$asset") has no blockmap at its end" >&2
    exit 1
  fi
  blockmap="    blockMapSize: $blockmap"$'\n'
  ;;
esac
cat <<YML
version: $version
files:
  - url: $name
    sha512: $sha512
    size: $size
${blockmap}path: $name
sha512: $sha512
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
YML
