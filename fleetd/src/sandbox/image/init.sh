#!/bin/bash
# PID 1 of a local sandbox VM (/sbin/fleetd-init in the root image). The kernel mounts the image read-only as / and
# runs this, which:
#   - puts a private, writable layer (tmpfs) over the read-only image, so a box writes anywhere and leaves nothing;
#   - mounts the host's share, virtiofs tag `view` (a dir mirroring host paths), at /run/fleetd/view and binds each of
#     its top-level dirs at the same path here, so the worktree, claude's dir and the fleetd binary sit where they do
#     on the host;
#   - sets up eth0 and DNS from the kernel's command line (passt hands out no DNS behind systemd-resolved's stub);
#   - runs `<fleetd.exe> sandbox-guest`, the node's own fleetd through the share, bridged to vsock by socat;
#   - powers the VM off when sandbox-guest ends, which ends the VMM.
# Kernel arguments it reads, each optional except fleetd.exe:
#   fleetd.exe=<host path of fleetd>  fleetd.net=<addr/prefix>,<gateway>  fleetd.dns=<ip>[,<ip>…]
#   fleetd.port=<vsock port the node dials>  fleetd.now=<host clock, Unix seconds>
# Every fleetd.<name>=<value> also reaches sandbox-guest as FLEETD_GUEST_<NAME>=<value>.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8

say() { echo "fleetd-init: $*" >/dev/console 2>/dev/null || echo "fleetd-init: $*"; }
off() {
  say "$1"
  sync
  echo 1 >/proc/sys/kernel/sysrq 2>/dev/null
  echo o >/proc/sysrq-trigger
  sleep 5
  exit 1
}

if [ "$$" = 1 ] && [ ! -d /run/fleetd/lower/sbin ]; then
  # First stage, on the read-only image: a tmpfs layer over it, then this script again as PID 1 on the new root.
  mountpoint -q /proc || mount -t proc proc /proc || off "can't mount /proc"
  mountpoint -q /dev || mount -t devtmpfs dev /dev
  mount -t tmpfs -o mode=0755 tmpfs /run || off "can't mount a tmpfs on /run"
  new=/run/fleetd/root
  mkdir -p /run/fleetd/lower /run/fleetd/rw/up /run/fleetd/rw/work "$new"
  mount --bind / /run/fleetd/lower || off "can't mount the image again"
  mount -t overlay overlay -o lowerdir=/run/fleetd/lower,upperdir=/run/fleetd/rw/up,workdir=/run/fleetd/rw/work "$new" ||
    off "can't put a writable layer over the image"
  mkdir -p "$new/run/fleetd/lower" "$new/oldroot" "$new/proc" "$new/dev"
  mount --move /run/fleetd/lower "$new/run/fleetd/lower"
  mount --move /dev "$new/dev"
  mount --move /proc "$new/proc"
  cd "$new" && pivot_root . oldroot || off "can't switch to the writable root"
  exec chroot . /sbin/fleetd-init "$@"
fi

# Second stage, on the writable root.
umount -l /oldroot 2>/dev/null && rmdir /oldroot
mountpoint -q /proc || mount -t proc proc /proc
mount -t sysfs sys /sys
mountpoint -q /dev || mount -t devtmpfs dev /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts -o gid=5,mode=0620,ptmxmode=0666 devpts /dev/pts
mount -t tmpfs -o mode=1777 tmpfs /dev/shm
mount -t tmpfs -o mode=1777 tmpfs /tmp
mkdir -p /run/fleetd /run/lock
hostname "$(cat /etc/hostname 2>/dev/null || echo fleetd-box)"

# fleetd.<name>=<value> from the kernel's command line.
declare -A arg
for word in $(cat /proc/cmdline); do
  case $word in fleetd.*=*) name=${word%%=*}; arg[${name#fleetd.}]=${word#*=} ;; esac
done

# A VM without a clock source for the date starts in 1970, and TLS refuses every certificate then.
[ -z "${arg[now]}" ] || date -s "@${arg[now]}" >/dev/null || say "clock not set from fleetd.now=${arg[now]}"
ip link set lo up
if [ -n "${arg[net]}" ]; then
  IFS=, read -r addr gw <<<"${arg[net]}"
  ip link set eth0 up && ip addr add "$addr" dev eth0 && { [ -z "$gw" ] || ip route add default via "$gw"; } ||
    say "eth0 not set up from fleetd.net=${arg[net]}"
fi
rm -f /etc/resolv.conf
for ns in ${arg[dns]//,/ }; do echo "nameserver $ns"; done >/etc/resolv.conf
# A machine id of its own, as systemd gives a first boot: the image's is empty, and what fingerprints a machine reads it.
tr -d - </proc/sys/kernel/random/uuid >/etc/machine-id

view=/run/fleetd/view
if mkdir -p "$view" && mount -t virtiofs view "$view" 2>/dev/null; then
  for dir in "$view"/*/; do
    dir=${dir%/}
    [ -d "$dir" ] || continue
    at=/${dir##*/}
    mkdir -p "$at" && mount --rbind "$dir" "$at" || say "can't put $dir at $at"
  done
else
  say "no virtiofs share \`view\`"
fi

exe=${arg[exe]}
[ -n "$exe" ] && [ -x "$exe" ] || off "fleetd.exe=${exe:-(none)} isn't a program here: nothing to run"

env=(PATH="$PATH" HOME=/root LANG=C.UTF-8)
while IFS= read -r line; do
  case $line in [A-Za-z_]*=*) env+=("$line") ;; esac
done </etc/fleetd/guest.env
for name in "${!arg[@]}"; do
  key=${name^^}
  env+=("FLEETD_GUEST_${key//[^A-Z0-9]/_}=${arg[$name]}")
done

link=/run/fleetd/link.sock
if [ -n "${arg[port]}" ]; then
  socat "VSOCK-LISTEN:${arg[port]},reuseaddr,fork" "UNIX-CONNECT:$link" </dev/null >/dev/console 2>&1 &
fi
cd /
env -i "${env[@]}" tini -s -g -- "$exe" sandbox-guest --listen "$link" --dir /run/fleetd/guest </dev/null >/dev/console 2>&1
off "sandbox-guest ended ($?): powering off"
