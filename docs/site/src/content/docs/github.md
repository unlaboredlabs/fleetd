---
title: GitHub App
description: Give the hub a GitHub App of its own, created from one button with nothing to paste. The merge train works as the App, and each person's PRs open as them.
---

The hub works on GitHub as a GitHub App of its own: the merge train's reads, rebases, `fleetd/train` statuses and
merges, and the PR pages. Each hub makes its own App. fleetd is open source and has no shared App, so the App and its
keys are yours.

Each person connects their own GitHub account through the same App, and the PRs agents open for the orders they start
open as them.

Without an App, the hub runs `gh` as it is logged in on the hub machine (`gh auth login`), and agents use each
machine's own login, as before. With one, a repository the App is installed on uses the App and people's own accounts,
and any other repository still uses those logins.

## Create it {#create}

On an owner's or admin's app: **Settings › Hub accounts › GitHub**.

1. Choose where the App lives: your account, or an organization you administer.
2. Check its name: by default "fleetd on" and the hub's name. App names are unique on GitHub, so GitHub asks for
   another one on its form if the name is taken.
3. Press **Create GitHub App**. Your browser opens GitHub's form, filled in. Press **Create GitHub App** there.

GitHub sends you back to the fleetd app, and the hub fetches the App's private key and secrets from GitHub directly.
The hub seals them to its own key, in the hub's home. No person ever sees them, and no fleetd call returns them.

It works on any hub, plain HTTP included. The app catches GitHub's answer on this computer (`127.0.0.1`), as it does
for [Google](/docs/google/).

From a terminal on the hub machine, with no desktop app:

```sh
fleetd github-app create              # on your account
fleetd github-app create --org acme   # in an organization
```

It opens a page on `127.0.0.1` that sends GitHub the App's manifest. With no browser on the hub machine, forward the port
from your computer first. The command prints the `ssh -L` line to use.

## Install it {#install}

Press **Install it on repositories**, and pick the repositories fleetd works on: all of them, or chosen ones. You can
add more later from the same button. Then press **Test**.

Test asks GitHub for a token for each installation, and says where the App reaches:

```text
"fleetd on devbox" is installed on acme (2 repositories), and its tokens work.
```

`fleetd github-app test` does the same from the hub machine.

## What it asks for {#permissions}

On each repository it is installed on:

| Permission | Level | Why |
|---|---|---|
| Contents | write | Rebase and merge branches |
| Pull requests | write | Read, update and merge PRs |
| Issues | write | Find and label PRs (`fleetd:next`): labels go through the issues endpoints |
| Workflows | write | Merge changes to `.github/workflows` |
| Commit statuses | write | Post `fleetd/train` |
| Actions | write | Re-run CI |
| Checks | read | Read CI's results |
| Metadata | read | Read the repository |

Webhooks are off. The hub polls GitHub, as the merge train always has.

## Tokens {#tokens}

The hub signs in as the App with its private key, and mints a token for each installation. A token lasts an hour, and
the hub mints a new one before it ends. Each `gh` call about a repository the App reaches gets that installation's
token. The hub reads the App's installations again every 10 minutes, so a repository you add shows up within that.

Work the hub does on GitHub then appears as the App, `fleetd-on-devbox[bot]`.

## Your own GitHub {#connect}

In **Settings › Your accounts › GitHub**, press **Connect GitHub** and authorize the App on GitHub's page. The app catches GitHub's
answer on this computer (`127.0.0.1`), and the hub keeps your token sealed and renews it. You never see it, and
nobody else's work uses it.

Who an order's agents are on GitHub, on a repository the App reaches:

| The order | Its agents' `gh` |
|---|---|
| Started by you, connected | Your account: the PRs open as you |
| Started by you, not connected | Its writers are refused: the lead says "Connect your GitHub to open this order's PRs" and spawns them again once you have. Readers and reviewers go on |
| Started by nobody (automations, train fixes) | The App, `fleetd-on-devbox[bot]` |

The token reaches the order's agents as `GH_TOKEN`, one of the order's variables: masked in what they report, renewed
before it ends, and gone when the order closes. Each repo the order works in gets its own: the App's token for that
repo's owner, and none in a repo the App doesn't reach, where `gh` uses the machine's own login.

If GitHub stops taking your connection (revoked there, or unused for six months), Settings › Your accounts › GitHub says so, with
**Connect again**. **Disconnect** revokes the token at GitHub and forgets it. Your open orders' agents then hold a
value GitHub refuses, so their `gh` fails (never falling back to the machine's login) and the order's lead asks you to
connect again; they get your token back at their next turn once you do. GitHub lapsing your connection, or your
removal from the hub, does the same.

## Remove it {#remove}

**Remove** on Settings › Hub accounts › GitHub, or `fleetd github-app remove`, makes the hub forget the App and its keys, and everyone's connection through it. The
hub's `gh` goes back to the machine's own login. GitHub keeps the App until you delete it under its settings' Advanced
page.
