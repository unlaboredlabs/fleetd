#!/bin/sh
# Proves, in throwaway systemd containers, that uninstalling leaves no fleetd behind (W890): site/install.sh installs
# a fleetd build from a release directory on disk, `fleetd init --yes` sets up the hub and this machine's node (sudo
# without a password, linger off, so setup writes the root drop-in and turns linger on), an agent's session host runs
# beside it, and then `--uninstall`. Never run anything here against a live machine: every command goes into a
# container this script starts, and it removes them and its image at the end.
#
#   scripts/uninstall-check.sh <fleetd linux-x64 binary> [site/install.sh]
#
# 1. uninstall: no fleetd process, unit, drop-in or linger is left, and the agent's session is stopped.
# 2. port: something else takes the hub's port for longer than systemd's old start limit (5 starts in 300 s); once it
#    lets go, the hub is back by itself. `fleetd init` meanwhile names what holds the port.
# 3. after an older uninstall: the CLI deleted under a running node, as uninstalls before W890 left it; the installer
#    stops the node and the session host itself.
set -eu

bin=${1:?usage: scripts/uninstall-check.sh <fleetd binary> [site/install.sh]}
installer=${2:-$(dirname "$0")/../../site/install.sh}
image=fleetd-uninstall-check
work=$(mktemp -d "${TMPDIR:-/tmp}/uninstall-check.XXXXXX")
containers=""
cleanup() {
  for c in ${containers}; do docker rm -f "${c}" >/dev/null 2>&1 || true; done
  docker rmi -f "${image}" >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT INT TERM

mkdir -p "${work}/rel"
cp "${bin}" "${work}/rel/fleetd-bun-linux-x64"
(cd "${work}/rel" && sha256sum fleetd-bun-linux-x64 >SHA256SUMS)
cp "${installer}" "${work}/install.sh"
cat >"${work}/Dockerfile" <<'EOF'
FROM ubuntu:26.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd systemd-sysv dbus dbus-user-session sudo git procps curl ca-certificates socat >/dev/null && apt-get clean
RUN userdel -r ubuntu 2>/dev/null; useradd -m -u 1000 -s /bin/bash dev && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev
# A stand-in claude: setup only needs one installed.
RUN mkdir -p /home/dev/.local/bin && printf '#!/bin/sh\ncase "$1" in --version) echo "2.1.314 (Claude Code)";; esac\n' > /home/dev/.local/bin/claude && chmod 755 /home/dev/.local/bin/claude && chown -R dev:dev /home/dev
COPY rel /rel
COPY install.sh /install.sh
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
docker build -q -t "${image}" "${work}" >/dev/null

as_root() { docker exec "${c}" sh -c "$1"; }
as_user() { docker exec -u dev -w /home/dev -e HOME=/home/dev -e SHELL=/bin/bash -e XDG_RUNTIME_DIR=/run/user/1000 -e PATH=/home/dev/.local/bin:/usr/bin:/bin -e FLEETD_BASE_URL=file:///rel "${c}" sh -c "$1"; }
fail() { echo "FAIL: $1"; exit 1; }
# Everything fleetd left: its processes (the agent's stand-in claude too), units, the drop-in and linger.
leftovers() {
  as_root 'ps -eo user=,args= | grep -E "fleetd|sleep 1000" | grep -v grep || true'
  as_root 'ls /home/dev/.config/systemd/user/fleetd-* /etc/systemd/system/user@1000.service.d/fleetd.conf 2>/dev/null || true'
  as_root '[ ! -e /var/lib/systemd/linger/dev ] || echo "linger is on for dev"'
}

# A container with fleetd installed and set up by `fleetd init --yes`, and an agent's session host beside the node.
start() {
  c=fleetd-uninstall-check-$1
  containers="${containers} ${c}"
  docker run -d --name "${c}" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock "${image}" >/dev/null
  i=0; until as_root 'systemctl is-system-running --wait >/dev/null 2>&1; systemctl start user@1000.service' 2>/dev/null; do i=$((i + 1)); [ "${i}" -lt 30 ] || fail "no user manager"; sleep 1; done
  as_user 'sh /install.sh --no-app --no-init >/dev/null'
  as_user 'fleetd init --yes --git-identity "Test <t@example.com>" >/dev/null 2>&1' || true
  [ "$(as_user 'systemctl --user is-active fleetd-hub fleetd-node | tr "\n" " "')" = "active active " ] || fail "init didn't start the hub and node"
  as_root 'head -n 1 /etc/systemd/system/user@1000.service.d/fleetd.conf' | grep -qx '# fleetd turned linger on' || fail "the drop-in doesn't say fleetd turned linger on"
  # Outside the node's cgroup, as the node starts them: a session host outlives its node on purpose.
  as_user 'mkdir -p /home/dev/.fleetd/node/hosts/t1'
  docker exec -d -u dev -e HOME=/home/dev "${c}" /home/dev/.fleetd/bin/fleetd session-host /home/dev/.fleetd/node/hosts/t1 s1 -- sleep 1000
  i=0; until as_root 'pgrep -f "^sleep 1000" >/dev/null && pgrep -f "fleetd session-host" >/dev/null'; do i=$((i + 1)); [ "${i}" -lt 20 ] || fail "the session didn't start"; sleep 0.5; done
}

echo "== 1. uninstall leaves nothing running =="
start uninstall
echo "before: $(leftovers | tr '\n' ';')"
out=$(as_user 'sh /install.sh --uninstall 2>&1') || fail "the uninstall failed: ${out}"
printf '%s\n' "${out}" | sed 's/^/  | /'
sleep 2
left=$(leftovers)
[ -z "${left}" ] || fail "left behind: ${left}"
as_root '[ ! -e /home/dev/.fleetd/bin ] && [ ! -e /home/dev/.local/bin/fleetd ]' || fail "the CLI is still there"
echo "after: no fleetd process, unit, drop-in or linger, and the session is stopped"

echo "== 2. the hub's port taken past systemd's old start limit, then freed =="
start port
as_user 'systemctl --user stop fleetd-hub'
# socat, as nc (netcat-openbsd) shares the port (SO_REUSEPORT). As dev: what holds the port is named only when this user can see it.
docker exec -d -u dev "${c}" socat TCP-LISTEN:4790,bind=127.0.0.1,fork SYSTEM:true
sleep 1
as_user 'systemctl --user start fleetd-hub' || true
said=$(as_user 'fleetd init 2>&1' || true)
printf '%s\n' "${said}" | grep -F "is in use by" | sed 's/^/  | /'
printf '%s\n' "${said}" | grep -q "is in use by something else: socat (pid " || fail "init doesn't name what holds the port: ${said}"
sleep 45
restarts=$(as_user 'systemctl --user show -p NRestarts --value fleetd-hub')
[ "${restarts}" -gt 5 ] || fail "only ${restarts} restarts in 45 s"
as_root 'pkill -x socat'
t=0
until as_root 'curl -fsS -m 2 -o /dev/null http://127.0.0.1:4790/healthz' 2>/dev/null; do
  t=$((t + 1)); [ "${t}" -lt 30 ] || fail "the hub didn't come back once the port was free"; sleep 1
done
echo "after ${restarts} failed starts in 45 s, the hub answered again ${t} s after the port was freed"

echo "== 3. after an older uninstall: the CLI deleted under a running node =="
start older
as_user 'rm -rf /home/dev/.fleetd/bin /home/dev/.local/bin/fleetd'
[ "$(as_user 'systemctl --user is-active fleetd-node')" = active ] || fail "the node isn't running"
out=$(as_user 'sh /install.sh --uninstall 2>&1') || fail "the uninstall failed: ${out}"
printf '%s\n' "${out}" | sed 's/^/  | /'
sleep 2
left=$(as_root 'ps -eo args= | grep -E "fleetd|sleep 1000" | grep -v grep; ls /home/dev/.config/systemd/user/fleetd-* 2>/dev/null' || true)
[ -z "${left}" ] || fail "left running: ${left}"
echo "after: no fleetd process or unit (the root drop-in is named, with its command)"
echo "PASS"
