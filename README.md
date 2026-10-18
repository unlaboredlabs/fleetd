# fleetd

An open-source software factory. Send a one-line order from the desktop app or any MCP client. A lead agent for
the project turns it into a brief and runs coding agents across your machines. It asks you only about product calls,
money, credentials and irreversible steps, and reports "done" only after fleetd has checked the work itself.

## Quick start

Run these on the always-on machine that will be your hub (Linux x64, or macOS arm64 or x64). You need `git`, plus the
`claude` and `gh` CLIs logged in to your own accounts. `fleetd init` checks both, prints the install command for
anything missing and offers to log you in.

**1. Install fleetd**

```sh
curl -fsSL https://fleetd.sh | sh
```

<!-- expected-output: installer (site/install.sh). Replace with a real run once #89 merges. -->
```text
fleetd: installed the CLI: /home/you/.fleetd/bin/fleetd
fleetd: installed the app: /home/you/.local/share/fleetd/app (menu entry: /home/you/.local/share/applications/fleetd.desktop)

Next, run:
  fleetd init
```

It checks the binary's checksum before installing it. On a machine without a desktop it installs only the CLI.

**2. Set it up**

```sh
fleetd init
```

It asks a few questions (Enter takes the default) and ticks off each step. A ✗ line ends with the exact command
that fixes it. Run `fleetd init` again at any time: it keeps what works and repairs the rest.

<!-- expected-output: `fleetd init` (PR #89 on the native runner). Draft; paste the real transcript once it merges. -->
```text
fleetd init: sets up fleetd on this machine, step by step. Enter takes the default.
? Is this machine the hub (the always-on machine that runs your fleet)? Yes
? Where should the hub listen? http://box.tail1234.ts.net:4790  your tailnet: the app and your other machines reach it, nothing public
✓ reachability: the hub will answer at http://box.tail1234.ts.net:4790
✓ hub: running as a user service (home ~/.fleetd/hub)
✓ claude: logged in
✓ gh: logged in as you
✓ commit author: You <12345+you@users.noreply.github.com>
? Which machines should run agents? box (this machine)
✓ box: set up as a worker
✓ claude on box: fleetd's Claude is logged in
? Which repo should be your first project? ~/src/myapp  you/myapp
✓ first project: ~/src/myapp on box
✓ desktop app: paired: box
✓ doctor: 12 of 12 checks pass

fleetd is set up.
Next: open the desktop app; it connects by itself. Then type your first order in it, e.g. "fix the typo in the README".
```

**3. Open the app and send your first order**

```sh
open ~/Applications/fleetd.app                    # macOS
~/.local/share/fleetd/app/fleetd-app &            # Linux (or "fleetd" in your app menu)
```

The app pairs with the hub by itself and opens on the inbox. Type an order, such as `fix the typo in the README`.
The project's lead answers with a brief and starts work. Its questions show up in the inbox.

Working from another computer? Run the same `curl` line there, open the app, and enter the hub address and the
pairing code `fleetd init` printed. `fleetd pair` on the hub prints a new code at any time.

## After setup

- **More machines:** run `fleetd init` again and pick them, or `fleetd machine add <ssh-host>` on the hub. It works
  over SSH, prints every remote command first (`--dry-run` only prints them) and needs only the `claude` CLI on the
  worker. For now a worker must have the same OS and architecture as the hub.
- **Reaching the hub:** `fleetd init` listens on your tailnet when it finds Tailscale, and otherwise on
  `127.0.0.1:4790` only. It never opens the hub to the internet. To change the address later, run
  `fleetd init --listen <host:port> --url <url>`.
- **Other agents:** the MCP endpoint is `<hub url>/mcp`. Give an outside agent a key with
  `fleetd hub key create --name <agent> --role operate --machines '*'`.
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
