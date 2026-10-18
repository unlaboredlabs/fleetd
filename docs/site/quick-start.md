---
title: Quick start
section: Get started
order: 20
description: One command installs and sets up fleetd; then send your first order.
---

fleetd runs Claude Code on your machines: you type what you want, and it plans the work, runs the agents, opens
pull requests it has checked, and asks you only about real decisions.

**You need:** macOS or Linux x64, `git`, the `claude` CLI logged in, and `gh` for pull requests. About a minute later the
hub runs on this machine, the app is paired, and you type your first order.

## 1. Install and set up

On the always-on machine that will be your hub:

```sh
curl -fsSL https://fleetd.sh | sh
```

It installs fleetd and runs `fleetd init`, which asks a few questions (Enter takes the default) and ticks off each
step. A ✗ line ends with the command that fixes it. Run `fleetd init` again at any time: it keeps what works and
repairs the rest. `curl -fsSL https://fleetd.sh | sh -s -- --no-init` only installs.

```console
$ fleetd init
fleetd init: sets up fleetd on this machine, step by step. Enter takes the default.
✔ Is this machine the hub (the always-on machine that runs your fleet)? · yes
✔ Where should the hub listen? · http://hub.your-tailnet.ts.net:4790  your tailnet: the app and your other machines reach it, nothing public
✓ reachability: the hub will answer at http://hub.your-tailnet.ts.net:4790
✓ claude: 2.1.302, logged in (claude.ai)
✓ gh: logged in as ada-lovelace
✔ Commit author for your agents' commits (Name <email>) · ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>
✓ commit author: ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>
✓ hub: runs as a service and answers at 100.x.y.z:4790 (home ~/.fleetd/hub)
✔ Which machines should run agents? (space toggles, enter accepts) · homeserver (this machine)
✓ worker homeserver: online
✓ claude on homeserver: fleetd's Claude is logged in
✔ Which repo should be your first project? · ~/src/myapp  github.com/ada-lovelace/myapp
✓ first project: ~/src/myapp on homeserver
✔ Pair the desktop app with this hub now? · yes
✓ pairing code: 8X5X-DJ0M for http://hub.your-tailnet.ts.net:4790 (one use, until 2026-10-18T12:00:24.131Z)
    The app on this machine pairs by itself (~/.config/fleetd/app-pair.json).
    On another computer: open the app, enter http://hub.your-tailnet.ts.net:4790 and the code, or open fleetd://pair?hub=…&code=8X5X-DJ0M
✓ doctor: 9 of 9 checks pass

fleetd is set up.
Next: install the desktop app on the computer you work from (curl -fsSL https://fleetd.sh | sh -s -- --app), open it and enter the pairing code; then type your first order in it.
```

`fleetd init` asks where the hub listens: your tailnet first when it finds Tailscale, then this machine only, then
your LAN:

```text
? Where should the hub listen? ›
❯ http://hub.your-tailnet.ts.net:4790  your tailnet: the app and your other machines reach it, nothing public
  http://127.0.0.1:4790  this machine only: workers on other machines can't reach it
  http://192.168.1.20:4790  your LAN: anyone on this network can reach it (plain HTTP)
```

It never opens the hub to the internet.

## 2. Send your first order

On the hub machine, if it has a desktop, the app pairs by itself. To work from another computer, install
fleetd there with its app and open it:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --app
open ~/Applications/fleetd.app                    # macOS
~/.local/share/fleetd/app/fleetd-app &            # Linux (or "fleetd" in your app menu)
```

Enter the hub address and the pairing code `fleetd init` printed. Codes last 15 minutes; `fleetd pair` on the hub
prints a new one. Then press ⌘N (Ctrl+N on Linux) and type an order, such as `fix the typo in the README`.

The order starts the project's lead, which answers with a brief and starts work. Its questions land in the inbox.

Next: [Concepts](concepts.md), or [more machines](machines.md).
