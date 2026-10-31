#!/bin/sh
# The phone app's over-the-air updates (D219) in the Vercel build of site/ (vercel.json). Each release
# (build-release.yml) puts its channel's signed manifests and bundles on its GitHub release as mobile-updates.tar.gz:
# edge's on the rolling edge prerelease, stable's on the latest release.
#
#   fetch      unpacks each channel's into updates/<channel>/, where vercel.json's /updates rewrite finds the
#              manifests, and its sha256 into updates/<channel>.sha256. A channel without one is left out, and the app
#              keeps the bundle it has. Never fails the build.
#   unchanged  the Ignored Build Step: exits 0 (skip) when site/ and the docs' sources (docs/site) didn't change and
#              production already serves each channel's current tarball. So a release's updates deploy with the next
#              build of main, or at once when the release calls the project's deploy hook (the SITE_DEPLOY_HOOK secret).
set -u
repo="${VERCEL_GIT_REPO_OWNER:-unlaboredlabs}/${VERCEL_GIT_REPO_SLUG:-fleetd}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# get <channel>: the channel's tarball into $tmp.
get() {
  case "$1" in
    edge) tag=download/edge ;;
    *) tag=latest/download ;;
  esac
  curl -fsSL --retry 2 -o "$tmp" "https://github.com/$repo/releases/$tag/mobile-updates.tar.gz" 2>/dev/null
}

case "${1:-}" in
  fetch)
    for channel in edge stable; do
      rm -rf "updates/$channel" "updates/$channel.sha256"
      if ! get "$channel"; then
        echo "mobile updates: no $channel release"
      elif mkdir -p "updates/$channel" && tar -xzf "$tmp" -C "updates/$channel" --no-same-owner; then
        sha256sum < "$tmp" | cut -d' ' -f1 > "updates/$channel.sha256"
        echo "mobile updates: $channel $(cat "updates/$channel.sha256")"
      else
        rm -rf "updates/$channel"
        echo "mobile updates: $channel didn't unpack"
      fi
    done
    exit 0
    ;;
  unchanged)
    git diff --quiet HEAD^ HEAD -- . ../docs/site || exit 1
    # Previews deploy for site/ and docs/site changes only.
    [ "${VERCEL_ENV:-}" = production ] || exit 0
    for channel in edge stable; do
      new=
      if get "$channel"; then new="$(sha256sum < "$tmp" | cut -d' ' -f1)"; fi
      held="$(curl -fsSL "https://${VERCEL_PROJECT_PRODUCTION_URL:-fleetd.sh}/updates/$channel.sha256" 2>/dev/null || true)"
      if [ "$new" != "$held" ]; then
        echo "mobile updates: $channel changed"
        exit 1
      fi
    done
    exit 0
    ;;
  *)
    echo "usage: mobile-updates.sh fetch|unchanged" >&2
    exit 2
    ;;
esac
