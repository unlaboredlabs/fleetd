---
title: Projects & orders
description: Add a project, send it an order, follow the order, and see how "done" is checked.
---

You'll add a repo as a [project](/docs/glossary#project), send it work, and follow that work to merged pull requests.

## Add a project {#add-a-project}

1. Add a GitHub repo. fleetd clones it onto a worker:

   ```sh
   fleetd project add https://github.com/acme/storefront
   ```

   Expected output:

   ```text
   cloning into /home/me/src/storefront on devbox
     starting
     receiving
     resolving
     inspecting
   ✓ ~/src/storefront cloned and added on devbox
   Lead needs: no CI found: the merge train will only use local checks
   Default branch: main
   CI: none; required checks: none
   Merge: unprotected, squash allowed
   ```

2. Read the `Lead needs:` line. It names anything to fix on GitHub before the first pull request, such as
   `squash merges are off on acme/storefront`.

### What you can pass

| You pass | fleetd does |
|---|---|
| A GitHub URL or `owner/repo` | Clones it onto the least busy online worker, into `~/src` (or `~/code`, `~/projects`). |
| A path, such as `~/src/storefront` | Adds that existing checkout on this machine. |
| Nothing, in a terminal | Lists checkouts on every worker and your repos from `gh repo list`, to pick from. |

| Option | Does |
|---|---|
| `--machine <id>` | Clone to, or look for the path on, that worker. |
| `--dest <dir>` | Clone into that folder. |
| `--use-existing` | Add the folder's checkout when it already holds the same repo. Without a terminal, this is how you accept it. |

fleetd reads GitHub through `gh` on the hub machine. A private repo clones on any worker where `gh auth login` was run.
When something is in the way, such as an offline worker or a folder that exists, it prints the command that fixes it.

### List and remove projects

```sh
fleetd project list
fleetd project remove devbox/storefront
```

`remove` stops the project's agents and forgets it. Its files, branches and worktrees stay.

## Its lead {#its-lead}

Each project has one [lead](/docs/glossary#lead). The project's first order starts it: there is nothing to start by
hand.

If the lead can't start, the order waits and the app says why. Common causes:

| Cause | Fix, on the worker |
|---|---|
| `claude` is logged out | `claude auth login` |
| `claude` is outside the supported versions | See [claude versions](/docs/troubleshooting#claude) |
| The worker is offline | See [Machines](/docs/troubleshooting#machines) |

Once the worker is back with a working `claude`, the lead starts and picks up every waiting order.

To pick the lead's model and effort, or start it before any order, call `lead_start {machineId, projectId, model,
effort}` from an [MCP client](/docs/mcp-clients). The default is `claude-opus-5-5` at high effort.

To keep a lead from starting by itself, set `lead.autoStart: false` in the project's
[policy file](/docs/config-and-files#policy). Orders then wait for `lead_start`.

## Send an order {#send}

In the desktop app, type one line in the board's order box and press Enter. See [Give work](/docs/desktop-app#composer).

```text
@storefront fix: checkout button is misaligned on mobile Safari
```

| Part | Means |
|---|---|
| `@storefront` | Optional. The project. Without it, the hub picks one or asks you. |
| `fix:` | Optional. The [playbook](/docs/glossary#playbook): `fix:` or `bug:`, `research:`, `finish:`. The default is a feature. |
| The rest | What you want, in your words. |

You can attach screenshots or files, and `@`-mention files, orders and PRs. The lead gets them with the order.

From an MCP client, `intake_submit {text}` sends an order, and `intake_preview {text}` shows where it would go.

## Follow it {#follow}

The lead writes a [brief](/docs/glossary#brief), runs writer and reviewer tasks on your workers, and puts each pull
request on the [merge train](/docs/glossary#merge-train).

- The board shows every order's phase and live agents.
- Open an order to see its PRs, checks and the lead's conversation. See [Follow an order](/docs/desktop-app#order).
- From a terminal: `fleetd status W41`. See [Status](/docs/status).

## Change or stop it {#steer}

| You want to | In the order view | The lead |
|---|---|---|
| Add something | Type it, press Enter | Reads it at its next step. |
| Redirect it now | Type it, press ⌘Enter (Ctrl+Enter) | Stops its current step and reads it at once. |
| Stop the order | "Stop", then confirm | Cancels running and queued agents, withdraws its asks. Merged PRs stay. |

A stopped order stays stopped. To retry, send it again as a new order. You can steer any agent, not only the lead: see
[Steering](/docs/steering).

## Answer its questions {#answer}

Questions land in the inbox (⌘I), numbered. Reply in one line, such as `1 go 2 nvm 3 b`. See
[the reply format](/docs/desktop-app#reply). Commands and secrets have their own flow:
[Approvals & secrets](/docs/approvals-and-secrets).

## Done, checked {#done}

1. The lead calls `claim_done`.
2. The hub runs the brief's done-when checks itself.
3. Only all of them passing makes the order done. A failure wakes the lead with the exit code and output.

`claims_list` shows every claim with its evidence.

A done order cleans up after itself:

- Its pull requests still waiting (queued, in review, needing a rebase, or with failed CI) are closed on GitHub with a
  comment saying why.
- Its leftover tasks are cancelled.
- A pull request the train is already rebasing, checking or merging is left to land.
