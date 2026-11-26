---
title: Billing
description: Plans, credits and computer time for fleetd's computers on fleetd cloud, the spend cap and its warnings, and spend limits per person or bot.
---

On fleetd cloud, you pay only for agents that run on fleetd's computers. Agents on your own machines are free, and a
workspace you run yourself has no billing at all.

## Where {#where}

Owners and admins open **Settings › Workspace › Billing** in the desktop, web or phone app. It shows:

- **Plan**: your plan, with **Pick a plan** or **Change plan**.
- **Credits**: what's left, with **Add credits**.
- **Computer time**: hours and cost so far this month.
- **Spend cap**: an optional monthly limit, and its warnings.
- **Spend limits**: the limits set for a person or a bot, and what each spent this month.
- **Manage billing**: Stripe's page for your card, invoices and cancelling.

Payment happens on Stripe's pages; fleetd never sees your card. The seller is Unlabored Labs, Inc.

The iPhone app shows the plan, credits, computer time, spend cap and spend limits, but buys nothing: plans and credits
are bought, and limits set, in the desktop or web app.

## Plans {#plans}

| Plan | Per month | Computer time included | Agents at once |
|---|---|---|---|
| Solo | $20 | $30 (500 hours) | 25 |
| Team | $50 | $60 (1,000 hours) | 100 |
| Scale | $200 | $260 (4,300 hours) | 300 |

- Leads don't count toward agents at once. With credits and no plan, it's 25.
- Hours are on the smallest computer, at $0.06 an hour; a bigger one uses the same dollars faster.
- Included time is used before credits, and doesn't roll over.
- A plan change applies from the next month. Cancelling stops renewal at the end of the paid month.
- Prices are in US dollars, plus VAT where it applies, shown at checkout.

There's no free tier: with no plan and no credits, fleetd's computers don't start.

## Credits {#credits}

Credits are computer time paid ahead: $10 buys $10 of time. Buy them from $10, with or without a plan. They last 12
months, and the ones that expire first are used first.

## Computer time {#computer-time}

Each computer is billed for the time it runs, by size:

| Size | Per hour |
|---|---|
| 2 CPU, 4 GB | $0.06 |
| 4 CPU, 8 GB | $0.12 |
| 8 CPU, 16 GB | $0.24 |

## Spend warnings {#warnings}

Owners and admins get an email, and each bot on fleetd's computers a line in its chat, when this month's spend reaches
50%, 80% and 100% of the spend cap, and when the credits left cover about a day. Each goes once a month. The latest
also shows at the top of Billing.

Warnings are on for every workspace. Turn them off with **Spend warnings** under the spend cap.

## Spend limits {#limits}

A spend limit caps one person's work or one bot on fleetd's computers for the month. Reaching it stops only that
work; the rest of the workspace carries on.

- **A person**: Settings › Workspace › People, then **Spend limit…** in their row's menu. Each row shows what that
  person's work spent this month. A person's spend is what the orders they started used.
- **A bot**: its settings (Settings › the bot › **Spend limit**). Only bots on fleetd's computers have one.
- **All of them**: Billing lists every limit set, and opens where each is set.

Members don't see others' limits. A member with a limit sees theirs, and this month's spend against it, in Settings ›
You › **Workspaces & devices**.

## When computers stop {#stops}

- **No credits left**: running computers stop and new ones wait, until you add credits or pick a plan.
- **Spend cap reached**: computers stop until next month (UTC), or until you raise the cap.
- **A spend limit reached**: only that person's work or that bot stops, until next month or until the limit is raised.
- **Card declined**: nothing stops right away. The plan lasts to the end of the paid month; update the card in
  **Manage billing** before then.

Bots on your own machines are never stopped by billing.
