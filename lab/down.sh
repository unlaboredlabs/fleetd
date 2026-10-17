#!/usr/bin/env bash
# Stop lab instances by their recorded PIDs only.
set -euo pipefail
exec node "$(dirname "$0")/lab.mjs" down "$@"
