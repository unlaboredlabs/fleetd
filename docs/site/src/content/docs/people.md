---
title: People
description: Invite teammates, give them a role, and choose which Claude account their work runs on.
---

Everyone on a workspace has a name, a role and their own devices. What each person does is recorded under their name.

## Invite someone {#invite}

1. Open **Settings › Workspace › People**.
2. Under **Invite someone**, enter their name and pick a role.
3. Copy the link and send it to them.

They open the link in the fleetd app to join. It works once, within 7 days.

From a terminal on the workspace machine:

```sh
fleetd invite --name Alice              # a member
fleetd invite --name Bob --role admin
```

This prints the link, plus a code and address they can type in instead.

## Roles {#roles}

| Role | Can |
|---|---|
| Member | Work in every bot: chat, start work, approve, enter secrets, run an automation now |
| Admin | All that, plus change a bot's safety settings, delete a bot, invite people, change roles and change workspace settings |
| Owner | All that, plus manage other owners |

Every bot is open to everyone on the workspace. The **Workspace** settings show only to owners and admins.

### A bot's safety settings {#bot-safety}

Only owners and admins change these, in the apps, from a terminal or through a lead:

- **Approvals**: how its risky actions are approved.
- **Who merges** and **How it merges**, with the merge rules.
- **Max agents**.
- **Payments**: the card it pays with.
- **Automations and watchers**: making, editing, pausing or deleting one.
- **Delete bot**.

A member sees each one as it is set, with "Only admins can change this." The workspace refuses a member's change too. A lead asked by a member to change one of these says it can't.

When an admin deletes a bot, everyone else who wrote in its chat or started its work is told who deleted it.

A workspace on fleetd cloud holds up to 50 people. For more, write to support@fleetd.dev. A workspace you run yourself
has no limit.

## Manage people {#manage}

In **Settings › Workspace › People**, each person's row has their role, devices and Claude account. Change a role or remove someone from there.

Removing someone signs out every device of theirs at once. What they did keeps their name, and their bots stay.

From a terminal:

```sh
fleetd people                              # list
fleetd people role <personId> admin        # change a role
fleetd people remove <personId>            # remove
```

## Sign-in on fleetd cloud {#sign-in}

On a fleetd cloud workspace, owners and admins open **Settings › Workspace › Sign-in**:

- **Sign-in method**: any method (Google, GitHub or an emailed code), or **Google only**. With Google only, admins
  and members signing in another way are refused for this workspace.
- **Email domains**: **Add domain** (then **Manage domains**) opens a page to add your company's domain and verify it
  with a DNS record.
- **People with @yourdomain join automatically**: once a domain is verified, anyone signing in with an email there
  joins as a member, with no invite. Off by default.

Owners are let in however they sign in, so nobody gets locked out. A change applies from each person's next
sign-in; anyone already signed in stays signed in. A workspace you run yourself has no Sign-in page: who joins is who
you invite.

## Your name and devices {#you}

- **Change your name:** Settings › You › **General**.
- **Sign out a lost device:** Settings › You › **Workspaces & devices**, then **Sign out** on its row.

## Claude accounts {#claude}

Each person picks what their work runs on: their own Claude subscription, or the workspace's API key.

### Connect your subscription {#subscription}

1. On any computer signed in to Claude, run `claude setup-token`.
2. Open **Settings › You › Accounts › Claude**.
3. Paste the token and click **Connect and test**.

Under **Runs on**, pick your subscription or the workspace's key.

### The workspace's API key {#workspace-key}

Owners and admins add it under **Settings › Workspace › Setup › Claude**. It can use a custom endpoint.

**Members may use the workspace's API key** is on by default. Turn it off to make each member connect their own subscription.

### Whose account runs what {#who-pays}

- **Agents** run on the account of the person who started the work.
- **Leads and automations** run on the workspace's API key, or else the owner's subscription.
- **One person's subscription never runs anyone else's work.**
- Usage limits are per account. When one hits its limit, only that person's work waits.

A change applies to agents started after it. See [Security](/docs/security#claude) for how keys are kept.

## Who did what {#attribution}

Chat messages, approvals, secrets, decisions and checklist ticks each show who did them. With more than one person on the workspace, the lead knows who is writing and answers them by name.

Owners and admins see the workspace's changes in one place, by name, in the [audit log](/docs/audit-log).

The workspace's operator can read the workspace's database. fleetd records who did what; it hides nothing from the operator.
