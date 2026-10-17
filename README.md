# fleetd

An open-source software factory. Send a one-line order from the desktop app or any MCP client; a lead agent for the
project turns it into a brief, runs a fleet of coding agents across your machines, asks you only about
product calls, money, credentials and irreversible steps, and reports "done" only after fleetd has checked it.

fleetd drives stock [T3 Code](https://github.com/pingdotgg/t3code) daemons on each machine and runs Claude only
through the `claude` CLI with your own login.

Status: alpha. Every planned piece is built and passes an end-to-end lab suite against real T3 daemons and real
`claude` turns, but fleetd has not yet run real work. Not on npm yet: install from source.

What you get:

- **One lead per project.** It plans and delegates through fleetd; it never writes code itself.
- **One cap for every subagent.** Each one has an explicit model and effort, its own worktree and branch, one
  writer per area, and counts against a global cap.
- **A serial merge train.** It rebases just before merging, waits for CI on that exact commit, and runs reviews
  sized by risk tier.
- **"Done" is checked.** A lead can only claim done; fleetd runs the brief's checks itself, and claims without
  receipts are marked unverified.
- **Questions arrive in one numbered batch,** and only for product, money, credential or irreversible calls.
  Terse replies ("1 go 2 nvm") are parsed without AI and logged so nothing is asked twice.
- **Approvals and secrets in a native desktop app** (GPUI). Secrets are sealed in the app to the target machine;
  approved commands run exactly as stored; what only you can unblock raises an OS notification.
- **One MCP endpoint for all your machines,** so outside agents can drive the fleet.
- **Usage limits handled plainly.** Hitting a limit parks work and resumes it at the reset, with one plain notice.

## Install from source

```sh
git clone https://github.com/unlaboredlabs/fleetd && cd fleetd
pnpm install && pnpm build          # Node 24, pnpm via corepack
alias fleetd="node $PWD/apps/cli/dist/bin.js"
```

## Setting up

On the always-on machine that will be the hub (Linux or macOS, Node 24):

```sh
fleetd init --git-identity "Name <id+user@users.noreply.github.com>"   # the hub as a user service
fleetd hub key create --human --name mac                                # the key the desktop app connects with
fleetd machine add <ssh-host>                                           # per worker: T3, the node, both as services
```

`fleetd machine remove <id>` and `fleetd uninstall` undo them; `fleetd help` lists every option.

License: MIT.
