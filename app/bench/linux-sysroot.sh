#!/usr/bin/env bash
# Builds a user-space sysroot with GPUI's Linux build deps, Xvfb and Mesa lavapipe from Ubuntu debs.
# No sudo: `apt-get download` + `dpkg -x`. Packages already installed on the host are skipped, so the
# sysroot only fills the gaps. Re-running is idempotent.
#
# usage: app/bench/linux-sysroot.sh [SYSROOT]   (default: $FLEETD_SYSROOT or ~/src/fleetd-lab/sysroot)
set -euo pipefail

SYSROOT="${1:-${FLEETD_SYSROOT:-$HOME/src/fleetd-lab/sysroot}}"
DEBS="$SYSROOT.debs"
MULTIARCH="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo x86_64-linux-gnu)"

PKGS=(
  # build: headers + pkg-config for the -sys crates gpui links
  libxkbcommon-dev libxkbcommon-x11-dev libfontconfig-dev libfreetype-dev
  libwayland-dev libx11-dev libx11-xcb-dev libxcb1-dev libvulkan-dev
  # run: Vulkan loader, lavapipe, a headless X server with XTEST, xkbcomp for it, x11 tools for the bench
  libvulkan1 mesa-vulkan-drivers xvfb x11-xkb-utils x11-xserver-utils
)

mkdir -p "$SYSROOT" "$DEBS"

installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null)" = "install ok installed" ]; }

mapfile -t all < <(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
  --no-breaks --no-replaces --no-enhances "${PKGS[@]}" | grep -E '^[a-z0-9]' | sort -u)
need=()
for p in "${all[@]}"; do installed "$p" || need+=("$p"); done
echo "sysroot: ${#need[@]} packages to fetch (of ${#all[@]} in the closure)"

(cd "$DEBS" && apt-get download "${need[@]}" >/dev/null)
for deb in "$DEBS"/*.deb; do dpkg -x "$deb" "$SYSROOT"; done

# .pc files say prefix=/usr; point them into the sysroot.
for pc in "$SYSROOT"/usr/lib/"$MULTIARCH"/pkgconfig/*.pc "$SYSROOT"/usr/share/pkgconfig/*.pc; do
  if [ -f "$pc" ]; then sed -i -E "s#^([a-z_]+)=/usr#\1=$SYSROOT/usr#" "$pc"; fi
done

# -dev symlinks (libfoo.so -> libfoo.so.N) dangle when the runtime lib is a host package; repoint them.
find "$SYSROOT/usr/lib/$MULTIARCH" -xtype l | while read -r link; do
  host="/usr/lib/$MULTIARCH/$(basename "$(readlink "$link")")"
  if [ -e "$host" ]; then ln -sf "$host" "$link"; fi
done

# Xvfb runs "<XKB_BIN_DIRECTORY>/xkbcomp" with the directory compiled in as /usr/bin, and no flag or env var
# overrides it (-xkbdir only moves the data). Without sudo or user namespaces (AppArmor blocks them on Ubuntu),
# patch a copy to the same-length /tmp/xk; xvfb-start.sh puts an xkbcomp symlink there.
python3 -I - "$SYSROOT/usr/bin/Xvfb" "$SYSROOT/usr/bin/Xvfb-fleetd" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
old, new = b"\x00/usr/bin\x00", b"\x00/tmp/xk\x00\x00"
assert data.count(old) == 1, "unexpected Xvfb layout; XKB_BIN_DIRECTORY not found exactly once"
open(dst, "wb").write(data.replace(old, new))
PY
chmod +x "$SYSROOT/usr/bin/Xvfb-fleetd"

echo "sysroot ready: $SYSROOT"
