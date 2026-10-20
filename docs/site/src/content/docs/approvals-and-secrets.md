---
title: Approvals & secrets
description: "The two things a lead can't ask in chat: a command to approve and a secret to enter."
---

A lead asks its questions in the project's chat, and you answer in your own words. Two things can't go through chat
safely, so they show up in it as their own items: a command to approve, and a secret to enter.

Only a person's device answers them, using a [human key](/docs/glossary#human-key) that the desktop app holds. An agent
key can't.

| In the chat | You see | You do |
|---|---|---|
| [Approve a command](#approve) | The exact command, the reason, and where it runs | Approve or Deny |
| [Tool permission prompt](#tool-prompts) | The tool call claude wants to make | Approve or Deny |
| [Secret](#secrets) | The machine and where the value goes | Type the value into the masked field |

## Approve a command {#approve}

When a lead needs an irreversible step, one that costs money, or one that uses a credential, it asks to run the exact
command as a [gated command](/docs/glossary#gated-command), with the `gated_run` tool.

1. The chat shows the command, the reason and the machine.
2. Approve runs it; Deny refuses it, with an optional note to the lead.
3. The node runs exactly the stored command, in the project's workspace.
4. The exit code and output go back to the lead.

If the machine was offline, nothing ran: the item opens again so you can approve it once the machine is back.

## Tool permission prompts {#tool-prompts}

Leads and tasks run with claude's permission prompts off. A session started with `thread_launch` and
`runtimeMode: approval-required` sends each prompt to you in the project's chat instead. A prompt that stays open is raised again
after 10 minutes, then every 30.

A project can answer prompts itself with rules in claude's own syntax, in `.fleetd/policy.yaml`:

```yaml
tools:
  allow: ["Bash(npm test:*)", "Read"]
  deny: ["Bash(git push:*)"]
```

A deny rule wins over an allow rule. The rules apply to every session in the project. See
[Config & files](/docs/config-and-files#policy).

## Secrets {#secrets}

When a lead needs an API key or a password, it asks for it with `request_secret`. The chat names the machine and where
the value goes: a line in an env file, or a file.

1. Type the value into the masked field. It never enters the chat's history.
2. The app seals it to that machine's key (a libsodium sealed box) and wipes what you typed.
3. The hub passes the sealed value on without storing it.
4. The node writes it with mode `0600`.
5. The lead sees only its fingerprint, never the value.

:::caution
The target machine must be online when you enter the secret. Nothing is queued.
:::

A gated command can use a stored secret as an environment variable. The node reads it from its own files.

If you don't want to give a secret, say so in the chat; the lead takes the request back.
