---
title: Audit log
description: See who did what in the workspace, filter it, and export it as CSV.
---

The audit log records who did what in the workspace, when, and on which bot or item. Only owners and admins can see it. It never holds a secret's value or anything said in a chat.

## What it records {#what}

| Group | What lands there |
|---|---|
| People | Someone joins, leaves or is removed, and role changes |
| Invites | Invites made and revoked |
| Devices | A new device pairs, and a device is signed out |
| Bots | Changes to a bot's approval mode, who merges and how, max agents, card and automations, and a bot deleted |
| Vault | Items added, changed, deleted or shown, and fills by agents, including refused ones |
| Approvals | Approvals answered and secrets entered (never the secret itself) |
| Merges | PRs merged by the merge train, or on GitHub |
| Workspace settings | Changes in **Settings › Workspace**: updates, profiles, machines, recordings and the workspace's caps |
| Connections | Tool servers, GitHub, Claude, Gemini, 1Password and Tailscale connected or removed |
| Share links | [Share links](/docs/share-links) made, opened, renewed and stopped, and the feature turned on or off |

Each row names the person by the name they had at the time, so rows about someone who has left still say who it was. Agents' actions show as that person's agent. Changes the workspace refused, such as a member trying to change an admin-only setting, are recorded too, marked **refused**.

Rows are kept for a year.

## In the app {#app}

Open **Settings › Workspace › Audit log**. It shows the newest rows first, 100 to a page. Use **Older** and **Newer** to page through them.

Filter by person, bot, kind and date range. **Export CSV** saves every row that matches the filters, not just the page on screen.

## From a terminal {#cli}

On the workspace machine:

```sh
fleetd audit                                  # the newest 50 rows
fleetd audit --person "Bob Okafor" --since 7d
fleetd audit --bot storefront --kind bot      # one bot's safety settings
fleetd audit --kind vault.revealed --since 2026-11-01
fleetd audit --since 30d --csv > audit.csv    # every matching row, as CSV
```

`--kind` takes one kind (`vault.revealed`) or a whole group (`vault`). `--since` and `--until` take `7d`, `24h`, `30m`, a date or a time. `--csv` writes the same file as the app's **Export CSV**.

The CSV has these columns: `time`, `person`, `actor` (`person`, `agent`, `workspace` or `staff`), `kind`, `bot`, `target`, `outcome` (`ok`, `refused` or `failed`) and `summary`.
