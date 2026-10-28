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
set -euo pipefail
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
