---
title: Glossary
description: fleetd's words in one line each, with the page that covers them.
---

fleetd's own words, A to Z.

## Agent {#agent}

A Claude or Gemini session doing one job for a bot: a writer changes code and opens a pull request, a reviewer checks
one. The lead starts them. See [Steering](/docs/steering).

## Agents' Mac {#agents-mac}

One Mac that lends Xcode builds and iOS simulators to every bot's agents. See [The agents' Mac](/docs/agents-mac).

## Approval {#approval}

A command an agent wants to run that waits for your Approve or Deny in the chat. See
[Secrets & approvals](/docs/approvals-and-secrets).

## Automation {#automation}

A prompt that runs on a schedule, a date, a webhook or Run now, and gives the lead a new order each time. See
[Automations](/docs/automations).

## Bot {#project}

One chat with one lead, plus a folder that holds zero or more git repos. See [Bots](/docs/bots).

## Hub {#hub}

The server that keeps every bot, chat and setting. You run it yourself, or fleetd cloud runs it for you. See
[How fleetd works](/docs/how-fleetd-works).

## Lead {#lead}

The agent you chat with in a bot. It plans the work, starts other agents and reports back. See
[Chat with the lead](/docs/chat).

## Machine {#worker}

A computer agents run on: one of yours with fleetd installed, or one of fleetd's computers on fleetd cloud. See
[Machines](/docs/machines).

## Merge train {#merge-train}

fleetd's queue that merges a repo's pull requests once CI passes. See [Merge train](/docs/merge-train).

## Order {#order}

One piece of work you asked a lead for, such as "add dark mode". The lead opens and closes it; you never file one.

## Pairing code {#pairing-code}

A one-time code, such as `K4QW-7RNP`, that connects an app or a new machine to a hub. See
[People & invites](/docs/people).

## Screen {#screen}

A browser, Linux desktop, Android emulator or iOS simulator an agent uses. You can watch it live and take it over.
See [Screens](/docs/browser-sessions).

## Skill {#skill}

A saved workflow (`SKILL.md`) an agent follows when it fits. See [Skills](/docs/skills).

## Steer {#steer}

To write to a lead or agent while it works, such as "skip the docs page". See [Steering](/docs/steering).

## Vault {#vault}

fleetd's store of logins, cards, addresses and variables that agents fill in without seeing them. See
[Vault](/docs/vault).
