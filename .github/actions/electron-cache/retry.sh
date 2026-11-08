#!/usr/bin/env bash
# Runs a command that may download Electron's zips or electron-builder's tools from GitHub's release downloads, and runs
# it again (up to 3 tries, 30 s then 60 s apart) only when it failed on the download: on Nov 8 those answered 504 for
# about 3 h, and a cold cache (action.yml) can't help a job that never passes to save one. Any other failure fails at
# once. What a try fetched stays in the cache dirs, so the next one downloads only the rest.
set -uo pipefail
log=$(mktemp)
trap 'rm -f "$log"' EXIT
for try in 1 2 3; do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  if [ "$try" -eq 3 ] || ! grep -qE 'Response code 5[0-9]{2}|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed' "$log"; then
    exit "$status"
  fi
  echo "::warning::Download failed (try $try of 3), retrying in $((try * 30)) s"
  sleep $((try * 30))
done
