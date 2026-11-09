#!/bin/bash
# fleetd: make this VM one of the hub's cloud machines (setup.ts renders it for each slot).
# boat.dev runs it once, as `user` with sudo, after the VM is ready. What the steps print goes to $LOG; a step that fails
# exits with one line on stderr naming it and its last line, which boat shows as the sandbox's setupError. Safe to run
# again.
set -euo pipefail

HUB=@HUB@
MACHINE=@MACHINE@
CHANNEL=@CHANNEL@
BASE_URL=@BASE_URL@
CLAUDE=@CLAUDE@
IDENTITY=@IDENTITY@
TOKEN_FILE=@TOKEN_FILE@
AGENT=@AGENT@
WARM_BUILDS=@WARM_BUILDS@
GH_VERSION=@GH_VERSION@
GH_SHA256=@GH_SHA256@
SCCACHE_VERSION=@SCCACHE_VERSION@
SCCACHE_SHA256=@SCCACHE_SHA256@

# boat keeps the tail of stderr as the setupError, so the steps' own output (rustup's warnings among it) stays out of it.
LOG=$HOME/fleetd-setup.log
: >"$LOG"
chmod 600 "$LOG"
exec 3>&1 4>&2 >>"$LOG" 2>&1
STEP=start
step() {
  STEP=$1
  echo "fleetd cloud setup: $1"
  echo "fleetd cloud setup: $1" >&3
}
# What failed: the last line the failing step printed, if it printed one.
failed() {
  local code=$? last
  [ "$code" = 0 ] && return
  last=$(awk -v m="fleetd cloud setup: $STEP" '$0 == m { l = ""; next } NF { l = $0 } END { print l }' "$LOG")
  echo "fleetd cloud setup failed at: $STEP${last:+: $last}" >&4
}
trap failed EXIT
# A command as the agents' user, with its own tools first on the PATH, which the node's unit keeps. Rust lives in its
# home too: boat's /etc/environment points RUSTUP_HOME at /usr/local/rustup, which the agents' user can't write.
as_agent() {
  sudo -u "$AGENT" -H env XDG_RUNTIME_DIR="/run/user/$AGENT_UID" \
    bash -c "cd ~ && export RUSTUP_HOME=\$HOME/.rustup CARGO_HOME=\$HOME/.cargo \
      PATH=\$HOME/.local/bin:\$HOME/.cargo/bin:\$PATH && $1"
}

step "the enroll token"
# Written by the hub under /tmp, which boat never snapshots; read once and deleted.
[ -s "$TOKEN_FILE" ] || { echo "no enroll token in $TOKEN_FILE"; exit 1; }
CODE=$(cat "$TOKEN_FILE")

step "a fresh machine id"
# A VM copied from boat's image may share its machine id with every other copy, and the hub enrolls one computer per id.
# boat gives the VM a new one at every wake as well; only an enroll compares it, never a hello.
sudo rm -f /etc/machine-id /var/lib/dbus/machine-id
sudo systemd-machine-id-setup >/dev/null

step "the agents' user"
# The agents run as a user of their own with no sudo: root on the VM stays out of their reach.
id "$AGENT" >/dev/null 2>&1 || sudo useradd -m -s /bin/bash "$AGENT"
sudo gpasswd -d "$AGENT" sudo >/dev/null 2>&1 || true
# Lingering starts the node's user unit at boot. boat boots a wake from its base image before it attaches this disk, so
# logind never sees the linger set here: a system unit, which boat starts at every wake, sets it again.
sudo tee /etc/systemd/system/fleetd-linger.service >/dev/null <<EOF
[Unit]
Description=fleetd: start the node of the agents' user at every wake
After=systemd-logind.service

[Service]
Type=oneshot
ExecStart=/usr/bin/loginctl enable-linger $AGENT

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now fleetd-linger.service
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
# fleetd runs the one it was tested with, in the agents' home: the node's PATH puts it before boat's own in /usr/local,
# which floats and comes back at every wake.
as_agent "curl -fsSL https://claude.ai/install.sh | bash -s $CLAUDE >/dev/null"
as_agent "\$HOME/.local/bin/claude --version >/dev/null"

step "Rust"
# The toolchain lives in the agents' home, so boat's base image moving doesn't make every build cold; a repo's own
# rust-toolchain.toml picks its version. boat's image ships a Rust of its own on the PATH, which rustup-init refuses
# to install beside unless told to: ours comes first on the node's PATH, so the image's is left as it is.
as_agent "command -v ~/.cargo/bin/rustup >/dev/null || curl -fsSL https://sh.rustup.rs \
  | RUSTUP_INIT_SKIP_PATH_CHECK=yes sh -s -- -y --no-modify-path --profile minimal >/dev/null"
as_agent "rustup default stable >/dev/null 2>&1 && [ \"\$(rustup show home)\" = \"\$HOME/.rustup\" ]"

step "the node's environment"
# Kept on the disk, so builds stay warm across sleeps. git asks `gh` for GitHub's credentials, which it answers from the
# order's GH_TOKEN: nobody logs in on the machine, so `gh auth setup-git` (which wants a login) is not run.
as_agent "mkdir -p ~/fleetd-cache/sccache ~/.config/systemd/user/fleetd-node.service.d"
as_agent "printf '%s\n' '[Service]' 'Environment=RUSTC_WRAPPER=/usr/local/bin/sccache' \
  'Environment=SCCACHE_DIR=%h/fleetd-cache/sccache' 'Environment=SCCACHE_CACHE_SIZE=15G' \
  'Environment=RUSTUP_HOME=%h/.rustup' 'Environment=CARGO_HOME=%h/.cargo' \
  'Environment=DISABLE_AUTOUPDATER=1' > ~/.config/systemd/user/fleetd-node.service.d/cloud.conf"
as_agent "git config --global --replace-all credential.https://github.com.helper '' \
  && git config --global --add credential.https://github.com.helper '!gh auth git-credential'"

step "the hub's tunnel"
# The hub dials this machine over SSH and forwards $HUB on its loopback to itself, so the hub needs no public address.
# boat's sshd never checks that a client is still there (ClientAliveInterval 0): after an unclean drop of the hub's
# network its old session would hold the tunnel's port for hours, refusing every redial's forward. A system unit, which
# boat starts at every wake (sshd's config comes from boat's image each time), has sshd drop a client silent for 45 s;
# its drop-in sorts before boat's own, so it is the value sshd takes. An open sshd session keeps the config it began
# with, and a wake's sshd runs from before the resume, so the hub's first tunnel is usually open before this unit runs:
# the unit then ends the sessions of boat's `user` (the hub's tunnel logs in as it), and the hub redials within a
# second into the new config.
sudo tee /etc/systemd/system/fleetd-sshd-alive.service >/dev/null <<'EOF'
[Unit]
Description=fleetd: sshd drops a silent client, so the hub's tunnel port frees after an unclean drop
After=ssh.service

[Service]
Type=oneshot
# $$ is systemd's escape for the shell's own $.
ExecStart=/bin/sh -c 'f=/etc/ssh/sshd_config.d/00-00-fleetd-client-alive.conf; echo ClientAliveInterval 15 > $$f; echo ClientAliveCountMax 3 >> $$f'
ExecStart=-/usr/bin/systemctl try-reload-or-restart ssh.service
ExecStart=-/usr/bin/pkill -u user -x 'sshd|sshd-session'

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now fleetd-sshd-alive.service
# The hub opens the tunnel as soon as boat.dev says the machine runs; wait for it (the hub stops a machine that never
# joins).
for _ in $(seq 1 300); do
  curl -fsS -o /dev/null --max-time 5 "$HUB/healthz" && break
  sleep 2
done
curl -fsS -o /dev/null --max-time 5 "$HUB/healthz"

step "fleetd"
join=(--no-app --join "$HUB" --code "$CODE" --machine-id "$MACHINE")
[ -z "$IDENTITY" ] || join+=(--git-identity "$IDENTITY")
args=$(printf '%q ' "${join[@]}")
# FLEETD_FLAVOUR=bun for an installer from before Rust's removal, which installed the Rust build by default.
env_line="FLEETD_CHANNEL=$CHANNEL FLEETD_FLAVOUR=bun"
[ -z "$BASE_URL" ] || env_line="$env_line FLEETD_BASE_URL=$BASE_URL"
# init ends 1 on claude not logged in, which a new cloud machine's never is: the hub brings it its Claude configuration
# once its node links (hub/cloud's catch-up). So a join that enrolled passes, and one that didn't fails here with
# init's own last line. Failing here left boat-1 without its node's settings, and the pool deleted it (Nov 8 and 9).
as_agent "curl -fsSL https://fleetd.sh | $env_line sh -s -- $args" ||
  as_agent "grep -qs '\"enrolled\": *true' ~/.fleetd/node/node.json"
sudo rm -f "$TOKEN_FILE"
unset CODE

step "the node's settings"
# A cloud machine's disk sized for builds (the hub sizes its cap), and desktops in Xvfb with no Docker image to build.
as_agent "f=~/.fleetd/node/node.json && jq --argjson warm $WARM_BUILDS \
  '. + {warmBuilds: \$warm, desktop: ((.desktop // {}) + {backend: \"xvfb\"})}' \"\$f\" > \"\$f.new\" \
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
