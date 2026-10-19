---
title: Quick start
section: Get started
order: 20
description: One command installs and sets up fleetd; then send your first order.
---

fleetd runs Claude Code on your machines: you type what you want, and it plans the work, runs the agents, opens
pull requests it has checked, and asks you only about real decisions.

**You need:** macOS or Linux x64, the `claude` CLI logged in (fleetd uses your own claude setup, including any proxy
in `~/.claude/settings.json`), `git`, and `gh` for pull requests. About a minute later the hub runs on this machine,
the app is paired, and you type your first order.

## 1. Install and set up

On the always-on machine that will be your hub:

```sh
curl -fsSL https://fleetd.sh | sh
```

It installs fleetd and starts the setup wizard, `fleetd init`. Enter takes the default at each question, and a ✗ line
ends with the command that fixes it. Run `fleetd init` again at any time: it keeps what works and repairs the rest.
`curl -fsSL https://fleetd.sh | sh -s -- --no-init` only installs.

```console
$ curl -fsSL https://fleetd.sh | sh
fleetd: installed the CLI: ~/.fleetd/bin/fleetd
┌   fleetd init
│
◆  This machine  1/6
◇  What is this machine?
│  The hub
│
◇  Where should the hub listen?
│  Your tailnet
│
✓  reachable at http://hub.your-tailnet.ts.net:4790
│
◆  Logins  2/6
✓  claude 2.1.302, logged in (Max), via proxy http://127.0.0.1:8317 from ~/.claude/settings.json
✓  gh logged in as ada-lovelace
◇  Commit author for your agents
│  ada-lovelace <1234567+ada-lovelace@users.noreply.github.com>
│
◆  Hub  3/6
✓  hub runs as a service · 100.x.y.z:4790
│
◆  Workers  4/6
◇  Which machines should run agents?
│  homeserver
│
✓  homeserver online
│
◆  Project  5/6
◇  Which repo should be your first project?
│  ~/src/hello
│
✓  project ~/src/hello on homeserver
│
◆  App & check  6/6
◇  Pair the fleetd app with this hub?
│  Yes
│
✓  pairing code K4QW-7RNP · one use, 15 min
│  In the fleetd app, enter http://hub.your-tailnet.ts.net:4790 and the code, or open:
│  fleetd://pair?hub=http%3A%2F%2Fhub.your-tailnet.ts.net%3A4790&code=K4QW-7RNP
✓  doctor 12 of 12 checks pass
◇  fleetd is ready ─────────────────────────────────────╮
│                                                       │
│  hub       http://hub.your-tailnet.ts.net:4790        │
│  workers   homeserver                                 │
│  project   ~/src/hello on homeserver                  │
│  app       code K4QW-7RNP                             │
│  PATH      add: export PATH="$HOME/.local/bin:$PATH"  │
├───────────────────────────────────────────────────────╯
│
└  Next: get the fleetd app (curl -fsSL https://fleetd.sh | sh) and enter the code.
```

The hub listens on your tailnet when the wizard finds Tailscale; you can also pick this machine only or your LAN. It
never opens the hub to the internet.

## 2. Send your first order

On the hub machine, if it has a desktop, the app is installed too and pairs by itself when you open it. To work from
another computer, install fleetd there without the wizard and open the app:

```sh
curl -fsSL https://fleetd.sh | sh -s -- --no-init
open ~/Applications/fleetd.app                        # macOS
~/.local/share/fleetd/app/fleetd-desktop.AppImage &   # Linux (or "fleetd" in your app menu)
```

Enter the hub address and the pairing code `fleetd init` printed. Codes last 15 minutes; `fleetd pair` on the hub
prints a new one. The app opens on the board, ready to type: enter an order, such as `fix the typo in the README`,
and press Enter.

The order starts the project's lead, which answers with a brief and starts work. Its questions land in the inbox
(⌘I, Ctrl+I on Linux).

Next: [Concepts](concepts.md), or [more machines](machines.md).
