---
title: Moving a hub
description: Move a self-hosted hub to fleetd cloud, or to another machine with fleetd export and fleetd import.
---

Move everything a hub knows to fleetd cloud, or to a new hub on another machine.

## Move to the cloud {#cloud}

You need Admin on every machine.

1. In the app, open **Settings › Hub › Setup › Move to the cloud**.
2. Sign in to fleetd cloud. The move goes into an empty team of yours, or a new one.
3. Click **Move**. The hub pauses its bots and uploads its data. The sheet shows the progress.
4. Your machines rejoin the cloud team by themselves. An offline machine rejoins when it's next online.
5. The app opens the team. Your bots carry on there, with their history.

The old hub keeps its data and stays paused. **Undo** on its banner runs the bots there again.

If the move stops, nothing changes on either side, and the sheet says why.

## Move to another machine {#export}

1. On the old hub, write everything to one file:

   ```sh
   fleetd export --out shop-hub.tar
   ```

   It asks for a passphrase of 12 characters or more. Secrets in the file are sealed under it. Keep the passphrase:
   nobody can recover it.

2. On the new machine, install fleetd and run `fleetd init`. Don't add a bot.
3. Stop the new hub: `systemctl --user stop fleetd-hub`, or on a Mac
   `launchctl bootout gui/$(id -u)/sh.fleetd.hub`.
4. Load the file and enter the passphrase:

   ```sh
   fleetd import shop-hub.tar
   ```

5. Start the hub: `systemctl --user start fleetd-hub`, or on a Mac
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/sh.fleetd.hub.plist`.
6. Join your machines and pair your devices again, with the commands `fleetd import` prints.

The old hub keeps running during the export. Import only loads into a new hub with no bots yet. It loads everything
or nothing: a wrong passphrase or a damaged file changes nothing.

For scripts, pass the passphrase with `--passphrase-file <file>`, or `-` for standard input. `--no-secrets` leaves
the secrets out.

## What moves {#carried}

- Bots with their settings, repos and instructions
- Chats, with attachments
- Orders, decisions, memory, skills and reports
- Automations, with their schedules and webhooks
- People and their roles
- The hub's settings
- Recordings of screens
- Vault items, the GitHub App and connected accounts (with the passphrase)

## What stays behind {#not-carried}

- **Machines' and devices' sign-ins.** Each machine joins the new hub again with `fleetd pair --worker <machine-id>`.
  People pair their devices again.
- **Running agents.** Let them finish or stop them before you export.
- **The vault's key.** The new hub has its own. Save its new [recovery code](/docs/vault#key).

A machine that joins under the same name, with its folders where they were, picks its bots up as they were.
