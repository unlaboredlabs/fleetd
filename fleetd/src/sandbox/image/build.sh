#!/usr/bin/env bash
# Builds what recipe.ts pins, into <out dir>: the root image of a local sandbox VM and the two tools no upstream ships a
# static build of, with their SHA256SUMS. Runs in CI (.github/workflows/vm-image.yml) on an x86_64 Ubuntu runner, with
# docker and sudo: the image's files must be owned by root inside it, which takes root to lay out. A node never runs
# this; it downloads the release.
#   virtiofsd  static (musl), built from its pinned commit in an Alpine container
#   passt      static, built from its pinned commit (`make static`)
#   root       the Dockerfile's image, flattened into a read-only ext4 with init.sh as /sbin/fleetd-init, shrunk to fit
#              and compressed with zstd
# Usage: build.sh <out dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(mkdir -p "$1" && cd "$1" && pwd)
work=$(mktemp -d "${RUNNER_TEMP:-$out}/vm-build.XXXXXX")
trap 'sudo rm -rf "$work"' EXIT
recipe=$(bun "$here/recipe.ts")
pin() { jq -r "$1" <<<"$recipe"; }

# virtiofsd: a static musl build, so it runs on any distro.
src=$work/virtiofsd
git clone -q "$(pin .sources.virtiofsd.repo)" "$src"
git -C "$src" checkout -q --detach "$(pin .sources.virtiofsd.commit)"
docker run --rm -v "$src:/src" -w /src \
  alpine@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f sh -euc '
    apk add -q cargo rust musl-dev libcap-ng-dev libcap-ng-static libseccomp-dev libseccomp-static
    # With --target, RUSTFLAGS reach only the binary: proc-macros stay dynamic, as they must.
    RUSTFLAGS="-C target-feature=+crt-static" cargo build -q --release --locked --target x86_64-alpine-linux-musl
    chown -R '"$(id -u):$(id -g)"' target'
install -m 0755 "$src/target/x86_64-alpine-linux-musl/release/virtiofsd" "$out/$(pin .assets.virtiofsd)"

# passt: its own static target.
src=$work/passt
git clone -q "$(pin .sources.passt.repo)" "$src"
git -C "$src" checkout -q --detach "$(pin .sources.passt.commit)"
make -s -C "$src" static
install -m 0755 "$src/passt" "$out/$(pin .assets.passt)"

# The root: the Dockerfile's image as a directory owned by root, then an ext4 holding exactly it.
docker build -q -t fleetd-box -f "$here/Dockerfile" "$(mktemp -d "$work/ctx.XXXXXX")" >/dev/null
box=$(docker create fleetd-box /bin/true)
root=$work/root
sudo mkdir "$root"
docker export "$box" | sudo tar -x -C "$root"
docker rm -f "$box" >/dev/null
sudo install -m 0755 -o 0 -g 0 "$here/init.sh" "$root/sbin/fleetd-init"
# What docker leaves empty or bind-mounts at run time, and the two device nodes the kernel opens before the init.
printf 'fleetd-box\n' | sudo tee "$root/etc/hostname" >/dev/null
printf '127.0.0.1 localhost fleetd-box\n::1 localhost ip6-localhost\n' | sudo tee "$root/etc/hosts" >/dev/null
sudo rm -f "$root/etc/resolv.conf" "$root/.dockerenv"
sudo rm -rf "$root/dev" && sudo mkdir -m 0755 "$root/dev"
sudo mknod -m 0600 "$root/dev/console" c 5 1
sudo mknod -m 0666 "$root/dev/null" c 1 3
img=$work/root.ext4
mb=$(sudo du -sm "$root" | cut -f1)
truncate -s "$((mb * 125 / 100 + 256))M" "$img"
sudo mkfs.ext4 -q -F -L fleetd-root -O ^has_journal -m 0 -d "$root" "$img"
sudo e2fsck -fy "$img" >/dev/null || [ $? -le 1 ]
sudo resize2fs -M "$img" >/dev/null 2>&1
sudo chown "$(id -u):$(id -g)" "$img"
echo "root image: $(du -m --apparent-size "$img" | cut -f1) MB ($mb MB of files)"
zstd -q -19 -T0 -f "$img" -o "$out/$(pin .assets.root)"

cd "$out"
sha256sum "$(pin .assets.root)" "$(pin .assets.virtiofsd)" "$(pin .assets.passt)" >"$(pin .assets.sums)"
cat "$(pin .assets.sums)"
