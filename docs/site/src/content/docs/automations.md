---
title: Automations
description: Run a prompt on a schedule or from a webhook, set reminders, and watch your software.
---

An automation is a prompt you save for a bot, run on a schedule, from a webhook, or by hand. A watcher is an automation that checks something and speaks up only when it's off.

The easiest way to make either: ask the lead. "Check the dependencies every Monday morning" or "keep an eye on our deploys".

## Make an automation {#new}

1. Open **Settings › Bots** › *your bot* › **Automations**.
2. Click **New automation**.
3. Give it a name and the prompt.
4. Pick what starts it: a schedule, a webhook, or neither (Run now only).
5. Save.

Each run hands the prompt to the lead as new work, and the lead starts it without asking. Reviews, the merge train and approvals still apply.

## Schedules {#schedule}

A schedule is a cron line in your time zone, such as `0 9 * * 1-5` for 09:00 on weekdays. The editor shows it in words as you type. `@daily`, `@hourly` and `@weekly` work too.

If the workspace was down when a run was due, it runs once when the workspace is back, marked late.

## Reminders {#one-time}

Ask the lead "remind me at 18:00 to call mom" or "check back on the refund Friday". It makes a one-time automation.

- It runs once at that time, and the lead's message reaches your phone like any reply.
- Then it shows as **Done**. Delete it beforehand to cancel.

## Manage them {#manage}

Each automation in the list has:

- **Run now:** run it at once.
- **Pause** and **Resume:** a paused one doesn't run. Missed runs are skipped.
- **Edit:** change its name, prompt or triggers.
- **Runs:** each run's time, what started it and how it went.
- **Delete:** removes it and its run history.

Only one run of an automation goes at a time. A schedule that fires while the last run is still open is skipped.

A bot holds up to 50 automations.

## Webhooks {#webhooks}

1. Turn on **Webhook** when you make or edit an automation.
2. Save, then copy the URL. It shows only once.
3. Send a `POST` to it. The request body goes to the lead with the prompt.

```sh
curl -X POST --data '{"alert":"disk 91% on db-2"}' "$FLEETD_WEBHOOK_URL"
```

- The body can be up to 16 KB.
- Calls that arrive during a run wait, up to 20, and go to the lead together afterwards.
- **Rotate webhook URL** makes a new URL; the old one stops at once.

A service outside your network needs a tunnel or reverse proxy to reach your workspace.

| Answer | Means |
|---|---|
| 202 | A run started, or the call is waiting for the current one. |
| 200 | Skipped: paused, or 20 calls already waiting. |
| 404 | Wrong or old URL. |
| 413 | Body over 16 KB. |

## Watchers {#watchers}

A watcher looks at one thing on a schedule and posts one line in the chat only when something is off. A quiet look posts nothing.

1. Open the bot's **Automations** and find **Watching** at the top.
2. Click **+**.
3. Pick what to watch:
   - **Main's CI:** failed, stuck or missing checks on the main branch.
   - **Deploys:** failed or stuck GitHub deployments.
   - **Something else:** one sentence, such as "check that shop.example is up".
4. Pick how often: every 15 minutes, hourly, or daily at 09:00.

The same problem is reported once, not on every look. Main's CI and Deploys skip the look entirely when nothing changed, so they cost nothing then.

Each watcher's row shows its last 24 hours: how many looks and what they cost. A **Something else** watcher can only read, never change anything.

## Nightly memory refresh {#the-nightly-memory-refresh}

Every night the lead tidies the bot's memory. It's built in, not an automation: find it under the bot's **Instructions & memory**, with **Run now**. See [What agents are told](/docs/memory#memory-refresh).
