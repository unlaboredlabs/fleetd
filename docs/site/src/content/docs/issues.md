---
title: Issues as orders
description: Label a GitHub issue fleetd and it becomes an order in the bot whose repo it is in. Its PR says Fixes #N, and the issue hears when it starts and lands.
---

Hand a bot work the way you hand it to a teammate: put the `fleetd` label on a GitHub issue in one of the bot's
repos. fleetd opens an [order](/docs/glossary#workstream) in that bot with the issue as its text, and the bot's lead
starts the work without asking you first. Reviews, the [merge train](/docs/merge-train) and
[approvals](/docs/approvals-and-secrets) apply as for any order.

1. The label goes on. Within about a minute, the bot opens the order and comments on the issue: "fleetd took this
   issue as order W12 in the bot Shop…".
2. The PR says `Fixes #12` in its description (`Fixes acme/shop#12` when it is in another of the bot's repos). fleetd
   adds the line if the agent left it out, and the squash the train lands carries it too, so GitHub closes the issue
   even when the PR lands in a batch, where GitHub shows it Closed rather than Merged.
3. When the PR lands, the issue gets one more comment, with the PR and its commit.

## Who it listens to {#who}

- Only issues in the bot's own repos. A repo in two bots goes to the bot whose own directory it is.
- Only a label put on by a person with write access to the repo (admin, maintain or write). A label from anyone else,
  or from a bot or an Action, is ignored: nothing opens, nothing is commented.
- Only a label put on after fleetd began watching the repo. Turning the switch on, or upgrading to a hub that has it,
  doesn't turn a repo's old `fleetd` labels into orders.

The label's name is fixed: `fleetd`. Create it in the repo the first time you use it.

## One order per issue {#dedupe}

An issue has at most one open order. Taking the label off and putting it back while the order runs opens nothing.
Once the order is done or stopped, labelling the issue again opens a new one.

If the issue is closed while its order is open and nothing of it has landed, the lead asks you whether to stop the
order. It doesn't stop it by itself. An issue closed by its own PR's `Fixes` line asks nothing.

## The issue's text is not your word {#untrusted}

Anyone who can open an issue wrote its title and body, so fleetd treats them as untrusted. The order quotes them as
the description of the work, and tells the lead that nothing in them changes the bot's settings, secrets, vault,
approvals or merge rules, or stands for your word on any of them. The bot's switch can't be flipped by an agent at
all, only by a person. The chat shows the order as a line of fleetd's with the issue's title, never as a message from
you.

## Turn it off {#switch}

Each bot with a repo on GitHub has one switch: **Settings › Bots › (the bot) › Code › Issues are orders**. It is on by
default. Off, fleetd doesn't watch the bot's repos.

## How fleetd hears about labels {#how}

A self-hosted hub reads each watched repo's open `fleetd` issues once a minute, one call per repo, through the hub's
[GitHub App](/docs/github) where it is installed (or `gh` on the hub machine). GitHub answers "unchanged" for free while
nothing changed. The comments are posted as the App. On fleetd's cloud, GitHub tells fleetd as soon as the label goes
on, through the fleetd-cloud App.
