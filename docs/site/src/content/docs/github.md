---
title: GitHub
description: Give the hub its own GitHub App, then connect your GitHub account so agents open PRs as you.
---

This page sets up GitHub: the hub's own GitHub App, and your own GitHub account.

The App is what the merge train works as. Your account is what agents open PRs as. fleetd has no shared App: each hub
makes its own, and its keys stay with you.

## Create the App {#create}

An owner or admin does this once, in **Settings › Hub › Setup › GitHub**.

1. Pick where the App lives: your account, or an organization you administer.
2. Check its name. It defaults to "fleetd on" and the hub's name. If GitHub says it's taken, pick another on
   GitHub's form.
3. Press **Create GitHub App**. GitHub's form opens, filled in. Press **Create GitHub App** there too.

GitHub sends you back to fleetd. The hub fetches the App's keys from GitHub and seals them. Nobody sees them.

With no desktop app, run this on the hub machine instead:

```sh
fleetd github-app create              # on your account
fleetd github-app create --org acme   # in an organization
```

## Install it on repositories {#install}

1. Press **Install it on repositories**.
2. Pick all repositories, or the ones fleetd works on.
3. Press **Test**. It checks the App can reach each one.

Add repositories later with **Install on more repositories**. The hub sees new ones within 10 minutes.

## Connect your own account {#connect}

1. Open **Settings › Accounts › GitHub**.
2. Press **Connect GitHub** and allow the App on GitHub's page.

Your PRs now open as you. The hub keeps your token sealed and renews it. If GitHub stops taking it, the same row shows
**Connect again**.

## Who agents act as {#who}

On a repository the App is installed on:

- **Work you started, while you're connected**: agents act as you, and PRs open as you.
- **Work you started, while you're not connected**: writers can't start. The lead asks you to connect, then starts
  them. Reviewers carry on.
- **Work nobody started** (automations, fixes the train opens): agents act as the App.

On a repository without the App, agents use the `gh` login of the machine they run on.

If GitHub is down when a token needs renewing, agents keep their work and try again. They never fall back to another
login.

## What the App can do {#permissions}

| Permission | Level | Used to |
|---|---|---|
| Contents | write | Rebase and merge branches |
| Pull requests | write | Read, update and merge PRs |
| Issues | write | Label PRs, post review comments |
| Workflows | write | Merge changes to workflow files |
| Commit statuses | write | Post the `fleetd/train` status |
| Actions | write | Re-run CI |
| Checks | read | Read CI results |
| Metadata | read | Read the repository |

The App has no webhooks. The hub checks GitHub about once a minute.

## Remove it {#remove}

Press **Remove** in **Settings › Hub › Setup › GitHub**, or run `fleetd github-app remove`. The hub forgets the App
and everyone's connection to it, and goes back to the machine's `gh` login.

GitHub keeps the App itself. Delete it in the App's settings on GitHub.
