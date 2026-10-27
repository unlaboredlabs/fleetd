#!/usr/bin/env bash
# Publishes the assets in dist/ to a GitHub release: the rolling `edge` prerelease (CHANNEL=edge) or the release of
# the pushed v* tag (CHANNEL=stable).
#
# Next to the assets it uploads SHA256SUMS (plain `sha256sum` output, one line per asset), release.json
# ({channel, version, commit, date, cliVersion, appVersion, appCommit}), which `fleetd update`, the app's update
# notice and the next edge build's "did the app change" check read, and changes.json, the channel's "what's new" since
# the previous release's commit (changes.sh). An edge build that skipped the app (unchanged) or the CLI keeps the
# previous run's assets, checksums and versions for it. These files go up last, so a reader never sees checksums for
# assets that are not there yet.
#
# Edge was called nightly until D203, and builds from before then (CLI, hub, nodes, app) read the `nightly` release.
# So every edge publish uploads the same files there too, and they update to the edge build, which reads edge from
# then on. Only the app feeds differ: their version says `-nightly.` where the build's says `-edge.`, because an app
# from before compares them as semver, where "edge" sorts before "nightly" and the newest build would look older. The
# feed's version is only that comparison's; the app it installs reports its own.
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
if [ "$CLI_PUBLISH" != true ]; then rm -f fleetd-linux-* fleetd-darwin-*; fi
shopt -s nullglob
assets=(fleetd-*)
if [ ${#assets[@]} -eq 0 ]; then
  echo "nothing was built; the release stays as it is"
  exit 0
fi
cli_built=false
if [ -n "$(compgen -G 'fleetd-linux-*')" ]; then cli_built=true; fi

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
awk -v retired="${retired[*]}" 'BEGIN { split(retired, r, " "); for (i in r) gone[r[i]] = 1 }
  NR == FNR { built[$2] = 1; next } !($2 in built) && !($2 in gone)' "$prev/built" "$prev/SHA256SUMS" |
  cat "$prev/built" - | sort -k2 > SHA256SUMS

jq -n --arg channel "$CHANNEL" --arg version "$VERSION" --arg commit "$GITHUB_SHA" --arg date "$(date -u +%FT%TZ)" \
  --arg cli "$cli_built" --arg app "$APP_BUILT" --slurpfile prev "$prev/release.json" '
  $prev[0] as $p | {
    channel: $channel, version: $version, commit: $commit, date: $date,
    cliVersion: (if $cli == "true" then $version else $p.cliVersion end),
    appVersion: (if $app == "true" then $version else $p.appVersion end),
    appCommit: (if $app == "true" then $commit else $p.appCommit end)
  }' > release.json
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

# upload <tag> <feed>...: the assets, then the feeds, then the files that list them.
upload() {
  local to="$1"
  shift
  gh release upload "$to" "${assets[@]}" --clobber
  if [ $# -gt 0 ]; then gh release upload "$to" "$@" --clobber; fi
  gh release upload "$to" SHA256SUMS release.json changes.json --clobber
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
upload "$tag" "${feeds[@]}"

if [ "$CHANNEL" = edge ]; then
  # The copy for builds from before the rename (see the top): the same files, with nightly-named feed versions.
  mkdir -p "$prev/nightly"
  nightly_feeds=()
  for feed in "${feeds[@]}"; do
    sed 's/^\(version: .*\)-edge\./\1-nightly./' "$feed" > "$prev/nightly/$feed"
    nightly_feeds+=("$prev/nightly/$feed")
  done
  notes="A copy of the edge release (${VERSION}) for fleetd builds from before Nightly was renamed Edge: they update"
  notes+=" from here to Edge, and follow https://github.com/${GITHUB_REPOSITORY:-unlaboredlabs/fleetd}/releases/tag/edge"
  notes+=" from then on."
  rolling nightly "Nightly (now Edge)" "$notes"
  upload nightly "${nightly_feeds[@]}"
fi
