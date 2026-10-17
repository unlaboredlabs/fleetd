# fleetd

An open-source software factory. Send a one-line order from your desktop or phone; a lead agent for the
project turns it into a brief, runs a fleet of coding agents across your machines, asks you only about
product calls, money, credentials and irreversible steps, and reports "done" only after fleetd has checked it.

fleetd drives stock [T3 Code](https://github.com/pingdotgg/t3code) daemons on each machine and runs Claude only
through the `claude` CLI with your own login.

Status: early development. Not usable yet.

## Setting up

On the always-on machine that will be the hub (Linux or macOS, Node 24):

```sh
fleetd init --git-identity "Name <id+user@users.noreply.github.com>"   # hub service, push keys, first pairing link
fleetd machine add <ssh-host>                                           # per worker: T3, the node, both as services
```

`fleetd machine remove <id>` and `fleetd uninstall` undo them; `fleetd help` lists every option.

License: MIT.
