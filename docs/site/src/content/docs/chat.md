---
title: Chat with the lead
description: Tell a project's lead what you want, reply to its questions, steer it, and follow the work in the chat.
---

You'll give a project work by chatting with its [lead](/docs/glossary#lead), the way you'd talk to an engineer.

```text
You:   the checkout button is misaligned on mobile Safari, fix it
Lead:  On it. One writer on the CSS, one reviewer after.
       ▸ 2 agents working
Lead:  Fixed in "Align the checkout button on Safari", merged.
```

Each project has one lead and one ongoing chat. Click the project in the sidebar to open it.

## Send a message {#send}

Type in the box at the bottom of the chat and press Enter. Shift+Enter adds a new line.

| You can | How |
|---|---|
| Describe work | In your own words. The lead turns it into tasks itself. |
| Attach files | Paste, drop, or attach images, text or PDF. The lead gets them with your message. |
| Paste a screenshot | Paste it into the box. |

The lead keeps its own plan and bookkeeping. You never file tasks or orders yourself.

## Reply to the lead {#reply}

The lead asks only what it really needs: product calls, money, and irreversible steps. It asks in the chat, as
numbered items with a recommendation each:

```text
Lead:  Two calls before I ship:
       1. Keep the old endpoint for a release? I'd keep it.
       2. Bump the minor version? I'd bump it.
```

Reply in plain words, or tersely:

| Reply | Means |
|---|---|
| `1 go, 2 rec` | Yes to item 1, take the recommendation on item 2. |
| `do it` | Go ahead with what it proposed. |
| `nvm` | Drop it. |
| `2: keep it for two releases` | Answer an item in your own words. |

The lead logs each answer as a [decision](/docs/glossary#decision), so it never asks the same thing twice. A project
shows a dot in the sidebar while the lead's last message waits for your reply, or a secret or approval item is open.

## Steer while it works {#steer}

A message reaches the lead at once. How depends on what the lead is doing:

| The lead is | Your message |
|---|---|
| Idle | Starts its next turn. |
| Working | Is a steer: it reads it at its next step, after the tool it is running. |
| Starting, or its machine is away | Waits, and goes in as soon as it can. The chat says why it waits. |

A small receipt under your message shows when it was taken in. See [Steering](/docs/steering).

## Follow the work {#follow}

Everything shows up in the chat, quietly:

| In the chat | Shows |
|---|---|
| The agents strip, under the lead's message | How many agents are working, one line each. Expand it for their lanes and where time went. |
| One-line events | A pull request opened, merged, or sent back. |

For a project's progress at a glance, see [Status](/docs/status). For where the time went, see
[Where time went](/docs/time-inspector).

## Secrets and risky commands {#inline}

Two things never go through plain chat text:

| Item | What you see | What you do |
|---|---|---|
| A secret the lead needs | A masked field naming the machine and where the value goes | Type the value. It never enters the chat. |
| A risky command | The exact command, why, and where it runs | Approve or Deny. |

See [Secrets & approvals](/docs/approvals-and-secrets).

## Done, checked {#done}

The lead can't just say "done". When it claims the work is finished, the hub runs the work's
[done-when checks](/docs/glossary#done-when-check) itself, and only all of them passing makes it done. A check that
needs you is one line in the chat, such as "looks good on your end?".
