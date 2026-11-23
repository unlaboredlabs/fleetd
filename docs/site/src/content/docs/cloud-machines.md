---
title: fleetd's computers
description: Where agents run on fleetd cloud, and how a team picks its own machines, fleetd's computers, or both.
---

This page is for fleetd cloud teams choosing where their agents run.

Agents run in one of two places:

- **Your own machines**, directly, with nothing in between. Any hub can use them: [add a machine](/docs/machines#app).
- **fleetd's computers**, in the cloud. Only fleetd cloud teams can use them, paid with a plan or credits
  ([Billing](/docs/billing)).

A hub you run yourself uses your own machines only.

## Pick where agents run {#pick}

1. Open **Settings › Hub › Machines**.
2. Under **What runs where**, set **Linux machine**:
   - **Your machines**: agents run only on your machines.
   - **Your machines first, then fleetd's computers**: fleetd's computers take agents only once your machines are at
     their agent limit.
   - **fleetd's computers only**.

A team with no machine of its own runs everything on fleetd's computers, so there's nothing to pick.

Your own machines dial out to the team's address, as they would to a self-hosted hub. **Add machine** works the same.

## Macs {#mac}

fleetd's computers don't run Macs. To run iOS builds and simulators, add a Mac of your own as
[the agents' Mac](/docs/agents-mac).

## See what runs there {#see}

On a cloud team, **Settings › Hub › Machines** has a **fleetd's computers** group:

- Each bot that runs there, its computer awake or asleep, and its agents at work.
- How many agents run at once, of what your plan allows.
- This period's computer time against what your plan includes. Click it to open Billing.

Click a bot to open its **Computer** settings, where you pick its size.

A bot's agents and their browser, Linux desktop and Android screens all run on its computer there.
