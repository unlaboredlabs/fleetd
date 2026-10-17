# shellcheck shell=bash
# Source me. Points builds and runs at the user-space sysroot made by linux-sysroot.sh.
# When the host has the -dev packages and a real Vulkan driver installed, none of this is needed.
FLEETD_SYSROOT="${FLEETD_SYSROOT:-$HOME/src/fleetd-lab/sysroot}"
_ml="$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || echo x86_64-linux-gnu)"
export PKG_CONFIG_PATH="$FLEETD_SYSROOT/usr/lib/$_ml/pkgconfig:$FLEETD_SYSROOT/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LIBRARY_PATH="$FLEETD_SYSROOT/usr/lib/$_ml${LIBRARY_PATH:+:$LIBRARY_PATH}"
export LD_LIBRARY_PATH="$FLEETD_SYSROOT/usr/lib/$_ml${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Software Vulkan (Mesa lavapipe). Set FLEETD_VK_ICD to a hardware ICD manifest (e.g. RADV) to use a GPU.
export VK_ICD_FILENAMES="${FLEETD_VK_ICD:-$FLEETD_SYSROOT/usr/share/vulkan/icd.d/lvp_icd.json}"
unset _ml
