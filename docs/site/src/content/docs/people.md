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
| Member | Work in every bot: chat, approve, enter secrets |
| Admin | All that, plus invite people, change roles and change workspace settings |
| Owner | All that, plus manage other owners |

Every bot is open to everyone on the workspace. The **Workspace** settings show only to owners and admins.

## Manage people {#manage}

In **Settings › Workspace › People**, each person's row has their role, devices and Claude account. Change a role or remove someone from there.

Removing someone signs out every device of theirs at once. What they did keeps their name, and their bots stay.

From a terminal:

```sh
fleetd people                              # list
fleetd people role <personId> admin        # change a role
fleetd people remove <personId>            # remove
```

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
