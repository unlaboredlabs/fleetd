#!/bin/sh
exec "${BUN_BIN:-bun}" "$(dirname "$0")/fake-host.ts" "$@"
