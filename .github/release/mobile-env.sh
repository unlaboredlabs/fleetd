#!/usr/bin/env bash
# The phone app's build settings from repository variables, for mobile-release.yml's builds and build-release.yml's
# over-the-air update job alike. The runtime version, the native fingerprint (app/mobile/app.config.ts), takes them
# in, so a build gets only the updates made with the same ones: files go in app/mobile, at the same relative path on
# every runner. Then it resolves each platform's runtime version into RUNTIME_IOS / RUNTIME_ANDROID and the job's
# summary, where a build's and the update job's can be compared.
#
# Run from app/mobile after npm ci: mobile-env.sh <platform>... Env (each optional): UPDATES_CERT_PEM, the update
# certificate; GOOGLE_SERVICES_JSON, the Firebase project's google-services.json, for FCM on Android (the Android
# fingerprint hashes its contents).
#
# mobile-env.sh check <fingerprint file> <runtime version>: fails when the runtime version a native build embedded
# (the `fingerprint` resource expo-updates writes into the app while it builds) isn't the one given, which is what
# the update job resolves on Linux for the same commit. Its updates would then never reach that build.
set -euo pipefail
if [ "${1:-}" = check ]; then
  built="$(cat "$2" 2>/dev/null || true)"
  if [ "$built" != "$3" ]; then
    echo "::error::The build embeds runtime version ${built:-(none)}, but the update job resolves $3 for this commit: no published update would reach it. Something in the build's settings or runner changes the fingerprint (compare the fingerprint sources of npx expo-updates runtimeversion:resolve --debug on each)."
    exit 1
  fi
  echo "runtime version $built, as the update job resolves it"
  exit 0
fi
if [ -n "${UPDATES_CERT_PEM:-}" ]; then
  printf '%s\n' "$UPDATES_CERT_PEM" > updates-cert.pem
  export FLEETD_UPDATES_CERT="$PWD/updates-cert.pem"
  echo "FLEETD_UPDATES_CERT=$FLEETD_UPDATES_CERT" >> "$GITHUB_ENV"
fi
if [ -n "${GOOGLE_SERVICES_JSON:-}" ]; then
  printf '%s\n' "$GOOGLE_SERVICES_JSON" > google-services.json
  export FLEETD_GOOGLE_SERVICES_FILE="$PWD/google-services.json"
  echo "FLEETD_GOOGLE_SERVICES_FILE=$FLEETD_GOOGLE_SERVICES_FILE" >> "$GITHUB_ENV"
elif [[ " $* " == *" android "* ]]; then
  echo "::warning::No GOOGLE_SERVICES_JSON variable: the Android app gets no notifications."
fi
for platform in "$@"; do
  runtime="$(npx expo-updates runtimeversion:resolve --platform "$platform" | jq -r .runtimeVersion)"
  # macOS runners' bash 3.2 has no ${platform^^}.
  echo "RUNTIME_$(printf %s "$platform" | tr '[:lower:]' '[:upper:]')=$runtime" >> "$GITHUB_ENV"
  echo "$platform runtime version: \`$runtime\`" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
done
