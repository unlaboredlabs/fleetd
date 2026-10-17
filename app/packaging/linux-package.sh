#!/bin/sh
# Packs a Linux fleetd-app build for release: fleetd-app, fleetd.desktop and fleetd.png in one tarball.
# The installer rewrites the .desktop file's Exec and Icon to where it put them.
#
#   app/packaging/linux-package.sh <fleetd-app binary> <out.tar.gz>
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
bin="$1"
out="$2"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$bin" "$stage/fleetd-app"
chmod 755 "$stage/fleetd-app"
cp "$here/fleetd.desktop" "$stage/fleetd.desktop"
cp "$here/icon.png" "$stage/fleetd.png"
tar -C "$stage" -czf "$out" fleetd-app fleetd.desktop fleetd.png
