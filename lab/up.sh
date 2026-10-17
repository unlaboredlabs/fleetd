#!/usr/bin/env bash
# Start the disposable stock-T3 lab (lab-a :4711, lab-b :4712). See lab.mjs.
set -euo pipefail
exec node "$(dirname "$0")/lab.mjs" up "$@"
