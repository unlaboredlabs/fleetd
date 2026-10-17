#!/usr/bin/env bash
# Publishes the assets in dist/ to a GitHub release: the rolling `nightly` prerelease (CHANNEL=nightly) or the
# release of the pushed v* tag (CHANNEL=stable).
#
# Next to the assets it uploads SHA256SUMS (plain `sha256sum` output, one line per asset) and release.json
# ({channel, version, commit, date, cliVersion, appVersion, appCommit}), which `fleetd update`, the app's update
# notice and the next nightly's "did the app change" check read. A nightly that skipped the app (unchanged) or the
# CLI keeps the previous run's assets, checksums and versions for it. Both files go up last, so a reader never sees
# checksums for assets that are not there yet.
#
# Env: CHANNEL, VERSION, APP_BUILT, CLI_PUBLISH, GH_TOKEN, GITHUB_SHA, GITHUB_REF_NAME.
set -euo pipefail
: "${CHANNEL:?}" "${VERSION:?}" "${APP_BUILT:?}" "${CLI_PUBLISH:?}" "${GITHUB_SHA:?}"
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

if [ "$CHANNEL" = nightly ]; then tag=nightly; else tag="${GITHUB_REF_NAME:?}"; fi

prev="$(mktemp -d)"
if [ "$CHANNEL" = nightly ]; then
  gh release download nightly -p SHA256SUMS -p release.json -D "$prev" 2>/dev/null || echo "no previous nightly"
fi
[ -s "$prev/release.json" ] || echo '{}' > "$prev/release.json"
touch "$prev/SHA256SUMS"

sha256sum "${assets[@]}" > "$prev/built"
awk 'NR == FNR { built[$2] = 1; next } !($2 in built)' "$prev/built" "$prev/SHA256SUMS" | cat "$prev/built" - | sort -k2 > SHA256SUMS

jq -n --arg channel "$CHANNEL" --arg version "$VERSION" --arg commit "$GITHUB_SHA" --arg date "$(date -u +%FT%TZ)" \
  --arg cli "$cli_built" --arg app "$APP_BUILT" --slurpfile prev "$prev/release.json" '
  $prev[0] as $p | {
    channel: $channel, version: $version, commit: $commit, date: $date,
    cliVersion: (if $cli == "true" then $version else $p.cliVersion end),
    appVersion: (if $app == "true" then $version else $p.appVersion end),
    appCommit: (if $app == "true" then $commit else $p.appCommit end)
  }' > release.json
cat SHA256SUMS release.json

if [ "$CHANNEL" = nightly ]; then
  notes="Rolling build of main at ${GITHUB_SHA} (${VERSION}). Install: curl -fsSL https://fleetd.sh | sh"
  git push -f origin "${GITHUB_SHA}:refs/tags/nightly"
  if gh release view nightly >/dev/null 2>&1; then
    gh release edit nightly --prerelease --title "Nightly" --notes "$notes"
  else
    gh release create nightly --prerelease --latest=false --title "Nightly" --notes "$notes"
  fi
else
  gh release view "$tag" >/dev/null 2>&1 || gh release create "$tag" --verify-tag --title "fleetd $VERSION" --generate-notes
fi
gh release upload "$tag" "${assets[@]}" --clobber
gh release upload "$tag" SHA256SUMS release.json --clobber
echo "published https://github.com/${GITHUB_REPOSITORY:-unlaboredlabs/fleetd}/releases/tag/$tag"
