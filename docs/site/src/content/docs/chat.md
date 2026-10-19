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

<!-- TODO(screenshot): chat.png, a lead's reply with the agents strip, and secret and approval items, captured by the
cutover pipeline (app/desktop/qa/site.ts) once the chat screens are registered. -->

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
| Working | Is a steer: it reads it at its next step, after the tool it is running. The box says so while you type. |
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

## Stop everything {#stop}

To stop all of a project's work at once, say "stop" in the chat. From an MCP client, call `project_stop`. Every running
and queued agent is stopped, and the lead says so in the chat. Merged pull requests stay, and so do the lead and the
chat: write again to start new work.

## Secrets and risky commands {#inline}

Two things never go through plain chat text:

| Item | What you see | What you do |
|---|---|---|
| A secret the lead needs | A masked field naming the machine and where the value goes | Paste or type the value and click "Save secret". It never enters the chat. |
| A risky command | The exact command, why, and where it runs | Approve or Deny. |

See [Secrets & approvals](/docs/approvals-and-secrets).

## Done, checked {#done}

The lead can't just say "done". When it claims the work is finished, the hub runs the work's
[done-when checks](/docs/glossary#done-when-check) itself, and only all of them passing makes it done. A check that
needs you is one line in the chat, such as "looks good on your end?".

Work never closes over something that hasn't landed: a writer still at work or failed (a review's fix, say), or a pull
request not merged yet. The lead says so in the chat and claims again once it lands. If some of it is truly not
needed, the lead closes over it on purpose and tells you why; the record keeps what was dropped and why.

When work is done, its pull requests still waiting are closed on GitHub with a comment saying why, and its leftover
agents stop, except writers whose work hasn't landed, which keep going.
