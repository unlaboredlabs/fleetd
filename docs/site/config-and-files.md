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
    hub.sqlite           everything the hub knows, timelines included (see below)
    setup.json           what fleetd init and machine add set up: address, commit identity, machines
    hub.log              the hub service's log
    cli.key              the admin key the CLI on this machine uses
    webhook.key          seals webhook secrets
    playbooks/<name>.md  your version of a playbook (the retro writes here too); delete it for fleetd's
    prompts/<id>.md      your version of a prompt, hub-wide
    prompts/projects/<key>/<id>.md   the same for one project (<key> is a hash of the project)
  node/                  the node's home (every worker)
    node.json            the hub it belongs to, its machine id and an optional claudeConfigDir
    node-key.pem         proves the node to the hub
    node-box-key.pem     opens secrets sealed to this machine
    node.sock            the socket lead-side commands reach the hub through
    sessions.sqlite      the node's sessions, and timings not yet sent to the hub
    worktrees/           one git worktree per writer session
  claude.env             optional extra environment for every claude fleetd starts
  logs/node.log          the node service's log
```

Prompts and instructions: [What agents are told](what-agents-are-told.md). `fleetd uninstall` keeps all of it; see [Updating & uninstall](updating-and-uninstall.md).

## Timelines {#timelines}

The hub keeps the spans behind [Where time went](time-inspector.md) in `hub.sqlite` for 30 days, and their daily
totals and each finished order's critical path for 400 days (older ranges show those totals, without the commands
and findings). Set 1 to 365 days with `fleetd time --retention <days>`
(an admin key) or in the app's Settings under Data, which shows their size; a busy fleet adds a few MB a day.

Each node holds the timings it has not sent yet in `sessions.sqlite` and deletes them once the hub has them. While
the hub is away it keeps up to 7 days or 500,000 of them; past that it drops the oldest and the timeline shows the
gap.

## The Claude login {#claude}

Sessions run `claude` with your own setup on that machine (`~/.claude`), so your login, the `env` in
`~/.claude/settings.json` (a proxy's `ANTHROPIC_BASE_URL`, say), an `apiKeyHelper` and your MCP servers work as they
do in your shell. If `claude` works for you on the worker, it works
for fleetd. Otherwise log in as you normally do: `claude auth login`, or through your proxy.

`fleetd doctor` shows what each worker uses, e.g. `claude 2.1.302, logged in (Max), via proxy http://127.0.0.1:8317
from ~/.claude/settings.json`.

fleetd adds its own settings per session on top of yours, never in their place: an `--mcp-config` with its agent
tools, and a `--settings` overlay that pins claude's version, turns claude's auto memory and its own subagents off
([why](what-agents-are-told.md#no-subagents)) and denies the tools agents never get (subagents, plan mode, worktrees,
cron).

To give a worker's sessions a dedicated claude profile instead, set `"claudeConfigDir": "<dir>"` in
`~/.fleetd/node/node.json` (or join with `fleetd node join --claude-config-dir <dir>`) and restart the node. A
session resumes only under the config dir it started in; the node refuses a resume under another one and says so.

The hub's own `claude` (the order router and the retro) uses your normal login on the hub machine (`~/.claude`), or
the gateway variables in `claude.env`.

## claude.env {#claude-env}

Optional. `KEY=VALUE` lines for the `claude` that fleetd runs, for a variable your login needs that the services don't
see, such as one only your interactive shell exports. Blank lines, `#` comments and `export ` are allowed. Mode
0600. Your `~/.claude/settings.json` `env` outranks it, as it does for your own `claude`.

```ini
CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
# or
ANTHROPIC_BASE_URL=https://gateway.example.com
ANTHROPIC_AUTH_TOKEN=<token>
```

- **Nodes** add every line to each session's environment and re-read the file at each start.
- **The hub** service loads the file when it starts, so restart it after a change. Its own `claude` gets only
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from it.


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
lead:                     # optional
  autoStart: false        # orders wait for lead_start instead of starting the lead (default true)
claude:                   # optional
  autoMemory: true        # the sessions keep claude's own auto memory (default false: fleetd turns it off)
branchPrefix: team-a/     # optional: what writer branches start with (default fleetd/), ending in /
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

## Hub environment {#env}

Three variables in the hub's environment tune how it follows GitHub; the defaults suit almost everyone.

| variable | default | does |
|---|---|---|
| `FLEETD_STATUS_GITHUB_STALE_SEC` | `180` | seconds without a good GitHub answer before [Status](status.md#stale-data) marks a repo stale |
| `FLEETD_MAIN_CI_EVERY_SEC` | `60` | how often each merge train checks its main branch's CI (every 5 minutes with GitHub webhooks on) |
| `FLEETD_TRAIN_NO_CI_GRACE_SEC` | `90` | how long a head may have no check before the train asks whether its PR has CI at all |

## The app

The app's pairing hand-off from `fleetd init` or `fleetd pair` on the same machine is
`~/.config/fleetd/app-pair.json` (macOS: `~/Library/Application Support/fleetd/app-pair.json`). Its hub key is in the
OS keychain, except in an unsigned or ad-hoc signed Mac build, which keeps it in
`~/Library/Application Support/fleetd/hub.json` (mode 0600).
