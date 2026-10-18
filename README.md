# fleetd

An open-source software factory. Send a one-line order from the desktop app or any MCP client. A lead agent for
the project turns it into a brief and runs coding agents across your machines. It asks you only about product calls,
money, credentials and irreversible steps, and reports "done" only after fleetd has checked the work itself.

## Quick start

Run steps 1 and 2 on the always-on machine that will be your hub (Linux x64, or macOS arm64 or x64). You need `git`,
plus the `claude` and `gh` CLIs logged in to your own accounts. `fleetd init` checks both, prints the install command
for anything missing and offers to log you in.

**1. Install fleetd**

```sh
curl -fsSL https://fleetd.sh | sh
```

<!-- expected-output: installer output for a headless machine, from site/install.sh (paths shortened to ~). -->
```text
fleetd: installed the CLI: ~/.fleetd/bin/fleetd

Next, run:
  fleetd init
```

It checks the binary's checksum before installing it. On a machine with a desktop it installs the app too.

**2. Set it up**

```sh
fleetd init
```

It asks a few questions (Enter takes the default) and ticks off each step. A ✗ line ends with the exact command
that fixes it. Run `fleetd init` again at any time: it keeps what works and repairs the rest.

<!-- expected-output: a real `fleetd init` run (#89), sanitized. Illustrative only, not verbatim: the first-project
     lines (the real run picked "not now") and the doctor line (the real run's one failure was a leftover that S1 removes). -->
```text
fleetd init: sets up fleetd on this machine, step by step. Enter takes the default.
✔ Is this machine the hub (the always-on machine that runs your fleet)? · yes
✓ reachability: the hub listens on 100.x.y.z:4790, reached at http://hub.your-tailnet.ts.net:4790
✓ claude: 2.1.302, logged in (claude.ai)
✓ gh: logged in as ada-lovelace
✔ Commit author for your agents' commits (Name <email>) · ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>
✓ commit author: ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>
✓ hub: runs as a service and answers at 100.x.y.z:4790 (home ~/.fleetd/hub)
✔ Which machines should run agents? (space toggles, enter accepts) · homeserver (this machine)
✓ worker homeserver: online
✓ claude on homeserver: fleetd's Claude is logged in
✔ Which repo should be your first project? · ~/src/myapp  ada-lovelace/myapp
✓ first project: ~/src/myapp on homeserver
✔ Pair the desktop app with this hub now? · yes
✓ pairing code: 8X5X-DJ0M for http://hub.your-tailnet.ts.net:4790 (one use, until 2026-10-18T12:00:24.131Z)
    The app on this machine pairs by itself (~/.config/fleetd/app-pair.json).
    On another computer: open the app, enter http://hub.your-tailnet.ts.net:4790 and the code, or open fleetd://pair?hub=…&code=8X5X-DJ0M
✓ doctor: 9 of 9 checks pass
fleetd is set up.
Next: install the desktop app on the computer you work from (curl -fsSL https://fleetd.sh | sh -s -- --app), open it and enter the pairing code; then type your first order in it.
```

**3. Open the app and send your first order**

On the computer you work from, install just the app and open it:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --app
open ~/Applications/fleetd.app                    # macOS
~/.local/share/fleetd/app/fleetd-app &            # Linux (or "fleetd" in your app menu)
```

On "Connect to your fleetd hub", enter the hub address and the pairing code `fleetd init` printed. If the hub
machine has a desktop, the app there connects by itself. Codes last 15 minutes; `fleetd pair` on the hub prints a
new one. Then type an order, such as `fix the typo in the README`. The project's lead answers with a brief and starts
work, and its questions show up in the inbox.

## After setup

- **More machines:** on the hub, `fleetd pair --worker <name>` prints one line to paste on the new machine. It
  installs fleetd there and joins it to the hub with a one-time code. To set one up from the hub over SSH instead,
  run `fleetd init` again and pick it, or run `fleetd machine add <ssh-host>`, which prints every remote command
  first (`--dry-run` only prints them). A worker needs only the `claude` CLI. For now it must have the same OS and
  architecture as the hub.
- **Reaching the hub:** `fleetd init` listens on your tailnet when it finds Tailscale, and otherwise on
  `127.0.0.1:4790` only. It never opens the hub to the internet. To change the address later, run
  `fleetd init --listen <host:port> --url <url>`.
- **Other agents:** the MCP endpoint is `<hub url>/mcp`. Give an outside agent a key with
  `fleetd hub key create --name <agent> --role operate --machines '*'`.
- **Your first order:** adding projects, sending orders and answering asks: [docs/FIRST-USE.md](docs/FIRST-USE.md).
- **Health:** `fleetd doctor` checks every machine and prints the fix for anything wrong. The app shows the same
  checks.
- **Update and undo:** `fleetd update` installs the latest build. `fleetd machine remove <id>` and
  `fleetd uninstall` undo the setup. `fleetd help` lists every command and option.

## How it works

- **Hub** (`fleetd hub`): one per fleet, on an always-on machine. It holds the leads, briefs, tasks, slots, merge
  train, questions and decisions, checks and wakes, and serves one MCP endpoint over all machines.
- **Node** (`fleetd node`): one per machine. It dials out to the hub, so no machine opens a port. It runs the agents
  itself: one `claude` process per live session, each in its own git worktree. It uses a Claude login of its own in
  `~/.fleetd/claude`, separate from yours in `~/.claude`.
- **Desktop app:** the only human surface. It is where you answer questions, approve commands and enter secrets,
  which the app seals to the target machine.

Agents reach Claude only through the `claude` CLI with your own login. fleetd never calls a model API.
Security model: [docs/SECURITY.md](docs/SECURITY.md).

## Status

Early. Every planned piece is built and passes an end-to-end lab suite with real `claude` turns, but fleetd has not
yet run real work. Releases are nightly builds for now, and `fleetd update` stays on the channel you installed
from.

## Contributing

fleetd is one Cargo workspace and builds with a recent stable Rust:

```sh
git clone https://github.com/unlaboredlabs/fleetd && cd fleetd
cargo build --release -p fleetd        # target/release/fleetd
```

Layout, checks, the lab suite and conventions: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

MIT
