---
title: How fleetd works
description: The parts of fleetd, and how a request goes from the chat to a merged pull request.
---

This page explains fleetd's parts and what happens after you ask a bot for something. Words in bold are in the
[Glossary](/docs/glossary).

## The parts

- **Bot**: one chat with one **lead**, plus a folder that holds zero or more git repos. You make one bot per product
  or area of work.
- **Lead**: the agent you talk to. It plans the work, starts other agents, and tells you when it's done.
- **Agents**: the lead's helpers. Writers change code and open pull requests; reviewers check them.
- **Hub**: the server that keeps every bot, chat and setting. You run it yourself, or use fleetd cloud, where we run it.
- **Machines**: the computers agents run on. Your own machines connect out to the hub, so they need no open port. On
  fleetd cloud, agents can also run on fleetd's computers.
- **Apps**: the desktop app, the phone app and, on fleetd cloud, the web app. All of them talk to the hub.

## From a message to a merge {#flow}

1. You write to a bot's lead, such as `fix the typo in the README`.
2. The lead opens an **order** for it: the request, and what "done" means.
3. It starts writers. Each works on its own branch and opens a pull request.
4. A reviewer checks each pull request.
5. The **merge train** merges it once CI passes, or waits for you if you merge yourself.
6. The lead checks the result, closes the order and tells you in the chat.

In a bot with no repo, the lead does the work itself, such as research or a report.

## When the lead needs you

The lead asks only about real choices: product calls, money, and steps that can't be undone. Its questions come as
numbered items with a recommendation, so a short reply like `1 go, 2 rec` works. A bot waiting on you shows a mark in
the sidebar.

You can write at any time, even while agents work. See [Steering](/docs/steering).

## Self-hosted or fleetd cloud

The product is the same. The difference is who runs the hub and where agents can run.

| | Self-hosted | fleetd cloud |
|---|---|---|
| Who runs the hub | You | Unlabored Labs, Inc., on servers in the EU |
| Agents run on | Your machines | Your machines, fleetd's computers, or both |
| Apps | Desktop, phone | Desktop, phone, web |
| Cost | Free | Plans from $20 a month; see [Billing](/docs/billing) |

You can start self-hosted and [move to the cloud](/docs/moving-a-hub#cloud) later. Your bots and their history come
with you.
