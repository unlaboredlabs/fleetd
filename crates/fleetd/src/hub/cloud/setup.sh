#!/bin/bash
# fleetd: make this VM one of the hub's cloud machines (crates/fleetd/src/hub/cloud/setup.rs renders it for each slot).
# boat.dev runs it once, as `user` with sudo, after the VM is ready. Every step that fails exits with one line naming it,
# which boat shows as the sandbox's setupError. Safe to run again.
set -euo pipefail

HUB=@HUB@
MACHINE=@MACHINE@
CHANNEL=@CHANNEL@
BASE_URL=@BASE_URL@
CLAUDE=@CLAUDE@
IDENTITY=@IDENTITY@
TOKEN_FILE=@TOKEN_FILE@
AGENT=@AGENT@
MEM_PER_AGENT_GB=@MEM_PER_AGENT_GB@
WARM_BUILDS=@WARM_BUILDS@
GH_VERSION=@GH_VERSION@
GH_SHA256=@GH_SHA256@
SCCACHE_VERSION=@SCCACHE_VERSION@
SCCACHE_SHA256=@SCCACHE_SHA256@

STEP=start
trap 'echo "fleetd cloud setup failed at: $STEP" >&2' ERR
step() {
  STEP=$1
  echo "fleetd cloud setup: $1"
}
# A command as the agents' user, with its own tools first on the PATH, which the node's unit keeps.
as_agent() {
  sudo -u "$AGENT" -H env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
    bash -c "cd ~ && export PATH=\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH && $1"
}

step "the enroll token"
# Written by the hub under /tmp, which boat never snapshots; read once and deleted.
[ -s "$TOKEN_FILE" ] || { echo "fleetd cloud setup failed at: no enroll token in $TOKEN_FILE" >&2; exit 1; }
CODE=$(cat "$TOKEN_FILE")

step "a fresh machine id"
# A VM copied from boat's image may share its machine id with every other copy, and the hub enrolls one computer per id.
sudo rm -f /etc/machine-id /var/lib/dbus/machine-id
sudo systemd-machine-id-setup >/dev/null

step "the agents' user"
# The agents run as a user of their own with no sudo: root on the VM stays out of their reach.
id "$AGENT" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$AGENT"
sudo gpasswd -d "$AGENT" sudo >/dev/null 2>&1 || true
sudo loginctl enable-linger "$AGENT"
AGENT_UID=$(id -u "$AGENT")
for _ in $(seq 1 60); do
  [ -S "/run/user/$AGENT_UID/bus" ] && break
  sleep 1
done
[ -S "/run/user/$AGENT_UID/bus" ]

step "packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb jq git curl ca-certificates >/dev/null

step "gh $GH_VERSION"
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/gh.tgz" "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_amd64.tar.gz"
echo "$GH_SHA256  $tmp/gh.tgz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/gh.tgz" -C "$tmp"
sudo install -m 0755 "$tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh

step "sccache $SCCACHE_VERSION"
curl -fsSL -o "$tmp/sccache.tgz" "https://github.com/mozilla/sccache/releases/download/v$SCCACHE_VERSION/sccache-v$SCCACHE_VERSION-x86_64-unknown-linux-musl.tar.gz"
echo "$SCCACHE_SHA256  $tmp/sccache.tgz" | sha256sum -c - >/dev/null
tar -xzf "$tmp/sccache.tgz" -C "$tmp"
sudo install -m 0755 "$tmp/sccache-v$SCCACHE_VERSION-x86_64-unknown-linux-musl/sccache" /usr/local/bin/sccache
rm -rf "$tmp"

step "Claude Code $CLAUDE"
# boat's own claude in /usr/local is updated whenever boat prepares a machine and would come first on the PATH: fleetd
# runs the one it was tested with, in the agents' home.
for c in $(command -v -a claude 2>/dev/null || true); do
  case "$c" in /home/*) ;; *) sudo rm -f "$c" ;; esac
done
as_agent "curl -fsSL https://claude.ai/install.sh | bash -s $CLAUDE >/dev/null"
as_agent "\$HOME/.local/bin/claude --version >/dev/null"

step "Rust"
# The toolchain lives in the agents' home, so boat's base image moving doesn't make every build cold; a repo's own
# rust-toolchain.toml picks its version.
as_agent "command -v ~/.cargo/bin/rustup >/dev/null || curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal >/dev/null"

step "the node's environment"
# Kept on the disk, so builds stay warm across sleeps; `gh` pushes with the order's GH_TOKEN.
as_agent "mkdir -p ~/fleetd-cache/sccache ~/.config/systemd/user/fleetd-node.service.d"
as_agent "printf '%s\n' '[Service]' 'Environment=RUSTC_WRAPPER=/usr/local/bin/sccache' \
  'Environment=SCCACHE_DIR=%h/fleetd-cache/sccache' 'Environment=SCCACHE_CACHE_SIZE=15G' \
  'Environment=DISABLE_AUTOUPDATER=1' > ~/.config/systemd/user/fleetd-node.service.d/cloud.conf"
as_agent "gh auth setup-git"

step "fleetd"
join=(--no-app --join "$HUB" --code "$CODE" --machine-id "$MACHINE")
[ -z "$IDENTITY" ] || join+=(--git-identity "$IDENTITY")
args=$(printf '%q ' "${join[@]}")
env_line="FLEETD_CHANNEL=$CHANNEL"
[ -z "$BASE_URL" ] || env_line="$env_line FLEETD_BASE_URL=$BASE_URL"
as_agent "curl -fsSL https://fleetd.sh | $env_line sh -s -- $args"
sudo rm -f "$TOKEN_FILE"
unset CODE

step "the node's settings"
# A cloud machine's cap and disk sized for builds, and desktops in Xvfb with no Docker image to build.
as_agent "f=~/.fleetd/node/node.json && jq --argjson mem $MEM_PER_AGENT_GB --argjson warm $WARM_BUILDS \
  '. + {memPerAgentGb: \$mem, warmBuilds: \$warm, desktop: ((.desktop // {}) + {backend: \"xvfb\"})}' \"\$f\" > \"\$f.new\" \
  && chmod 600 \"\$f.new\" && mv \"\$f.new\" \"\$f\""
as_agent "systemctl --user restart fleetd-node.service"

step "the pre-stop hook"
# boat runs ~/.boat/pre-stop (60 s) before it stops the VM: the node holds its agents between steps and sends what waits.
mkdir -p ~/.boat
cat > ~/.boat/pre-stop <<EOF
#!/bin/sh
exec sudo -u $AGENT -H env XDG_RUNTIME_DIR=/run/user/$AGENT_UID /home/$AGENT/.fleetd/bin/fleetd node flush --wait 50
EOF
chmod 0755 ~/.boat/pre-stop

step "done"
