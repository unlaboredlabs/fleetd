---
title: GitHub App
description: Give the hub a GitHub App of its own, created from one button with nothing to paste. The merge train and PR pages then work as the App on the repositories you install it on.
---

The hub works on GitHub as a GitHub App of its own: the merge train's reads, rebases, `fleetd/train` statuses and
merges, and the PR pages. Each hub makes its own App. fleetd is open source and has no shared App, so the App and its
keys are yours.

Without an App, the hub runs `gh` as it is logged in on the hub machine (`gh auth login`), as before. With one, a
repository the App is installed on uses the App, and any other repository still uses that login.

## Create it {#create}

On an owner's or admin's app: **Administration › GitHub**.

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

## Remove it {#remove}

**Remove** on Administration › GitHub, or `fleetd github-app remove`, makes the hub forget the App and its keys. The
hub's `gh` goes back to the machine's own login. GitHub keeps the App until you delete it under its settings' Advanced
page.
