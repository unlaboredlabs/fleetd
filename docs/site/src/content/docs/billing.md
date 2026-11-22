---
title: Billing
description: Plans, credits and computer time on fleetd cloud. What each costs, how credits are used, and the spend cap.
---

On fleetd cloud, a bot's agents run on your own machines or on fleetd's computers. Your own machines cost nothing.
fleetd's computers are paid for with a plan, credits, or both. There is no free tier: with no plan and no credits,
fleetd doesn't start a computer for your bots, and each waiting bot says so in its chat.

A hub you run yourself has no billing at all.

## Where {#where}

**Settings › Hub › Billing**, in the desktop app, the web app and the phone app (Settings › Billing). Only a team's
owners and admins see it. It shows:

- **Plan**: which, its price, and when it renews or ends. **Pick a plan** or **Change plan**.
- **Credits**: what is left in dollars, and the soonest credits to expire when that is within 30 days. **Add
  credits**.
- **Payment**: **Manage billing** opens Stripe's page for the card, invoices, VAT id and cancelling.
- **Computer time**: hours and dollars used this period, by computer size.
- **Spend cap**: an optional monthly limit you set.

When something needs you (a declined card, no credits left, the cap reached), one line at the top says what and how to
fix it. Paying happens on Stripe's own pages, in your browser; fleetd never sees your card.

## Plans {#plans}

| Plan | Price a month | Computer time included |
| --- | --- | --- |
| Solo | $20 | $30 (500 hours of the 2 CPU size) |
| Team | $50 | $60 |
| Scale | $200 | $260 |

A plan also sets how many agents run on fleetd's computers at once (leads never count): 3 on Solo, 10 on Team, 40
on Scale, and 3 with credits and no plan.

A plan renews each month. Its included time is used before bought credits and ends with its month: it doesn't roll
over. A plan change applies from the next month. Cancelling stops renewal; the plan lasts to the end of the month paid
for. Prices are before VAT, which Stripe adds where it applies.

## Credits {#credits}

Credits are computer time paid ahead, at face value: $10 buys $10 of time. Buy them from $10, with or without a plan.
Bought credits last 12 months from purchase. When credits expire at different times, the soonest to expire are used
first.

## Computer time {#computer-time}

Each computer is charged for the time it runs, to the millisecond, at its size's rate:

| Size | Per hour |
| --- | --- |
| 2 CPU, 4 GB | $0.06 |
| 4 CPU, 8 GB | $0.12 |
| 8 CPU, 16 GB | $0.24 |

8 CPU, 16 GB is the largest size for now. Time is counted per team, from the moment a computer starts to the moment
it stops.

## When computers stop {#stops}

The rules are fixed, never a guess:

- **No credits left.** Running computers stop and new ones wait. Add credits or pick a plan, and they start again.
- **Spend cap reached.** If you set a monthly cap, computers stop when this calendar month's spend (UTC) reaches it,
  and start again at the next month or when you raise the cap. Leave the cap empty for none.
- **Declined card.** Nothing stops at once. The plan lasts to the end of the month paid for; update the card in
  **Manage billing** before then to keep it.

Bots on your own machines are never stopped by billing.
