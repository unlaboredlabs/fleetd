---
title: Secrets & approvals
description: Enter a secret and approve a risky command, the two things that show as items inside the lead's chat.
---

You'll enter a secret a lead needs, and approve or deny a command it wants to run. Both show as items inside the
project's chat, because plain chat text can't carry them safely.

| Item | You see | You do |
|---|---|---|
| [Secret](#secrets) | A masked field naming the machine and where the value goes | Type the value |
| [Approval](#approve) | The exact command, the reason, and where it runs | Approve or Deny |

Only a person's device can act on them, using a [human key](/docs/glossary#human-key) that the desktop app holds. An
agent key can't, so no agent can approve itself.

Everything else the lead needs from you is a plain question in the chat. See
[Reply to the lead](/docs/chat#reply).

## Approve a command {#approve}

When a lead needs an irreversible step, one that costs money, or one that uses a credential, it files the exact
command as a [gated command](/docs/glossary#gated-command).

![An approval item in storefront's chat: the lead says the command writes to the production database; the Command card, marked "Can't be undone", shows the migration command on devbox with the secret it gets, and Approve and Deny. Above it, an earlier run that exited 0 and a denied permission request.](/docs/img/chat-command.png)

1. The item shows the command, the reason and the machine.
2. Click Approve to run it, or Deny to refuse. A denial can carry a note for the lead.
3. The node runs exactly the stored command, in the project's workspace.
4. The exit code and output go back to the lead, and the item shows them.

If the machine was offline when you approved, the item opens again and says why. Click "Approve again" once it is
back.

## Enter a secret {#secrets}

When a lead needs an API key or a password, it asks with `request_secret`, and the item names the machine and where
the value goes: a line in an env file, or a file.

![A secret item in storefront's chat: the lead needs the Stripe test key, which goes to devbox only. The card names where it is saved, with a masked field and Save secret. Above it, a secret already saved, and the agents at work.](/docs/img/chat-secret.png)

1. Type the value in the masked field.
2. The app seals it to that machine's key (a libsodium sealed box) and wipes what you typed.
3. The hub passes the sealed value on without storing it.
4. The node writes it with mode `0600`.
5. The lead sees only its fingerprint, never the value. The value never enters the chat.

:::caution
The target machine must be online when you enter the secret. Nothing is queued.
:::

If you don't want to give a secret, or a command isn't needed after all, say so in the chat; the lead takes the request
back.

A gated command can use a stored secret as an environment variable. The node reads it from its own files.

From an MCP client, a secret is entered with `secret_submit` and an item is answered with `approval_answer`. Both
take only a human key. `requests_list` lists every secret and approval request with its state.

## Tool permission rules {#tool-rules}

Leads and tasks run with claude's permission prompts off. A session started with `thread_launch` and
`runtimeMode: approval-required` sends each prompt to the chat as an approval item instead: the tool it wants to use and
a summary of its input, with Approve and Deny.

A project can also allow or deny tools for every session, with rules in claude's own syntax in `.fleetd/policy.yaml`:

```yaml
tools:
  allow: ["Bash(npm test:*)", "Read"]
  deny: ["Bash(git push:*)"]
```

A deny rule wins over an allow rule. See [Config & files](/docs/config-and-files#policy).
