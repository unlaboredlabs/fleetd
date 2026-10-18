---
title: Config & files
section: Reference
order: 90
description: Where fleetd keeps its state, the Claude login it uses, the project policy file, and its port.
---

## ~/.fleetd

```text
~/.fleetd/
  bin/fleetd             the CLI (linked from ~/.local/bin/fleetd)
  hub/                   the hub's home (hub machine only)
    hub.sqlite           everything the hub knows
    setup.json           what fleetd init and machine add set up: address, commit identity, machines
    hub.log              the hub service's log
    cli.key              the admin key the CLI on this machine uses
    webhook.key          seals webhook secrets
  node/                  the node's home (every worker)
    node.json            the hub it belongs to and its machine id
    node-key.pem         proves the node to the hub
    node-box-key.pem     opens secrets sealed to this machine
    node.sock            the socket lead-side commands reach the hub through
    sessions.sqlite      the node's sessions
    worktrees/           one git worktree per writer session
  claude/                fleetd's own Claude login and sessions
  claude.env             extra environment for every claude fleetd starts
  logs/node.log          the node service's log
```

`fleetd uninstall` keeps all of it; see [Updating & uninstall](updating-and-uninstall.md).

## The Claude login {#claude}

The node runs `claude` with `CLAUDE_CONFIG_DIR=~/.fleetd/claude`, so its login is separate from yours in `~/.claude`.
Log it in on each worker:

```sh
CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login
```

The hub's own `claude` (the order router and the retro) uses your normal login on the hub machine.

## claude.env {#claude-env}

`KEY=VALUE` lines added to the environment of every `claude` fleetd starts, re-read at each start. Blank lines, `#`
comments and `export ` are allowed. Mode 0600. Use it for a token instead of a login, or for a gateway:

```ini
CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
# or
ANTHROPIC_BASE_URL=https://gateway.example.com
ANTHROPIC_AUTH_TOKEN=<token>
```

`fleetd init` offers to copy these from your shell when it finds them there.

## .fleetd/policy.yaml {#policy}

An optional file in a project's repo; commit it to the default branch. Changes apply within a minute. Without it,
writers may touch the whole repo.

```yaml
areas:                    # what a writer task may touch; a task leases one or more areas
  docs: ["docs/**"]
  app: ["src/**", "package.json"]
defaults:                 # optional: the project's task model and effort (low, medium, high, max)
  model: claude-opus-5-5
  effort: high
finishAll:                # optional
  maxChildren: 10         # most child workstreams one finish-all run starts
tools:                    # optional: claude permission rules for every session
  allow: ["Bash(npm test:*)"]
  deny: ["Bash(git push:*)"]
```

Area names are lowercase slugs. A broken file is refused with the exact problem, never ignored, so a typo can't widen
what a writer may touch.

## Services

`fleetd init` and `fleetd machine add` run the hub and node as user services:

| | Linux (systemd) | macOS (launchd) |
|---|---|---|
| Hub | `~/.config/systemd/user/fleetd-hub.service` | `~/Library/LaunchAgents/sh.fleetd.hub.plist` |
| Node | `~/.config/systemd/user/fleetd-node.service` | `~/Library/LaunchAgents/sh.fleetd.node.plist` |

`--unit-suffix <s>` adds a suffix to these names, for a second fleet on one machine.

## Ports and addresses

The hub listens on one port, 4790 by default: on your tailnet address when `fleetd init` finds Tailscale, otherwise
on `127.0.0.1` only. The desktop app, nodes and MCP clients all use it (`<hub url>/mcp` for MCP). Workers open no
port: their nodes dial out. Change it with `fleetd init --listen <host:port> --url <url>`.

## The app

The app's pairing hand-off from `fleetd init` or `fleetd pair` on the same machine is
`~/.config/fleetd/app-pair.json` (macOS: `~/Library/Application Support/fleetd/app-pair.json`). Its hub key is in the
OS keychain.
