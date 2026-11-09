#!/usr/bin/env bash
# Publishes the assets in dist/ to a GitHub release: the rolling `edge` prerelease (CHANNEL=edge) or the release of
# the pushed v* tag (CHANNEL=stable).
#
# Next to the assets it uploads SHA256SUMS (plain `sha256sum` output, one line per asset), release.json
# ({channel, version, commit, date, cliVersion, appVersion, appCommit, sha256}), which `fleetd update`, the app's update
# notice and the next edge build's "did the app change" check read, and changes.json, the channel's "what's new" since
# the previous release's commit (changes.sh). An edge build that skipped the app (unchanged) or the CLI keeps the
# previous run's assets, checksums and versions for it. These files go up last, so a reader never sees checksums for
# assets that are not there yet.
#
# Edge replaces its assets in place, and GitHub's downloads can hand one reader files of two builds (a cache's older
# SHA256SUMS beside the next build's binary). So each CLI build also goes up pinned, as <asset>-<first 16 hex digits of
# its SHA-256>, a name that never changes once uploaded, and release.json's sha256 ({asset: SHA-256}) names them: hubs,
# nodes and `fleetd update` read the build and its checksums from that one file and download the pinned copies
# (src/update). Pins no release.json names go once they are 2 hours old, so a reader holding an older release.json
# still finds its build meanwhile.
#
# Edge was called nightly until D203, and builds from before then (CLI, hub, nodes, app) read the `nightly` release.
# So every edge publish uploads the same files there too, and they update to the edge build, which reads edge from
# then on. Only the app's version differs, in the feeds and release.json's appVersion: it says `-nightly.` where the
# build's says `-edge.`, because an app from before compares them as semver, where "edge" sorts before "nightly" and
# the newest build would look older. That version is only those comparisons'; the app it installs reports its own.
# The CLI's version stays as it is: hubs and nodes match it with what the new binary reports. The copy's SHA256SUMS
# lists the assets this run built and the copy's own lines for the rest, so a checksum never names a file it doesn't
# hold; macos-staple.sh staples edge's app and then copies it, its feed and its checksums there, as they are on edge.
#
# The GPUI app's macOS zip, retired, leaves the release and its checksums: a `fleetd update` from before the Electron
# app then updates the CLI and stops, leaving the app alone (on macOS 11, where the Electron app can't run, it stays
# GPUI), and the next `fleetd update` moves it over. Its Linux tarball is still built, around the AppImage, so that
# CLI moves a Linux install in one run (build-release.yml).
#
# The desktop app's update feeds (latest-mac.yml, latest-linux.yml, from update-yml.sh) go up after the assets they
# point at, for the same reason. An edge build that didn't build the desktop app keeps the previous feeds.
#
# Env: CHANNEL, VERSION, APP_BUILT, CLI_PUBLISH, GH_TOKEN, GITHUB_SHA, GITHUB_REF_NAME.
set -euo pipefail
: "${CHANNEL:?}" "${VERSION:?}" "${APP_BUILT:?}" "${CLI_PUBLISH:?}" "${GITHUB_SHA:?}"
here="$(cd "$(dirname "$0")" && pwd)"
cd dist
if [ "$CLI_PUBLISH" != true ]; then rm -f fleetd-bun-*; fi
shopt -s nullglob
# The CLI's builds are fleetd-bun-<os>-<arch> (bun-build.sh). They also go up under the names the Rust builds had,
# fleetd-<os>-<arch> and its .lzma (`xz --format=lzma`, which the Rust build's `fleetd update` takes when SHA256SUMS
# lists it): a machine still on the Rust build (a hub, `fleetd update`, a node of an older hub) updates to this release
# by the asset it knows and comes back on the Bun build, at the same path, reporting this version. The Bun build reads
# the plain fleetd-bun-* names; Bun has no LZMA decoder.
packing=()
for target in linux-x64 darwin-arm64 darwin-x64; do
  if [ -f "fleetd-bun-$target" ]; then
    cp "fleetd-bun-$target" "fleetd-$target"
    xz --format=lzma -9e -c "fleetd-$target" > "fleetd-$target.lzma" &
    packing+=("$!")
  fi
done
for pid in ${packing[@]+"${packing[@]}"}; do wait "$pid"; done
assets=(fleetd-*)
if [ ${#assets[@]} -eq 0 ]; then
  echo "nothing was built; the release stays as it is"
  exit 0
fi
cli_built=false
if [ -n "$(compgen -G 'fleetd-bun-linux-*')" ]; then cli_built=true; fi

if [ "$CHANNEL" = edge ]; then tag=edge; else tag="${GITHUB_REF_NAME:?}"; fi
# One line for whoever updates from before the Electron app (see the retired zip above).
upgrade="Updating a Mac from before the Electron app: run \`fleetd update\` twice (the CLI first, then the app)."


prev="$(mktemp -d)"
if [ "$CHANNEL" = edge ]; then
  # Before the first edge build, the last nightly carries on: its checksums, versions and what's new.
  gh release download edge -p SHA256SUMS -p release.json -p changes.json -D "$prev" 2>/dev/null ||
    gh release download nightly -p SHA256SUMS -p release.json -p changes.json -D "$prev" --clobber 2>/dev/null ||
    echo "no previous edge build"
  since="$prev"
else
  # The latest stable release, before this one exists: what's new runs from its commit.
  since="$(mktemp -d)"
  gh release download -p release.json -p changes.json -D "$since" 2>/dev/null || echo "no previous release"
fi
[ -s "$prev/release.json" ] || echo '{}' > "$prev/release.json"
"$here/changes.sh" "$since" "$GITHUB_SHA" > changes.json
touch "$prev/SHA256SUMS"

sha256sum "${assets[@]}" > "$prev/built"
retired=(fleetd-app-macos-universal.zip)
# sums <previous SHA256SUMS>: this run's lines, then the previous ones for the assets it didn't build.
sums() {
  awk -v retired="${retired[*]}" 'BEGIN { split(retired, r, " "); for (i in r) gone[r[i]] = 1 }
    NR == FNR { built[$2] = 1; next } !($2 in built) && !($2 in gone)' "$prev/built" "$1" |
    cat "$prev/built" - | sort -k2
}
sums "$prev/SHA256SUMS" > SHA256SUMS

# This run's CLI builds, pinned (see the top): the copies to upload, and their lines for release.json's sha256.
cli='^fleetd-(bun-)?(linux|darwin)-[a-z0-9]+'
pins=()
mkdir -p "$prev/pins"
: > "$prev/pinned"
while read -r sum name; do
  if [[ "$name" =~ $cli$ ]]; then
    cp "$name" "$prev/pins/$name-${sum:0:16}"
    pins+=("$prev/pins/$name-${sum:0:16}")
    echo "$sum $name" >> "$prev/pinned"
  fi
done < "$prev/built"

# The previous release's pins carry on for the builds this run didn't make, as in SHA256SUMS. A release with none pinned
# leaves sha256 out, and its readers take SHA256SUMS.
jq -n --arg channel "$CHANNEL" --arg version "$VERSION" --arg commit "$GITHUB_SHA" --arg date "$(date -u +%FT%TZ)" \
  --arg cli "$cli_built" --arg app "$APP_BUILT" --slurpfile prev "$prev/release.json" --rawfile pinned "$prev/pinned" '
  $prev[0] as $p
  | (($p.sha256 // {}) + ($pinned | split("\n") | map(select(. != "") | split(" ") | {(.[1]): .[0]}) | add // {})) as $sha
  | {
    channel: $channel, version: $version, commit: $commit, date: $date,
    cliVersion: (if $cli == "true" then $version else $p.cliVersion end),
    appVersion: (if $app == "true" then $version else $p.appVersion end),
    appCommit: (if $app == "true" then $commit else $p.appCommit end)
  } + (if ($sha | length) > 0 then {sha256: $sha} else {} end)' > release.json
cat SHA256SUMS release.json
jq -r '.changes[:20][] | "\(.commit[:7]) \(.areas | join(",")): \(.subject)"' changes.json

# rolling <tag> <title> <notes>: points <tag> at this commit and makes its prerelease say so.
rolling() {
  git push -f origin "${GITHUB_SHA}:refs/tags/$1"
  if gh release view "$1" >/dev/null 2>&1; then
    gh release edit "$1" --prerelease --title "$2" --notes "$3"
  else
    gh release create "$1" --prerelease --latest=false --title "$2" --notes "$3"
  fi
}

# upload <tag> <dir of its SHA256SUMS and release.json> <feed>...: the assets, then the feeds, then the files that
# list them.
upload() {
  local to="$1" lists="$2"
  shift 2
  gh release upload "$to" "${assets[@]}" --clobber
  if [ $# -gt 0 ]; then gh release upload "$to" "$@" --clobber; fi
  gh release upload "$to" "$lists/SHA256SUMS" "$lists/release.json" changes.json --clobber
  for name in "${retired[@]}"; do gh release delete-asset "$to" "$name" -y 2>/dev/null || true; done
  echo "published https://github.com/${GITHUB_REPOSITORY:-unlaboredlabs/fleetd}/releases/tag/$to"
}

feeds=(latest-*.yml)
if [ "$CHANNEL" = edge ]; then
  notes="Rolling build of main at ${GITHUB_SHA} (${VERSION}), published after each merge."
  notes+=" Install: curl -fsSL https://fleetd.sh | sh"
  notes+=$'\n\n'"$upgrade"
  rolling edge "Edge" "$notes"
else
  gh release view "$tag" >/dev/null 2>&1 || gh release create "$tag" --verify-tag --title "fleetd $VERSION" --notes "$upgrade" --generate-notes
fi
# The pins first: the release.json that names them goes up after them.
if [ ${#pins[@]} -gt 0 ]; then gh release upload "$tag" "${pins[@]}" --clobber; fi
upload "$tag" . "${feeds[@]}"
if [ "$CHANNEL" = edge ]; then
  keep="$(jq -r '.sha256 // {} | to_entries[] | "\(.key)-\(.value[:16])"' release.json)"
  cutoff="$(date -u -d '2 hours ago' +%FT%TZ)"
  gh release view edge --json assets -q '.assets[] | "\(.createdAt) \(.name)"' | while read -r at name; do
    if [[ "$name" =~ $cli-[0-9a-f]{16}$ && "$at" < "$cutoff" ]] && ! grep -qxF "$name" <<< "$keep"; then
      gh release delete-asset edge "$name" -y || true
    fi
  done
fi

if [ "$CHANNEL" = edge ]; then
  # The copy for builds from before the rename (see the top): the same files, with a nightly-named app version.
  mkdir -p "$prev/nightly" "$prev/nightly-was"
  nightly_feeds=()
  for feed in "${feeds[@]}"; do
    sed 's/^\(version: .*\)-edge\./\1-nightly./' "$feed" > "$prev/nightly/$feed"
    nightly_feeds+=("$prev/nightly/$feed")
  done
  # Without pins, which nightly doesn't hold.
  jq '.appVersion |= (if type == "string" then sub("-edge\\."; "-nightly.") else . end) | del(.sha256)' release.json > "$prev/nightly/release.json"
  if gh release download nightly -p SHA256SUMS -D "$prev/nightly-was" 2>/dev/null; then
    sums "$prev/nightly-was/SHA256SUMS" > "$prev/nightly/SHA256SUMS"
  else
    cp SHA256SUMS "$prev/nightly/SHA256SUMS"
  fi
  notes="A copy of the edge release (${VERSION}) for fleetd builds from before Nightly was renamed Edge: they update"
  notes+=" from here to Edge, and follow https://github.com/${GITHUB_REPOSITORY:-unlaboredlabs/fleetd}/releases/tag/edge"
  notes+=" from then on."
  rolling nightly "Nightly (now Edge)" "$notes"
  upload nightly "$prev/nightly" "${nightly_feeds[@]}"
fi
