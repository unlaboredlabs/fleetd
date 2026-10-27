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
live on the app's Administration page, which only owners and admins see.

Every project is open to everyone on the hub for now. Private projects and per-project roles come later.

## Invite someone {#invite}

On the hub machine:

```sh
fleetd invite --name Alice              # a member
fleetd invite --name Bob --role admin
```

It prints an invite link (`fleetd://pair?…`), a code and the hub's address. Send Alice the link, or the code and
address to enter in the fleetd app. An invite works once, for 7 days. The device that redeems it gets a key of its
own, which belongs to Alice. Owners and admins can also invite from the app's Administration page.

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
| `fleetd hub key revoke <keyId>` | Signs out one device |

A person can sign out their own devices from the app. Owners and admins can sign out anyone's. What a removed
person did keeps their name.

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
