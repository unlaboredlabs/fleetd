---
title: Projects & orders
section: Using fleetd
order: 50
description: Add a project, start its lead, send an order, follow it, and see how "done" is checked.
---

## Add a project

Run `fleetd init` again and pick a repo: a checkout it finds on a worker, or a GitHub URL, which it clones. The rest
of your setup stays as it is.

From an MCP client, `project_add {machineId, path, title}` adds one and `project_remove {machineId, projectId}`
forgets it (its files, branches and worktrees stay).

## Start its lead

Each project has one lead. Until it has one, orders for it wait as drafts. Start it from an MCP client:

```text
lead_start {machineId, projectId}
```

`model` and `effort` are optional and saved for the project (default `claude-opus-5-5`, high).

## Connect an MCP client

The hub's MCP endpoint is `<hub url>/mcp`. Give the client an agent key, shown once:

```console
$ fleetd hub key create --name ci-bot --role operate --machines '*'
fld_<key>
created key_tjw34bxe (fld_mwrgw4, operate:*). The key above is shown only once.
```

For Claude Code:

```sh
claude mcp add --transport http fleetd http://hub.your-tailnet.ts.net:4790/mcp --header "Authorization: Bearer fld_<key>"
```

Roles are `read`, `operate` and `admin`, on every machine (`'*'`) or a list. `fleetd hub key list` shows keys and
`fleetd hub key revoke <keyId>` ends one at once.

## Send an order

In the app, press ⌘N (Ctrl+N), type one line and press Enter. Aim it at a project, or leave it to the hub, which
reads a leading `@project`, else asks a quick router, else asks you. A prefix picks the playbook: `fix:` or `bug:`,
`research:`, `finish:`.

From an MCP client: `intake_submit {text}`.

## Follow it

The lead freezes a brief, runs writer and reviewer tasks on your workers, and puts each PR on the merge train. Follow
it on the app's Projects screen (⌘2), or with `workstream_list`, `workstream_get`, `thread_tail` and `fleetd_status`.
`events_wait` long-polls for changes instead of polling.

## Answer its questions

Questions land in the inbox (⌘1), numbered. Reply in one line, such as `1 go 2 nvm 3 b`: see
[the reply grammar](desktop-app.md#reply). Commands and secrets have their own flow:
[Approvals & secrets](approvals-and-secrets.md).

## Done, checked

The lead reports done with `fleetd claim done`. The hub then runs the brief's done-when checks itself, and only all of
them passing makes the workstream done. A failure wakes the lead with the exit code and output. `claims_list` shows
every claim with its evidence.
