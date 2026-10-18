---
title: Approvals & secrets
section: Using fleetd
order: 60
description: The asks only a person answers, from the desktop app: commands, tool prompts, checklists and secrets.
---

These asks come to the inbox like any other, but only a person's device answers them (a human key, which the app
holds). An agent key can't, and "recs fine" or "all go" never answers them in bulk.

## Approve a command

When a lead needs an irreversible, money or credential step, it files the exact command with `fleetd gated run`. You
see the command, the reason and where it runs. Reply `<n> go` to run it or `<n> no` to refuse. The node runs exactly
the stored bytes, in the project's workspace, and the exit code and output go back to the lead.

## Tool permission prompts

Leads and tasks run with claude's permission prompts off. A session started with `thread_launch` and
`runtimeMode: approval-required` sends each prompt to you as an approve ask instead. A prompt that stays open is raised
again after 10 minutes, then every 30.

A project can answer prompts itself with rules in claude's own syntax in `.fleetd/policy.yaml`:

```yaml
tools:
  allow: ["Bash(npm test:*)", "Read"]
  deny: ["Bash(git push:*)"]
```

A deny rule wins over an allow rule. Rules apply to every session in the project; see
[Config & files](config-and-files.md#policy).

## Checklists

Some steps only you can do, such as clicking through a provider's console. The lead files them as a checklist ask
(`fleetd ask --kind do`). Reply `<n> done` once you've done them. If the ask has a check, the hub runs it, and a
failure reopens the ask with the evidence.

## Secrets

When a lead needs an API key or password, it files a secret ask that names the machine and where the value goes (an
env file line or a file). Type the value in the app. The app seals it to that machine's key (a libsodium sealed box)
and wipes what you typed. The hub relays the ciphertext without storing it, the node writes it (mode 0600), and the
lead only ever sees its fingerprint. The target machine must be online: nothing is queued.

A gated command can use a stored secret as an environment variable (`--secret-env`); the node reads it from its own
files.
