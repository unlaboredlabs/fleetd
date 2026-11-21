#!/bin/sh
# Proves, in throwaway systemd containers, that the hub and node come back by themselves when the user's service
# manager stops (W781): a lingering user, fleetd installed by `fleetd init --yes` as it installs itself, then a SIGTERM
# to that user's `systemd --user`, as a stray `kill` loop sent on the devbox. Never run anything here against a live
# machine: every command goes into a container this script starts, and it removes them and its image at the end.
#
#   scripts/manager-restart.sh dist/fleetd
#
# 1. sudo: the user has sudo without a password, so setup writes the drop-in itself; the services are back in seconds.
# 2. paste: no sudo. Setup notes the one command and the doctor flags it; a SIGTERM leaves everything down. Then the
#    note's exact command, run once by an admin: a SIGTERM brings them back; a hub restart, root stopping the manager
#    and a logout with linger off each still do what they did.
set -eu

bin=${1:?usage: scripts/manager-restart.sh <fleetd binary>}
image=fleetd-manager-restart
work=$(mktemp -d "${TMPDIR:-/tmp}/manager-restart.XXXXXX")
containers=""
cleanup() {
  for c in ${containers}; do docker rm -f "${c}" >/dev/null 2>&1 || true; done
  docker rmi -f "${image}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT INT TERM

cat > "${work}/Dockerfile" <<'EOF'
FROM ubuntu:26.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv dbus dbus-user-session sudo git procps curl ca-certificates >/dev/null && apt-get clean
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash wynn && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/wynn
# A stand-in claude: setup only needs one installed.
RUN mkdir -p /home/wynn/.local/bin /home/wynn/.fleetd/bin && printf '#!/bin/sh\ncase "$1" in --version) echo "2.1.314 (Claude Code)";; esac\n' > /home/wynn/.local/bin/claude && chmod 755 /home/wynn/.local/bin/claude
COPY fleetd /home/wynn/.fleetd/bin/fleetd
RUN chown -R wynn:wynn /home/wynn
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
cp "${bin}" "${work}/fleetd"
docker build -q -t "${image}" "${work}" >/dev/null

as_root() { docker exec "${c}" sh -c "$1"; }
as_user() { docker exec -u wynn -w /home/wynn -e HOME=/home/wynn -e XDG_RUNTIME_DIR=/run/user/1000 -e PATH=/home/wynn/.fleetd/bin:/home/wynn/.local/bin:/usr/bin:/bin "${c}" sh -c "$1"; }
services() { as_user 'systemctl --user is-active fleetd-hub fleetd-node 2>/dev/null | tr "\n" " "' || true; }
fail() { echo "FAIL: $1"; exit 1; }

start() {
  c=fleetd-manager-restart-$1
  containers="${containers} ${c}"
  docker run -d --name "${c}" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "${image}" >/dev/null
  i=0; until as_root 'systemctl is-active -q user@1000.service' 2>/dev/null; do i=$((i + 1)); [ "${i}" -lt 30 ] || fail "no user manager"; sleep 1; done
}

# SIGTERM the user's manager, then the seconds until both services run again; "down" when not within $1 seconds.
sigterm() {
  pid=$(as_root 'systemctl show -p MainPID --value user@1000.service')
  as_user "kill -TERM ${pid}"
  sleep 1
  t=1
  while [ "${t}" -le "$1" ]; do
    if [ "$(services)" = "active active " ] && as_root 'curl -fsS -m 2 -o /dev/null http://127.0.0.1:4790/healthz' 2>/dev/null; then echo "${t}"; return; fi
    sleep 1; t=$((t + 1))
  done
  echo down
}

echo "== 1. sudo without a password: fleetd init arranges it =="
start sudo
as_root 'echo "wynn ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/wynn'
as_user 'fleetd init --yes --git-identity "Test <t@example.com>" >/dev/null 2>&1' || true
[ "$(services)" = "active active " ] || fail "init didn't start the hub and node"
as_root 'cat /etc/systemd/system/user@1000.service.d/fleetd.conf' | grep -qx 'Restart=always' || fail "init wrote no drop-in"
! as_user 'fleetd doctor 2>&1' | grep -E "nothing starts it again|Linger is off" || fail "the doctor flags it though it's arranged"
back=$(sigterm 60); [ "${back}" != down ] || fail "not back within 60 s"
echo "after a SIGTERM to systemd --user, the hub and node answered again in ${back} s"

echo "== 2. no sudo: the note, the doctor, the outage, then the pasted command =="
start paste
out=$(as_user 'fleetd init --yes --git-identity "Test <t@example.com>" 2>&1' || true)
[ "$(services)" = "active active " ] || fail "init didn't start the hub and node"
cmd=$(printf '%s\n' "${out}" | grep -o 'sudo sh -c "loginctl enable-linger wynn[^"]*"' | head -n 1)
[ -n "${cmd}" ] || fail "init gives no command: ${out}"
printf 'init says: %s\n' "$(printf '%s\n' "${out}" | grep -m 1 'nothing starts it again')"
as_user 'fleetd doctor 2>&1' | grep -F "${cmd}" >/dev/null || fail "the doctor gives no command"
back=$(sigterm 60); [ "${back}" = down ] || fail "came back without the drop-in?"
echo "without it, a SIGTERM leaves the hub and node down for 60 s and more (user@1000: $(as_root 'systemctl is-active user@1000.service' || true))"
as_root 'systemctl start user@1000.service'
as_root 'echo "wynn ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/wynn'
as_user "${cmd}"
as_root 'rm /etc/sudoers.d/wynn'
back=$(sigterm 60); [ "${back}" != down ] || fail "not back within 60 s after the command"
echo "with it, the hub and node answered again ${back} s after the SIGTERM"
back=$(sigterm 60); [ "${back}" != down ] || fail "not back the second time"
echo "and again ${back} s after a second SIGTERM"
! as_user 'fleetd doctor 2>&1' | grep -E "nothing starts it again|Linger is off" || fail "the doctor still flags it"

m1=$(as_root 'systemctl show -p MainPID --value user@1000.service')
as_user 'systemctl --user restart fleetd-hub fleetd-node'
sleep 2
m2=$(as_root 'systemctl show -p MainPID --value user@1000.service')
{ [ "${m1}" = "${m2}" ] && [ "$(services)" = "active active " ]; } || fail "a hub restart touched the manager"
echo "a hub and node restart (fleetd update, Restart hub) leaves the manager as it is"

as_root 'systemctl stop user@1000.service'
sleep 10
[ "$(as_root 'systemctl is-active user@1000.service' || true)" = inactive ] || fail "root's stop was undone"
echo "root stopping the manager (a shutdown, an admin) still stops it"

as_root 'loginctl disable-linger wynn; systemd-run -q --uid=wynn -p PAMName=login sh -c "sleep 5"'
sleep 3
[ "$(as_root 'systemctl is-active user@1000.service' || true)" = active ] || fail "a login didn't start the manager"
sleep 25
[ "$(as_root 'systemctl is-active user@1000.service' || true)" = inactive ] || fail "the manager outlived the logout with linger off"
echo "with linger off, a logout still ends the manager (restarts: $(as_root 'systemctl show -p NRestarts --value user@1000.service'))"
echo "PASS"
