#!/usr/bin/env bash
# Signs the phone app's over-the-air updates (D219), for mobile-release.yml (edge, after a merge whose native
# fingerprint the newest TestFlight build has, D800) and build-release.yml (stable, each tagged release).
#
#   mobile-update.sh sign <export dir> <channel> <tarball>
#
# From the repo's root, with Node alone (no npm install, so the key is never near npm's packages). <export dir> is an
# export job's: `expo export`'s dist/, the public config (expo-config.json) and each platform's runtime version
# (runtimes, ios=… and android=… lines). The manifests are signed by app/mobile/scripts/updates.ts, which refuses a
# bundle that isn't Hermes bytecode. Reads UPDATES_PRIVATE_KEY_PEM, UPDATES_CERT_PEM and FLEETD_UPDATES_URL. The
# tarball's updates.txt names each manifest and the certificate, so a release that holds the same can skip it.
set -euo pipefail

case "${1:-}" in
sign)
  export="${2:?}"
  channel="${3:?}"
  tarball="${4:?}"
  key="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/updates-key.pem"
  out="$(mktemp -d)"
  (umask 077 && printf '%s\n' "${UPDATES_PRIVATE_KEY_PEM:?}" > "$key")
  trap 'rm -f "$key"; rm -rf "$out"' EXIT
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON app/mobile/scripts/updates.ts --dist "$export/dist" \
    --out "$out" --url "${FLEETD_UPDATES_URL:-https://fleetd.sh/updates}" --channel "$channel" \
    --key "$key" --config "$export/expo-config.json" \
    --runtime "$(grep '^ios=' "$export/runtimes")" --runtime "$(grep '^android=' "$export/runtimes")"
  # The same updates signed with another certificate's key are new ones too.
  echo "cert $(printf '%s\n' "${UPDATES_CERT_PEM:?}" | sha256sum | cut -d' ' -f1)" >> "$out/updates.txt"
  tar -czf "$tarball" -C "$out" .
  ;;
*)
  echo "usage: mobile-update.sh sign <export dir> <channel> <tarball>" >&2
  exit 2
  ;;
esac
