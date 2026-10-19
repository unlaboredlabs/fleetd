---
title: Approvals & secrets
description: "The asks only a person can answer: commands to approve, tool prompts, checklists and secrets."
---

You'll answer the asks that only a person can answer: approve a command, tick off a checklist, or enter a secret.

These asks arrive in the inbox like any other. Only a person's device answers them, using a
[human key](/docs/glossary#human-key) that the desktop app holds. An agent key can't, and a bulk reply such as
`recs fine` or `all go` skips them.

| Ask | You see | You reply |
|---|---|---|
| [Approve a command](#approve) | The exact command, the reason, and where it runs | `<n> go` or `<n> no` |
| [Tool permission prompt](#tool-prompts) | The tool call claude wants to make | `<n> go` or `<n> no` |
| [Checklist](#checklists) | Steps only you can do | `<n> done` |
| [Secret](#secrets) | The machine and where the value goes | Type the value in the app |

## Approve a command {#approve}

When a lead needs an irreversible step, one that costs money, or one that uses a credential, it files the exact command
as a [gated command](/docs/glossary#gated-command), with the `gated_run` tool.

1. The ask shows the command, the reason and the machine.
2. Reply `<n> go` to run it, or `<n> no` to refuse.
3. The node runs exactly the stored command, in the project's workspace.
4. The exit code and output go back to the lead.

## Tool permission prompts {#tool-prompts}

Leads and tasks run with claude's permission prompts off. A session started with `thread_launch` and
`runtimeMode: approval-required` sends each prompt to you as an ask instead. A prompt that stays open is raised again
after 10 minutes, then every 30.

A project can answer prompts itself with rules in claude's own syntax, in `.fleetd/policy.yaml`:

```yaml
tools:
  allow: ["Bash(npm test:*)", "Read"]
  deny: ["Bash(git push:*)"]
```

A deny rule wins over an allow rule. The rules apply to every session in the project. See
[Config & files](/docs/config-and-files#policy).

## Checklists {#checklists}

Some steps only you can do, such as clicking through a provider's console. The lead files them as a checklist
ask.

1. Do the steps.
2. Reply `<n> done`.
3. If the ask has a check, the hub runs it. A failure reopens the ask with the evidence.

## Secrets {#secrets}

When a lead needs an API key or a password, it files a secret ask. The ask names the machine and where the value goes:
a line in an env file, or a file.

1. Type the value in the app.
2. The app seals it to that machine's key (a libsodium sealed box) and wipes what you typed.
3. The hub passes the sealed value on without storing it.
4. The node writes it with mode `0600`.
5. The lead sees only its fingerprint, never the value.

:::caution
The target machine must be online when you enter the secret. Nothing is queued.
:::

A gated command can use a stored secret as an environment variable. The node reads it from its own files.
