---
title: Troubleshooting
section: Reference
order: 100
description: Every fleetd doctor finding and the command that fixes it.
---

`fleetd doctor` on the hub checks the hub and every machine, and prints each problem with its fix. The app's Machines
screen shows the same checks. Fix commands run on the machine the finding names. Each section here is one check:
a hub check `hub/<name>` is `#hub-<name>`, a machine check `<machine>/<name>` is `#<name>`.

```console
$ fleetd doctor
✗ doctor hub: gh is not logged in on the hub; the merge train and PR checks need it. Fix: gh auth login
✗ doctor hub: claude on the hub is not logged in; the intake router and the retro can't reach a model. Fix: claude auth login
! doctor laptop: laptop is degraded: claude is not logged in. Fix: claude auth login
✗ doctor laptop: laptop: claude 2.1.302, not logged in, so its sessions can't start. Fix: claude auth login
✗ doctor laptop: No git commit identity is set on laptop. Fix: fleetd pair --worker laptop, then run what it prints on laptop
✓ doctor: 7 of 12 checks pass
[exit 1]
```

✗ is a failure; ! is a warning or a check that couldn't tell.

## The hub doesn't answer {#no-hub}

```console capture=doctor-no-hub
$ fleetd doctor
✗  doctor the hub does not answer at http://127.0.0.1:4778: error sending request for url (http://127.0.0.1:4778/mcp): client error (Connect): tcp connect error: Connection refused (os error 111). Fix: fleetd init (it starts the hub and repairs its setup)
[exit 4]
```

Run `fleetd init`. If you run the hub yourself (`--no-service`), start it with `fleetd hub start`. The log is
`~/.fleetd/hub/hub.log`.

## The hub doesn't answer at its own address {#hub-reachable}

> The hub does not answer at its own address http://…/healthz (…).

Restart the hub service:

```sh
systemctl --user restart fleetd-hub.service                  # Linux
launchctl kickstart -k gui/$(id -u)/sh.fleetd.hub            # macOS
```

## gh is not installed or not logged in {#hub-gh_auth}

> gh is not logged in on the hub; the merge train and PR checks need it.

```sh
gh auth login
```

If gh is missing, install it from [cli.github.com](https://cli.github.com) first.

## claude on the hub is not logged in {#hub-claude_login}

> claude on the hub is not logged in; the intake router and the retro can't reach a model.

```sh
claude auth login
```

When the hub's claude goes through a proxy, the doctor names it; log in with your proxy as you normally do. For a
gateway, API key or token instead, put `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN`) in `~/.fleetd/claude.env` and restart the hub service: see [claude.env](config-and-files.md#claude-env). If claude is missing ("Claude Code (claude) is not on the hub's PATH"), install it first
(next section).

## claude on the hub is missing or the wrong version {#hub-claude_version}

Same findings and fixes as [a worker's claude version](#claude_version), for the hub's own claude. Not installed:

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

## The hub isn't reachable over HTTPS {#hub-https}

> The hub's address http://… is not HTTPS; keys from the desktop app and other machines would cross the network
> unencrypted.

Plain HTTP passes on loopback and on a tailnet address (`100.64.0.0/10` or a `*.ts.net` name). Elsewhere, serve the hub
over HTTPS, then stop the hub and point fleetd at the new address:

```sh
tailscale serve --bg 4790
fleetd init --url https://<that address>
```

The same fix applies to "The hub has no address set up" and to an unreadable `~/.fleetd/hub/setup.json`. When the
HTTPS address stops answering, check where it points with `tailscale serve status`.

## A machine is offline or degraded {#online}

> laptop is offline (last seen …). · laptop is degraded: ….

The finding's fix follows the cause. For claude logged out, out of range or missing, it is the login, update or
install (see the claude findings below), and both in order when both are needed. Only a node that is down or has
no claude cause gets a restart, on that machine:

```sh
systemctl --user restart fleetd-node.service                 # Linux
launchctl kickstart -k gui/$(id -u)/sh.fleetd.node           # macOS
```

The log is `~/.fleetd/logs/node.log`.

## claude is missing or the wrong version {#claude_version}

fleetd speaks claude's stream-json protocol, which isn't a stable API. It is tested with claude `>=2.1.300, <2.2.0`
(fixtures from 2.1.302). An older claude runs with a warning: fleetd checks its protocol at every start and refuses
it only if something fleetd uses is missing. A claude past 2.2 is refused.

| Finding | Status | Fix |
|---|---|---|
| claude is not installed on laptop; its sessions can't start. | ✗ | `curl -fsSL https://claude.ai/install.sh \| bash` |
| claude 2.1.296 is older than fleetd is tested with (from 2.1.300); it may work, and fleetd checks its protocol at every start. | ! | `claude update` |
| claude 2.2.0 is newer than this fleetd supports (>=2.1.300, <2.2.0); its stream-json protocol may have changed. | ✗ | `claude install 2.1.302, or fleetd update` |
| claude 2.1.303 is newer than 2.1.302, the version this fleetd was tested with. It is inside the supported range, so sessions run. | ! | `claude install 2.1.302` |
| `claude --version` printed "…", which fleetd can't read as a version. | ✗ | `curl -fsSL https://claude.ai/install.sh \| bash -s 2.1.302` |

Sessions on that machine are refused until a ✗ is fixed. fleetd turns claude's auto-updater off for its own sessions.

## claude is not logged in on a worker {#claude_login}

> laptop: claude 2.1.302, not logged in, so its sessions can't start.

Sessions use the worker's own claude setup, so log in there as you would for yourself:

```sh
claude auth login
```

If claude goes through a proxy (`ANTHROPIC_BASE_URL` in `~/.claude/settings.json`; the doctor names it), log in with
your proxy as you normally do. A login that expires mid-run ("claude refused its login: …") has the same fix. See
[the Claude login](config-and-files.md#claude).

## claude doesn't answer the protocol probe {#runner_conformance}

> claude on laptop did not answer fleetd's protocol probe as expected.

Put the tested claude on that machine:

```sh
claude install 2.1.302
```

"`claude --version` and the running claude disagree (… vs …): two installs on PATH?" means two claudes; reinstall
with `curl -fsSL https://claude.ai/install.sh | bash` and remove the other. "has not probed its claude yet" clears by
itself a second after the node starts.

## No or the wrong commit identity {#commit_identity}

> No git commit identity is set on laptop. · Commits on laptop use … (from git's global config); the hub's identity
> is ….

For a machine set up over SSH, write the hub's identity into its service again, from the hub:

```sh
fleetd machine add laptop
```

For the hub's own machine, the finding prints `fleetd machine add --local`.

For one that joined with a code, run `fleetd pair --worker laptop` on the hub, then the command it prints on the
machine. Without a hub identity, set one on the machine:
`git config --global user.email '<id>+<user>@users.noreply.github.com'`.

## Low disk space {#disk}

> … free under ~ on laptop; fleetd needs at least 5.0 GB.

Each writer session gets its own git worktree, so a machine needs room. Free space under the path the finding
names; `df -h <path>` shows what is left.

## A machine sleeps when idle {#sleep}

> laptop sleeps after 15 min idle on AC power (KDE power management). fleetd keeps it awake while agents run, but it
> still sleeps between orders, and asleep it is unreachable: queued work and wakes wait until someone wakes it.

While any agent runs, the node keeps its machine awake (`systemd-inhibit --list` or `pmset -g assertions` shows
"fleetd: 2 agents running"). Between orders nothing does, so a machine set to sleep when idle drops off until
someone wakes it. Sleep on battery only is fine. The fix names the setting for that machine's desktop:

| Where | Fix |
|---|---|
| KDE Plasma | System Settings > Power Management > On AC Power > When inactive: Do nothing |
| GNOME | `gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'` |
| logind `IdleAction` | `IdleAction=ignore` in `/etc/systemd/logind.conf.d/fleetd.conf`, then reboot |
| macOS | `sudo pmset -c sleep 0` |

When a machine wakes, its node links to the hub again at once, resumes any run whose claude went quiet during the
sleep, and logs `machine.slept`. The app's machine strip shows "slept 10m46s" for an hour after.

## The usage breaker is open {#usage_breaker}

> New turns on laptop are paused by the usage breaker.

The machine's Claude login hit a plan or rate limit, and new turns wait. Wait for the reset (the finding says when),
or, once the login has capacity, call `usage_resume` for that machine from an MCP client.
