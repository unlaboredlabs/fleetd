---
title: Approvals and secrets
description: Choose what the lead asks before it acts, approve commands, and give it keys safely.
---

The lead does most things without asking. This page covers what it does ask: approvals for actions that reach outside, and secrets it needs from you.

Both show as cards in the bot's chat. Only you can answer them: no agent can approve itself.

## Approval modes {#modes}

Each bot has an approval mode, under **Settings › Bots** › *your bot* › Bot › **Approvals**. It decides what happens when the lead wants to:

- send, reply, share or invite through a [connection](/docs/connections);
- open a site for the first time;
- click a final Confirm or Submit on a site.

| Mode | What happens |
|---|---|
| YOLO | Nothing asks. A new bot starts here. |
| Checker decides | A separate model checks each action. What you asked for runs; it asks you when unsure, and blocks what looks like an attack. |
| Ask me about everything | Every such action waits for you. |

Shell commands never ask in any mode. **Ran without asking**, under the mode, lists every action that ran without a card.

## What every mode refuses {#floors}

Whatever the mode:

- No moving money, trading or placing orders outside a [purchase](/docs/payments-and-sign-ins#purchases).
- No passwords, keys or tokens sent out.
- No commands that would wipe the machine, such as `rm -rf ~`.

A purchase with a card from the vault fills at the checkout without asking. Paying through a connected app or a
payment command always asks you first.

## Approve an action {#approve}

A card shows the action exactly as it will run: the tool, the recipients, the text or the command.

1. Read the card. Click **Show command** to see a command in full.
2. Click **Approve** or **Deny**. With the card focused, Enter approves and Esc denies.
3. An action that can't be undone asks once more: click **Yes, run it**.

The card folds to one line, such as "Approved, ran in 12s". Click it to see the output.

A card blocked by the checker has **Approve anyway**, which allows that exact action once.

### Hidden characters {#hidden}

Some invisible characters can make text read differently from what runs. A card shows each one as a mark like ⟨U+202E⟩ and says **Contains hidden characters**. Approve still runs the exact text.

## How the checker decides {#checker}

The checker is a fresh model with no tools. It sees the action and where each part came from, plus your recent messages. It never sees the mail or pages the lead read, so text in them can't talk it round.

It always asks you when:

- a recipient or site came only from something the lead read, not from you;
- a link carries data, such as an email address or a code;
- a share is public, or goes to more than 10 people.

If the checker fails or times out, you get the card.

## Sites {#sites}

A link you write in the chat is allowed as you send it. A site the lead finds itself goes through the mode the first time; once approved, it's allowed from then on.

## Automations you set up {#automations}

An [automation](/docs/automations) you wrote counts as your go-ahead for what its prompt names. A weekly "email the report to Dana" sends without a card each week.

An automation the lead wrote counts only after you approve its **Let it run on its own** card.

## Give a secret {#secrets}

When the lead needs an API key or a password, a card asks for it.

![A secret card in the chat](/docs/img/chat-secret.png)

1. Paste the value into the masked field.
2. Click **Save secret**.

The value is sealed on your device and saved in the bot's [Vault](/docs/vault). It never enters the chat, and the lead sees only that it's set.

Don't want to give it? Say so in the chat and the lead drops the request.

For a key every agent should have, add it to the bot's Vault yourself.

### A secret for one piece of work {#order-variables}

An agent can ask for a variable it needs. The card then says it's for that work only. The value reaches only those agents and is deleted when the work ends.

## Secrets stay hidden {#masking}

If an agent prints a secret, fleetd replaces it with `***NAME***` before the output leaves the machine. This covers command output, the agent's replies and its messages to the hub.

Only exact matches are caught. Part of a key, or the key in another encoding, can slip through, so keep secrets out of output where you can.

## Block tools for a bot {#tool-rules}

To forbid a tool for every agent of a bot, add a rule to `.fleetd/policy.yaml` in its repo:

```yaml
tools:
  deny: ["Bash(git push:*)"]
```

See [Config and files](/docs/config-and-files#policy).
