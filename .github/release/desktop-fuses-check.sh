#!/usr/bin/env bash
# Requires the packed desktop app's Electron fuses as app/desktop/electron-builder.yml sets them (every architecture
# of a universal app), then checks the one that matters most at runtime: with ELECTRON_RUN_AS_NODE=1 the signed app
# must not run a script as plain Node, or anything running as the user could borrow its keychain trust. Without a
# command it only reads the fuses: ci.yml's mac layout check, on Linux, can't launch the mac app.
#
#   desktop-fuses-check.sh <app (.app or the Linux binary)> [<command> [args...]]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
shift
fuses="$(cd "$here/../../app/desktop" && pnpm exec electron-fuses read --app "$app")"
echo "$fuses"
for wrong in "RunAsNode is Enabled" "EnableNodeOptionsEnvironmentVariable is Enabled" \
  "EnableNodeCliInspectArguments is Enabled" "EnableEmbeddedAsarIntegrityValidation is Disabled" \
  "OnlyLoadAppFromAsar is Disabled" "EnableCookieEncryption is Disabled" "GrantFileProtocolExtraPrivileges is Enabled"; do
  if grep -q "$wrong" <<< "$fuses"; then echo "::error::$wrong"; exit 1; fi
done
grep -q "RunAsNode is Disabled" <<< "$fuses" || { echo "::error::no fuses found"; exit 1; }
[ "$#" -gt 0 ] || exit 0

log="$(mktemp)"
set -m
ELECTRON_RUN_AS_NODE=1 "$@" -e 'console.log("RUN_AS_NODE_WORKS")' > "$log" 2>&1 &
pid=$!
set +m
# With the fuse off the variable is ignored and the app starts as itself; give a Node script ample time to print.
sleep 8
kill -KILL -- "-$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
if grep -q RUN_AS_NODE_WORKS "$log"; then
  echo "::error::ELECTRON_RUN_AS_NODE still runs scripts in the packed app"
  exit 1
fi
echo "ELECTRON_RUN_AS_NODE=1 runs no script"
