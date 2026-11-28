---
title: FAQ
description: Short answers to the first week's questions about billing, Claude keys, GitHub and where agents run, each with the page that has the rest.
---

Short answers to what people ask in their first week. Each links to the page with the rest.

## Billing {#billing}

### What does fleetd cost? {#cost}

fleetd itself is free: a workspace you run yourself, and agents on your own machines, cost nothing. On fleetd cloud, you
pay only for agents on fleetd's computers, with a plan (from $20 a month, with computer time included) or credits
(from $10). Computer time is billed by the second. See [Billing](/docs/billing).

### Do I pay for Claude on top? {#claude-cost}

Yes, to Anthropic, not to fleetd. Agents run on your workspace's Anthropic API key or a person's own Claude
subscription, and Anthropic bills that key or subscription. fleetd adds nothing to it.

### How do I cancel? {#cancel}

**Settings › Workspace › Billing › Manage billing**, then cancel on Stripe's page. The plan stops renewing and runs to
the end of the month you paid for. Credits you bought stay until they expire.

### Can I get a refund? {#refund}

Within 14 days of your first purchase, yes: write to support@fleetd.dev from your account's email. You pay for what you
used, and we refund the rest. See the [Refund Policy](https://fleetd.sh/refunds).

### Where are my invoices? {#invoices}

In **Settings › Workspace › Billing › Manage billing**, on Stripe's page. Only owners and admins see Billing.

## Claude keys {#keys}

### Where do I get an API key? {#api-key}

In Anthropic's Console, under **API keys**. Then an owner or admin adds it in **Settings › Workspace › Setup ›
Claude**. Make a key for fleetd alone, and set a spend limit on it at Anthropic. See
[Claude accounts](/docs/people#claude).

### Can I use my Claude subscription instead? {#subscription}

Yes, for your own work. Run `claude setup-token` on a computer signed in to Claude, then paste the token in
**Settings › You › Accounts › Claude**. Your subscription runs only the work you start, never a teammate's. See
[Connect your subscription](/docs/people#subscription).

## GitHub {#github}

### How do I connect GitHub? {#connect-github}

- **fleetd cloud:** an owner or admin opens **Settings › Workspace › Setup › GitHub**, connects their own GitHub, then
  presses **Install it on repositories** and picks the repositories fleetd works on.
- **A workspace you run yourself:** create the workspace's own GitHub App in the same place. See [GitHub](/docs/github).

Then each person connects their own account in **Settings › Accounts › GitHub**, so agents open pull requests as them.

### What can the GitHub App do? {#github-app}

Only what the merge train needs on the repositories it's installed on: read them, rebase and merge branches, update
and label pull requests, post a status, and read and re-run CI. Never their settings or administration. See
[What the App can do](/docs/github#permissions).

### I added a repository, but its bot can't reach it {#repo-missing}

Install the App on that repository too: **Install on more repositories** in the same Settings page. The workspace sees
it within 10 minutes.

## Where agents run {#machines}

### My own machine or fleetd's computers? {#where}

- **Your own machine** (a Mac or Linux computer that stays on): free, uses your own tools and logins, and agents run
  directly on it as your user. [Add a machine](/docs/machines#app).
- **fleetd's computers** (fleetd cloud only): nothing to keep running, and each bot gets a computer of its own. Paid
  with a plan or credits.

A cloud workspace can use both: your machines first, then fleetd's computers once yours are full. See
[fleetd's computers](/docs/cloud-machines).

### Why is my agent waiting? {#waiting}

The bot's status line says why. The usual reasons:

- On fleetd's computers: no plan or credits left, the spend cap or a spend limit was reached, or the workspace runs as
  many agents as its plan allows. See [When computers stop](/docs/billing#stops).
- On your own machine: it's offline, short of disk, or its Claude login is near its usage limit. See
  [When new agents wait](/docs/machines#guard).

## People and your account {#account}

### How do I add a teammate? {#teammate}

**Settings › Workspace › People**, then **Invite someone**. On fleetd cloud, fleetd emails them an invite; on a
workspace you run yourself, you send them the link. See [People](/docs/people#invite).

### How do I delete my account? {#delete-account}

On fleetd cloud: **Settings › You › Workspaces & devices › fleetd account › Delete account**. It deletes the
workspaces you own, with their bots, chats and vault. Cancel a paid plan first. See the
[Privacy Policy](https://fleetd.sh/privacy#retention) for what's kept.

## Something's wrong {#help}

### How do I report a problem? {#report}

Write to support@fleetd.dev. Say what you did, what you saw, and which app and device you use. In the desktop app,
**Help › Copy Diagnostics** copies details we can use; paste them in. Check [status.fleetd.dev](https://status.fleetd.dev)
first for an outage, and see [Troubleshooting](/docs/troubleshooting) for a workspace you run yourself. Self-hosted
bugs can also go to [GitHub issues](https://github.com/unlaboredlabs/fleetd/issues).
