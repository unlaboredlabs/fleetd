#!/bin/sh
# Runs its command in one of the machine's heavy-run slots where fleetd's `fleetd-heavy` is on PATH (an agent's machine),
# unless it already holds one (FLEETD_HEAVY_SLOT: inside scripts/check.sh), else as is. The QA screens start an
# Electron app per worker, so even a run filtered to a few screens is heavy: on Nov 26 one started outside a slot kept
# 7 of the devbox's cores and 32 runnable threads busy, a third of its load.
if [ -z "${FLEETD_HEAVY_SLOT:-}${FLEETD_CHECK_SLOT:-}" ] && heavy=$(command -v fleetd-heavy || command -v fleetd-check-slot); then
  exec "$heavy" "$@"
fi
exec "$@"
