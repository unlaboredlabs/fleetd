---
title: Install
section: Get started
order: 10
description: One command installs the fleetd CLI, plus the desktop app on a machine with a display.
---

```console
$ curl -fsSL https://fleetd.sh | sh
fleetd: installed the CLI: ~/.fleetd/bin/fleetd

Next, run:
  fleetd init
```

Then set it up: [Quick start](quick-start.md).

## Platforms

| | CLI (hub and workers) | Desktop app |
|---|---|---|
| Linux x64 | yes | yes |
| macOS, Apple silicon | yes | yes |
| macOS, Intel | yes | yes |

The hub also needs `git`, and the `claude` and `gh` CLIs logged in to your own accounts. A worker needs only
`claude`. `fleetd init` checks each one and prints the install command for anything missing.

## What it installs

- The CLI at `~/.fleetd/bin/fleetd`, linked from `~/.local/bin/fleetd`.
- The desktop app, on macOS and on Linux with a display: `~/Applications/fleetd.app`, or `~/.local/share/fleetd/app`
  with a menu entry.

Every download is checked against the release's `SHA256SUMS`. The installer needs no sudo and starts no services:
`fleetd init` does that. Running it again replaces what it installed. To read it first, open
[fleetd.sh/install.sh](https://fleetd.sh/install.sh).

## Options

```sh
curl -fsSL https://fleetd.sh | sh -s -- --app       # the app too, on Linux without a display
curl -fsSL https://fleetd.sh | sh -s -- --no-app    # the CLI only
```

```console
$ curl -fsSL https://fleetd.sh | sh -s -- --app
fleetd: installed the CLI: ~/.fleetd/bin/fleetd
fleetd: installed the app: ~/.local/share/fleetd/app (menu entry: ~/.local/share/applications/fleetd.desktop)

Next, run:
  fleetd init
```

Releases are nightly builds for now. `FLEETD_CHANNEL=stable` picks the stable channel once it has a release.

## Verify

```console
$ fleetd version
fleetd 0.0.0-nightly.20261018.832ba8f (protocol 1)
```

If your shell can't find `fleetd`, add `~/.local/bin` to your `PATH`, or run `~/.local/bin/fleetd`.
