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

![The storefront project's chat: you asked to round the cart totals once, the lead replied that writers are splitting the change into three PRs, and under its message the strip shows three agents working. In the sidebar, billing has the needs-you dot.](/docs/img/chat.png)

## Send a message {#send}

Type in the box at the bottom of the chat and press Enter. Shift+Enter adds a new line.

| You can | How |
|---|---|
| Describe work | In your own words. The lead turns it into tasks itself. |
| Attach files | Paste, drop, or attach images, text or PDF. The lead gets them with your message. |
| Paste a screenshot | Paste it into the box. |

The lead keeps its own plan and bookkeeping. You never file tasks or orders yourself.

## From a terminal {#terminal}

`fleetd chat` sends the same message as the box, and `fleetd chat history` reads the chat:

```sh
fleetd chat devbox/storefront "fix the checkout button" --follow --key-file ~/.fleetd/human.key
fleetd chat history storefront --key-file ~/.fleetd/human.key
```

`--wait` prints the lead's reply when its turn ends; `--follow` streams it as it is written. The key says who writes:
with your [human key](/docs/glossary#human-key) it writes as you. Make one once with
`fleetd hub key create --human --name terminal --out ~/.fleetd/human.key`. Each message says where you wrote it:
"You · app" or "You · cli".

An agent or script can write too, with a key of its own:

```sh
fleetd hub key create --agent nightly-ci
fleetd chat devbox/storefront "the nightly build is red" --key-file ~/.fleetd/hub/keys/nightly-ci.key
```

The first command writes the key to a new file only you can read and prints the file's path, never the key. The
agent's messages show as "Agent · nightly-ci", and the lead takes them as input, never as yours: an agent can't
approve a command, enter a secret, steer or stop, and the chat keeps waiting on you. Each agent key sends at most 10
messages a minute. A project's own lead and agents talk to each other through their fleetd tools, not its chat.

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
| Starting, or its machine is away | Is held, and goes in as soon as it can. The chat says why it waits. |

A message is never lost: if it can't be delivered, it stays held, the chat says why, and fleetd keeps trying.

A small receipt under your message shows when it was taken in. See [Steering](/docs/steering).

## Follow the work {#follow}

Everything shows up in the chat, quietly:

| In the chat | Shows |
|---|---|
| The agents strip, under the lead's message | How many agents are working, one line each. Expand it for their lanes and where time went. |
| One-line events | A pull request opened, merged, or sent back. |

For a project's progress at a glance, see [Status](/docs/status). For where the time went, see
[Where time went](/docs/time-inspector).

## Earlier work {#history}

Work from before the chat existed shows at the top of each project's chat, under "From before this chat": what you
asked for, the lead's replies, and how each piece of work ended, such as "Done: 2 PRs merged." or "Stopped by you; kept
for later." Nothing was moved or deleted. Scroll up to read it.

![The top of storefront's chat under "From before this chat": your earlier requests as messages, the lead's replies, and one-line outcomes such as "Done: 2 PRs merged." and "Stopped by you; kept for later."](/docs/img/chat-history.png)

## Stop everything {#stop}

To stop all of a project's work at once, say "stop" in the chat, or run:

```sh
fleetd project stop devbox/storefront
```

From an MCP client, call `project_stop`. Every running and queued agent is stopped, and the lead says so in the chat. Merged pull requests stay, and so do the lead and the
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
