---
title: Billing
description: Plans, credits and computer time for fleetd's computers on fleetd cloud, and the spend cap.
---

On fleetd cloud, you pay only for agents that run on fleetd's computers. Agents on your own machines are free, and a
hub you run yourself has no billing at all.

## Where {#where}

Owners and admins open **Settings › Team › Billing** in the desktop, web or phone app. It shows:

- **Plan**: your plan, with **Pick a plan** or **Change plan**.
- **Credits**: what's left, with **Add credits**.
- **Computer time**: hours and cost so far this month.
- **Spend cap**: an optional monthly limit.
- **Manage billing**: Stripe's page for your card, invoices and cancelling.

Payment happens on Stripe's pages; fleetd never sees your card. The seller is Unlabored Labs, Inc.

The iPhone app shows the plan, credits, computer time and spend cap, but buys nothing: plans and credits are bought in
the desktop or web app.

## Plans {#plans}

| Plan | Per month | Computer time included | Agents at once |
|---|---|---|---|
| Solo | $20 | $30 | 25 |
| Team | $50 | $60 | 100 |
| Scale | $200 | $260 | 300 |

- Leads don't count toward agents at once. With credits and no plan, it's 25.
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

## When computers stop {#stops}

- **No credits left**: running computers stop and new ones wait, until you add credits or pick a plan.
- **Spend cap reached**: computers stop until next month (UTC), or until you raise the cap.
- **Card declined**: nothing stops right away. The plan lasts to the end of the paid month; update the card in
  **Manage billing** before then.

Bots on your own machines are never stopped by billing.
