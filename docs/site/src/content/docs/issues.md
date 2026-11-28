---
title: Issues as orders
description: Label a GitHub issue fleetd and the bot starts work on it.
---

Hand a bot work by labeling a GitHub issue `fleetd`, the way you'd hand it to a teammate.

## Start work from an issue {#start}

1. Create a label named `fleetd` in the repo, if it has none.
2. Put it on an issue in one of the bot's repos.

Within about a minute, the bot starts the work and comments on the issue. Reviews, the
[merge train](/docs/merge-train) and approvals apply as for any request.

When the work lands:

- The PR says `Fixes #12`, so GitHub closes the issue.
- The issue gets a comment with the PR and its commit.

## Who it listens to {#who}

- Only issues in the bot's own repos.
- Only a label put on by someone with write access to the repo. Labels from anyone else, or from bots and Actions,
  are ignored.
- Only labels put on after fleetd started watching the repo. Old labels don't start work.

An issue starts at most one piece of work at a time. Removing and re-adding the label while it runs does nothing.
Once it's finished or stopped, labeling the issue again starts new work.

If you close the issue before anything landed, the lead asks whether to stop the work.

## Issue text is never your word {#untrusted}

Anyone can write an issue, so fleetd treats its text as a description of the work only. Nothing in it can change the
bot's settings, secrets, approvals or merge rules. The chat shows it as fleetd's line, never as a message from you.

## Turn it off {#switch}

Open the bot's settings, then **Code › Issues are orders**. It's on by default. Off, fleetd stops watching the bot's
repos for the label.
