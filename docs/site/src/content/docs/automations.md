---
title: Automations
description: Run a stored prompt on a schedule, from a webhook, or with Run now. Each run becomes an order the project's lead starts on its own.
---

An automation is a prompt you keep for a project, plus what starts it:

- **Schedule**: a 5-field cron read in a time zone, such as `0 9 * * 1-5` in `Europe/Berlin` (09:00 on
  weekdays, Berlin time). The app uses your computer's zone (an edited automation keeps the one it was saved with);
  the lead and `automation_create` take any IANA zone as `tz`. `@daily`, `@hourly`, `@weekly`, `@monthly` and `@yearly` work too. Or one date and time,
  for a [one-time run](#one-time) such as a reminder.
- **Webhook**: a secret URL. A `POST` to it starts a run, and the request body goes to the lead with the prompt.
- **Run now**: from the app, or by the lead.

Each run opens an [order](/docs/glossary#workstream) for the project's lead, marked as coming from the automation. The
lead starts the work without asking you first. Reviews, the [merge train](/docs/merge-train) and
[approvals](/docs/approvals-and-secrets) still apply, as they do for any order. If the project has no lead yet, the
run starts one.

The nightly [memory refresh](/docs/what-agents-are-told#memory-refresh) is built in, not an automation: it opens
no order, and it is on the project's Instructions & memory, beside the memory it tidies (see
[below](#the-nightly-memory-refresh)).

## Manage them in the app

Open **Settings → Projects**, pick a project, then its **Automations** tab. There you can:

- **New automation**: a name, the prompt, and its triggers. While you type a cron, the editor shows it in words
  ("At 09:00, Monday to Friday (Europe/Berlin)") or says what's wrong with it.
- **Run now**: runs it at once.
- **Pause** and **Resume**: while it's paused, its schedule and webhook start nothing. Run now still works. When you
  resume it, the schedule picks up from now, and runs it missed while paused don't happen.
- **Edit**: change the name, prompt, schedule or webhook.
- **Runs**: each run's time, what started it, its state, and a link to the order it opened.
- **Delete**: removes the automation and its run history. Orders its runs opened stay.

## The nightly memory refresh

It isn't in the Automations list. The nightly memory refresh, on the project's Instructions & memory, is the hub's
own job for every project, always on, so it has no prompt to edit, no webhook, no switch and no Delete. It shows:

- **Its hour**, such as "Every night at 04:00 (Europe/Berlin)". The hour is the hub's, the same for every project.
  An admin sets it with the `policy.memory_refresh_at` decision, in the zone of `policy.tz`.
- **Next run** and **Last run**: what the last refresh changed in memory, as its chat line counts it ("2 added, 1
  updated, 1 removed"), or that it was skipped and why. A quiet day, with no chat and no order changes, is skipped.
- **Run now**: refreshes the project's memory at once, the way the night's refresh does. It doesn't start, and says
  why, while one is already running, nothing is new since the last one, the
  lead is mid-turn, or the project's machine is offline, out of usage or too old.

From an MCP client, `automation_list` returns it as `memoryRefresh`, and `memory_refresh_run` is its Run now.

You can also ask the lead in the chat ("check the dependencies every Monday morning"). It manages a project's
automations with its own tools, listed under [Agent tools](/docs/reference/agent-tools#lead-tools).

## One-time runs: reminders and follow-ups {#one-time}

Ask a project's lead "remind me at 18:00 to call mom" or "check back on the refund Friday", and it makes an automation with a
one-time schedule: `at`, one date and time such as `2026-11-03T18:00`. The lead works out the date and time from your
words; the hub doesn't read words. Left without a zone, it runs in [yours](/docs/what-agents-are-told#your-time).

- It shows in the automations list as "Once, Tue 3 Nov 2026 at 18:00 (Europe/Berlin)", with its next run, until it
  runs.
- At that time it opens an order for the lead once. The lead's message lands in the chat, so it reaches
  your phone's notifications like any reply.
- Then it is **Done**: it stays in the list with its run, and runs again only with a new time (**Edit**) or Run now.
  When a project's 50 automations are full, the oldest done one makes room for a new one.
- Delete it to cancel it before it runs. Paused, it doesn't run; resuming it after its time is refused until it has
  a new time.
- A time that has already passed is refused. Given with `Z` or an offset, it is kept as the zone's own clock time.
- If the hub was down at that time, it runs once when the hub comes back, and its order tells the lead how late it
  is, so the reminder says it comes late.
- If another run of it is still open at that time (a Run now, say), it isn't skipped for good: it waits, shown as a
  skipped run that "goes once that ends", and runs once that run's order closes, late in the same way.

From the lead's tools, `automation_create` takes `schedule: { "at": "2026-11-03T18:00" }`, with `tz` only for another
zone than the person's. From an MCP client, `automation_create` takes `{ "at": …, "tz": … }`.

## One run at a time

An automation runs once at a time. If a schedule or Run now comes in while its last run's order is still open, it
is skipped. The skip shows in the run history with the reason, for example "run … is still going (W12 is open)". Once
the order is closed, the next trigger runs.

A webhook call that comes in while a run is open is kept instead, with its body: its run shows as **Queued**. Once the
open run's order is closed or stopped, every call kept meanwhile goes to the lead in one follow-up order, with each
body, oldest first. A call that comes after the open run ended but before that order went joins it. Up to 20 calls
wait per automation (each body is at most 16 KiB); one past that is skipped. Pausing the automation skips new calls,
but calls kept before the pause still go once the open run ends.

In an [Only me](/docs/projects#only-me) project, a run closes its order by itself once the lead's turn for it ends,
whether it replied, failed or was cut off, so one run it never closed can't hold up the next ones. A run whose order
still has agents at work or PRs on the train waits for a later turn's end. In a shared project the lead closes its
runs' orders itself, as it does any order. An automation you wrote in the app, or let run on its own on the card
the lead shows you, counts as your go-ahead for what its prompt names on each run, so a weekly send doesn't ask every
week ([Approvals](/docs/projects#automations-go-ahead)).

A run's state follows its order: **Running** while the order is open, then **Done** or **Stopped**. **Queued** is a
webhook call waiting for the open run to end. **Skipped** means it came during another run or while the automation
was paused. **Failed** means the order couldn't be opened.

## When the hub was down

The schedule runs on the hub's clock. If the hub was down when a run was due, that run happens once when the hub
comes back, marked late. A hub that was down for three hours of an hourly schedule runs it once, not three times.
A run the hub stopped in the middle of, before its order opened, gets its order when the hub starts again.

## When a project goes

Removing a project deletes its automations and their run history: their schedules stop and their webhook URLs
answer `404`. Orders their runs opened stop with the project.

## Webhooks

Turn on **Webhook** when you make or edit an automation. When you save, the app shows its URL once:

```text
https://hub.example.com/hooks/au_k3Jd8sQp2xYz/<secret>
```

Copy it then: the hub keeps only a hash of the secret, so it can't show the URL again. **Rotate webhook URL** makes
a new one, and the old URL stops working at once. Turning **Webhook** off removes the URL.

Send the body you want the lead to read:

```sh
curl -X POST --data '{"alert":"disk 91% on db-2"}' "$FLEETD_WEBHOOK_URL"
```

| Answer | Meaning |
|---|---|
| `202` | A run started (`state` is `running`; the JSON has its `runId` and the `workstreamId` of its order), or, while a run is open, the call was kept (`state` is `queued`) and goes in one follow-up order once that run ends. |
| `200` | Recorded, but skipped: `state` is `skipped` and `why` says why (the automation is paused, or 20 calls already wait). |
| `404` | The URL isn't valid: a wrong secret, a rotated URL, a deleted automation, or one whose project was removed. |
| `413` | The body is over 16 KiB. |

The body goes into the order as far as it fits, and the lead can read the whole body of a run. A wrong secret is
refused, and fleetd doesn't record it: no run, no event, nothing in the hub's log. The hub never logs the secret or
the body.

The URL starts with the hub's address as `fleetd init --url` set it, and without one, the address it listens on
(`127.0.0.1:4790` unless you set it up otherwise). A service outside your network can't reach either as shown: put a
tunnel or a reverse proxy in front of the hub, and give the service that address with the same `/hooks/…` path.

## From an MCP client

A key with the operate role on the project's machine can use the same tools as the app: `automation_list`,
`automation_create`, `automation_update`, `automation_pause`, `automation_rotate`, `automation_delete`,
`automation_run` and `automation_runs`. See [MCP clients](/docs/mcp-clients).
