---
title: Automations
description: Run a stored prompt on a schedule, from a webhook, or with Run now. Each run becomes an order the project's lead starts on its own.
---

An automation is a prompt you keep for a project, plus what starts it:

- **Schedule**: a 5-field cron read in an IANA time zone, such as `0 9 * * 1-5` in `Europe/Berlin` (09:00 on
  weekdays, Berlin time). `@daily`, `@hourly`, `@weekly`, `@monthly` and `@yearly` work too.
- **Webhook**: a secret URL. A `POST` to it starts a run, and the request body goes to the lead with the prompt.
- **Run now**: from the app, or by the lead.

Each run opens an [order](/docs/glossary#workstream) for the project's lead, marked as coming from the automation. The
lead starts the work without asking you first. Reviews, the [merge train](/docs/merge-train) and
[approvals](/docs/approvals-and-secrets) still apply, as they do for any order. If the project has no lead yet, the
run starts one.

## Manage them in the app

Open **Settings → Automations** and pick a project. There you can:

- **New automation**: a name, the prompt, and its triggers. While you type a cron, the editor shows it in words
  ("At 09:00, Monday to Friday (Europe/Berlin)") or says what's wrong with it.
- **Run now**: runs it at once.
- **Pause** and **Resume**: while it's paused, its schedule and webhook start nothing. Run now still works. When you
  resume it, the schedule picks up from now, and runs it missed while paused don't happen.
- **Edit**: change the name, prompt, schedule or webhook.
- **Runs**: each run's time, what started it, its state, and a link to the order it opened.
- **Delete**: removes the automation and its run history. Orders its runs opened stay.

You can also ask the lead in the chat ("check the dependencies every Monday morning"). It manages a project's
automations with its own tools, listed under [Agent tools](/docs/reference/agent-tools#lead-tools).

## One run at a time

An automation runs once at a time. If a trigger comes in while its last run's order is still open, that trigger is
skipped. The skip shows in the run history with the reason, for example "run … is still going (W12 is open)". Once
the order is closed, the next trigger runs.

A run's state follows its order: **Running** while the order is open, then **Done** or **Stopped**. **Skipped**
means it came during another run or while the automation was paused. **Failed** means the order couldn't be opened.

## When the hub was down

The schedule runs on the hub's clock. If the hub was down when a run was due, that run happens once when the hub
comes back, marked late. A hub that was down for three hours of an hourly schedule runs it once, not three times.

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
| `202` | A run started; the JSON has its `runId` and the `workstreamId` of its order. |
| `200` | Recorded, but skipped: `state` is `skipped` and `why` says why (a run is still open, or it's paused). |
| `401` | The URL isn't valid: a wrong secret, a rotated URL, or an automation that doesn't exist. |
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
