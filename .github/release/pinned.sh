# shellcheck shell=bash
# Sourced by the release scripts. pinned <asset> <sha256>: the name a release keeps <asset>'s build under for good, so a
# reader of one build's checksums never gets another build's bytes: the first 16 hex digits of its SHA-256 before its
# extension (.zip, .AppImage, which electron-updater picks its download by), else at its end. src/update's pinnedName
# and site/install.sh's pinned name them the same way.
pinned() {
  case "$1" in
  *.zip | *.AppImage) echo "${1%.*}-${2:0:16}.${1##*.}" ;;
  *) echo "$1-${2:0:16}" ;;
  esac
}

# unpinned <feed>: the update feed naming its plain packages instead of their pins, for the nightly copy, which holds
# no pins.
unpinned() {
  sed -E 's/^(  - url: |path: )(.+)-[0-9a-f]{16}(\.zip|\.AppImage)$/\1\2\3/' "$1"
}
