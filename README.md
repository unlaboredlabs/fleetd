# fleetd

An open-source software factory. Send a one-line order from the desktop app or any MCP client. A lead agent for
the project turns it into a brief and runs coding agents across your machines. It asks you only about product calls,
money, credentials and irreversible steps, and reports "done" only after fleetd has checked the work itself.

```sh
curl -fsSL https://fleetd.sh | sh
```

This installs the `fleetd` binary from the nightly GitHub release (Linux x64, macOS arm64 and x64) after checking its
checksum. On a desktop it installs the fleetd app too.

## Quick start

On the always-on machine that will be the hub:

```sh
fleetd init --git-identity "Name <id+user@users.noreply.github.com>"   # the hub, as a user service
fleetd hub key create --human --name laptop                             # the key the desktop app connects with
fleetd machine add <ssh-host>                                           # per worker: T3 and the node, as services
```

Open the desktop app and connect it to the hub's URL with the key from `hub key create --human`. The hub listens on
`127.0.0.1:4790`. To reach it from other devices, use Tailscale Serve or your own TLS proxy, and pass that address
to `fleetd init --url`.

`machine add` runs over SSH and prints every remote command first; `--dry-run` only prints them. Each worker needs
Node 24 or newer (for T3) and the `claude` CLI, logged in. For now, a worker must have the same OS and architecture
as the hub.

To give an outside agent the MCP endpoint (`<hub url>/mcp`), create an agent key:
`fleetd hub key create --name <agent> --role operate --machines '*'`.

`fleetd machine remove <id>` and `fleetd uninstall` undo the setup. `fleetd update` installs the latest build.
`fleetd help` lists every command and option.

## How it works

- **Hub** (`fleetd hub`): one per fleet, on an always-on machine. It holds the leads, briefs, tasks, slots, merge
  train, questions and decisions, checks and wakes, and serves one MCP endpoint over all machines.
- **Node** (`fleetd node`): one per machine. It dials out to the hub, so no machine opens a port.
- **Stock T3 Code:** each machine runs an unmodified, version-pinned [T3 Code](https://github.com/pingdotgg/t3code)
  daemon. The hub drives it as an ordinary client of its WebSocket RPC. Agents run Claude only through the `claude`
  CLI with your own login; fleetd never calls a model API.
- **Desktop app** (GPUI): the only human surface. It is where you answer questions, approve commands and enter
  secrets, which the app seals to the target machine.

Security model: [docs/SECURITY.md](docs/SECURITY.md).

## Status

Early. Every planned piece is built and passes an end-to-end lab suite against real T3 daemons and real `claude`
turns, but fleetd has not yet run real work. Releases are nightly builds for now; `fleetd update` stays on the
channel you installed from.

## Contributing

fleetd is one Cargo workspace: `crates/fleetd` (the binary: hub, node and CLI), `crates/fleetd-contracts` (wire
types), `crates/t3-wire` (the T3 RPC client) and `app/` (the desktop app). Building from source needs a recent stable
Rust:

```sh
git clone https://github.com/unlaboredlabs/fleetd && cd fleetd
cargo build --release -p fleetd        # target/release/fleetd
cargo test --workspace --exclude fleetd-app --exclude fleetd-bench
```

Layout, checks, building the app and conventions: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

The lab suite (`tests/lab`) runs the binary end to end against two disposable T3 instances built from source at the
pinned commit (`vendor/t3/pin.json`). It costs a handful of small `claude-haiku-5-5` turns. It is the only Node
piece in the repo, because T3 itself is a Node app. It needs Node 24 or newer and a logged-in `claude`; the m7 and
m9 scenarios also use the `gh` login.

```sh
cargo build --release -p fleetd
npm ci --prefix tests/lab
npm --prefix tests/lab run lab -- m1   # name scenarios, or none for the full suite
```

`FLEETD_LAB_SLOT=<0-9>` runs an independent lab with its own directory and ports. `FLEETD_BIN` picks another
binary.

## License

MIT
