---
title: People & invites
description: Invite teammates to your hub by link, give them a role, and see who did what.
---

A hub knows its people, not only their devices. Each person has a name and a hub role, and owns the devices
(the [human keys](/docs/glossary#human-key)) paired for them. What a person does is recorded under their name:
their chat messages, approvals, secrets, decisions, and checklist ticks or removals.

A hub with one person works as it did before people existed. The person who set up the hub is its owner. Every
device paired before belongs to them, and the lead's prompts don't change.

## Roles {#roles}

| Role | May |
|---|---|
| Owner | Everything an admin may, and make, unmake or remove owners. A hub always keeps at least one owner. |
| Admin | Invite people, change roles (never an owner's), remove people (never an owner), and change hub-wide settings. |
| Member | Work in every project: chat with leads, approve commands, enter secrets, tick the checklist. |

A device never holds more than its person's role allows. A member's device operates on every machine, even one
paired with `admin`. Each device keeps its own cap too: a device paired `--role read` stays read-only. Admin options
live on the Hub pages of the app's Settings, which only owners and admins see.

Every project is open to everyone on the hub ([Who sees a project](/docs/projects#who-sees)). Per-project roles come
later.

## Invite someone {#invite}

On the hub machine:

```sh
fleetd invite --name Alice              # a member
fleetd invite --name Bob --role admin
```

It prints an invite link (`fleetd://pair?…`), a code and the hub's address. Send Alice the link, or the code and
address to enter in the fleetd app. An invite works once, for 7 days. The device that redeems it gets a key of its
own, which belongs to Alice. Owners and admins can also invite from the Hub pages of the app's Settings.

A new person needs a name. To pair one more device for someone already on the hub, invite them again by id:

```sh
fleetd invite --person p_abcd2345
```

`fleetd pair` still pairs one more device for the hub's owner, as before.

## See and manage people {#manage}

| Command | Does |
|---|---|
| `fleetd people` | Lists people with their role and devices |
| `fleetd people role <personId> <owner\|admin\|member>` | Changes a role |
| `fleetd people remove <personId>` | Removes a person and signs out every device of theirs |
| `fleetd invite list` | Lists open invites |
| `fleetd invite revoke <inviteId>` | Takes back an invite. A person it invited who never joined goes with it |
| `fleetd hub key revoke <keyId>` | Signs out one device, and revokes the hub links made on it |

You change your own name yourself, whatever your role: under Settings › You › General in the desktop app, or by
tapping your name at the top of Settings on the phone. Every open app shows the new name at once, on the messages
you wrote before too.

A person signs out one of their other devices (a lost phone, an old computer) under Settings › You › Hubs & devices in
the desktop app: **Sign out** on its row, then confirm, and its key stops working at once, and so does every
[hub link](/docs/projects#hub-links) made on it (the confirm says how many). Owners and admins sign out
anyone's device with `fleetd hub key revoke`. A device signed out, or every device of a person removed, stops at
once: an app it has open is disconnected, and its phone gets no more notifications. What a removed person did keeps their name, and
their projects stay as they are, open to everyone on the hub.

## Claude accounts {#claude}

Each person picks the Claude account their work runs on: **their own subscription** or **the hub's API
configuration**. They can switch at any time.

| Work | Runs on |
|---|---|
| An order's agents (writers, readers, reviewers) | The choice of the person who started the order |
| A project's lead | The hub's API configuration, else the hub owner's subscription. The same on every turn, whoever writes |
| Work nobody started (automations, train fixes, the nightly memory refresh) | The same as the lead |

- **The hub's API configuration** is a Claude API key and an optional custom endpoint (`ANTHROPIC_BASE_URL`). An
  owner or admin sets it up on the Hub pages of the app's Settings. Agents get it as `ANTHROPIC_API_KEY`.
- **A subscription** is connected with the long-lived token that `claude setup-token` prints. Run it on any computer
  signed in to your Claude account and connect it with `claude_subscription_set` (your settings in the app, once its
  screen ships). Agents get it as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Test** makes one tiny `claude -p` call with the key or token, on a machine that holds it.
- With no choice made, your subscription is used once you connect one, on each machine that holds it; on a machine
  that doesn't, your work there runs on the hub's API. Choose your subscription to have it refused there instead.
- **Members may use the hub's API** is on by default. An owner or admin can turn it off on the Hub pages of the app's Settings;
  then each member connects their own subscription. It never affects owners, admins, leads or work nobody started.
- Someone with nothing to run on gets "Connect your Claude to start this order", and no agent starts for them.
  **One person's subscription is never used for anyone else's work.**
- **Usage limits are tracked per account.** When one subscription hits its limit, only the work running on it waits
  for the reset. Everyone else's carries on. `usage_status` lists each account's pause under its machine.
- A hub with none of this set up runs every agent on each machine's own `claude login`, as before.
- An agent keeps the account it started on for its whole life. A change applies to agents started after it.
- Removing a person forgets their subscription on every machine.

In the app:

- **Settings › Your accounts › Claude** is each person's own. *In use* says what your orders run on now, or "Connect
  your Claude to start orders" with what to do. *Runs on* picks your subscription or the hub's API key, and shows only
  when the hub's key is yours to pick. *Your subscription* takes the token: paste it and press Connect and test. The
  app seals it on your computer to every machine and never shows it again. Test, Replace and Disconnect are beside it.
- **Settings › Hub › Setup › Claude** is for owners and admins. *Hub API key* takes the key and an optional endpoint
  (Save and test), then shows the machines that hold it, its last Test, and Test, Change and Remove. A change to the
  endpoint alone keeps the saved key. A line under it says leads and automations run on it, else the hub owner's
  subscription; without a key, whether that subscription is connected. *Members* is the switch.
- **Settings › Hub › People** shows each person's way on their row, beside their GitHub, with any usage pause on
  their account.

The hub's tools are `claude_accounts_get`, `claude_hub_api_set`, `claude_hub_api_remove`, `claude_settings_set`,
`claude_subscription_set`, `claude_subscription_remove`, `claude_choice_set` and `claude_account_test`. See
[Security](/docs/security#claude) for how keys and tokens are kept.

**Settings › You › Vault** is each person's own too: the logins, cards, addresses and variables your work uses
([Vault](/docs/vault)). Nobody else lists them or sees their activity, admins included, unless you share one with a
project, whose agents can then fill it but never see it. The hub's own items (Settings › Hub › Every project › Vault, such as a team
card) are listed for everyone and changed and shown only by owners and admins.

**Settings › Your accounts › 1Password** is optional: a 1Password service account token to [import from into the
vault](/docs/vault#import) (see [Logins from 1Password](/docs/browser-sessions#1password)). Its tools are
`onepassword_get`, `onepassword_set`, `onepassword_remove` and `onepassword_test`.

## Who did what {#attribution}

| Record | Names |
|---|---|
| Chat message | The person who wrote it (and still the device, for older apps) |
| Approval, secret | The person who answered it |
| Decision | The person who recorded or took it back |
| Checklist item | The person who last ticked, edited or added it; a removal is in the activity events |
| Order | The person whose message started it |

When the hub has more than one person, the lead reads each message as "Alice writes in your chat", and its first
message names who shares the hub, so it answers people by name. With one person it reads "The human writes", as
before.

The hub's operator, and any agent on the hub machine, can read the hub's database. fleetd keeps track of who did
what through fleetd; it doesn't hide anything from the hub's operator. See [Security](/docs/security#people).
