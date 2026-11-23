---
title: Status
description: See what every bot is doing, in the app or the terminal.
---

Status tells you at a glance which bots are working, which wait on you, and where each piece of their work stands.

## In the app {#app}

The sidebar marks each bot that needs attention: **reply**, **approve**, **secret**, **blocked** or **CI red**. The bar at the top of its chat says why. See [What needs you](/docs/chat#needs-you).

The panel's **Agents** and **Shipping** tabs show the work itself.

## In the terminal {#cli}

On the hub machine, run:

```console
$ fleetd status
storefront: working
  1 in review · 2 working · 1 landing · 9 done · 2 agents · merged Webhook outbox #208 13:12
  in review: Cart page keeps its scroll position (#216)
  working: Currency export for invoices
  landing: Search index warms on deploy (#210)
```

- `fleetd status storefront` shows one bot.
- `--watch` keeps it on screen and updates it.
- `--json` prints JSON.
- `--hub <url> --key-file <path>` reads a hub on another machine.

## Bot states {#states}

- **waiting on you:** a question, an approval or a secret.
- **blocked:** something outside the work stops it, such as an offline machine, a usage limit or a full disk.
- **working:** agents are running.
- **idle:** nothing is happening.

## Work groups {#groups}

Each piece of work sits in one group:

| Group | Means |
|---|---|
| Waiting on you | Only you can move it. |
| In review | Its pull request is with the reviewer. |
| Working | An agent is on it. |
| Landing | Reviewed; the merge train is merging it. |
| Idle | Nothing runs on it, such as a PR sent back with failing CI. |
| Done | Merged in the last 7 days. |

## Red checks on main {#red-main}

A check failing on the main branch doesn't block the bot. Status shows a warning instead, such as "`ios sessions` is red on main, fix in progress", and the sidebar marks the bot **CI red**.

## Machines {#machines}

A bot whose machine is offline shows as **blocked**, with the machine named. Its messages wait and go in once the machine is back. See [Machines](/docs/machines).

## Out-of-date data {#stale}

Status never shows old data as live. If a machine, GitHub or the merge train goes quiet, the row says **STALE**, with why and since when.
