---
title: Vault
description: Logins, cards, addresses and environment variables that agents fill in and get without ever seeing them.
---

The vault keeps the logins, cards, addresses and environment variables your agents use. Agents fill a login into a
page, pay with a card, enter an address or get a variable in their environment, and never read the value. Every use is
logged. 1Password is optional: a place to [import from](#import), never the day-to-day path.

It has two parts: one **team vault** per hub, holding every login, card and address, which every project's agents may
fill; and **variables**, kept per project, plus an order's own variables while it runs.

| Kind | Holds | Agents use it with |
|---|---|---|
| Login | User name, password, one-time code seed, notes; the sites it signs in to | `fill_credential` on one of its sites |
| Card | Number, expiry, security code, name on card | `purchase_fill` at a recorded checkout |
| Address | Name, company, street, city, region, postal code, country, phone, email | `fill_address` at a checkout or on one of its sites |
| Variable | One value, secret or plain | Every agent's environment, from its start |

## Where it is {#where}

| Page | Lists | Who changes an item |
|---|---|---|
| Settings › You › Vault | The team vault: every login, card and address on the hub | Its creator, or an owner or admin |
| Settings › Projects › *project* › Vault | The project's variables, and its orders' (tagged with the order) | Anyone who may operate on the project |
| Settings › Hub › Every project › Vault | The vault key | Owners and admins |

The phone has the same lists under Settings › Vault and a project's Info › Vault. The Vault rows show only on a hub
that serves the vault (fleetd's Bun build); an older hub has none.

Each page has a search field, a filter, and **+**: the team vault's adds a login, a card or an address, or imports
from 1Password; a project's adds a variable or pastes a `.env`. Deleted items go to **Trash** under the list for 30
days, with Restore and Delete now.

## Add and edit {#add}

- **Login.** Its name, the websites it signs in to (one per line; a pasted address is cut to its site), the user name,
  password, an optional one-time code seed (an `otpauth://` link or the base32 seed) and notes. A login with no site
  fills nowhere.
- **Card.** Number, expiry (MM/YY), security code and the name on the card. The app checks the number (Luhn) and the
  expiry before it goes. The list shows its brand and last four digits: "Visa ••4242".
- **Address.** Street, city and country (its two-letter code, such as `DE`) at least. Websites are optional.
- **Variable**, in a project's Vault. Its name (letters, digits and `_`; fleetd's and claude's own names are refused, as for
  [project variables](/docs/projects#env)) and its value, up to 64 KiB, any number of lines. **Secret** is on by
  default: a secret is masked in lists and logs; a plain one shows as it is.

What you type is sealed on your computer to the hub's own key before it leaves (a libsodium sealed box), so the
network and any proxy see only ciphertext. **Edit** never shows the stored values: type a new one to replace a field,
or leave it empty to keep it. A variable keeps its name; to rename one, add a new one and delete the old.

## Show and copy {#reveal}

An item's fields show as dots. **Show** reveals them for 30 seconds:

- On a Mac with Touch ID, the desktop app asks for it first. Elsewhere it asks once in a system dialog the page can't
  answer for you. One that passed covers the same item for 30 seconds, so Show then Copy asks once.
- The phone asks for Face ID, Touch ID or the device passcode.
- The values hide again when the window loses focus, you open another item, or you leave the page.
- **Copy** copies one field without the page ever holding it, and empties the clipboard a minute later unless you
  copied something else since.

Who can show an item: its creator or an admin, for a team item and a project's variable alike; an order's variable
only its creator. Everyone else sees "Only its creator or an admin can show it. Agents still fill it." The same people
change or delete a team item, so nobody can point a login's or an address's sites at a page of their choosing and
fill what they can't see. A plain variable shows without asking; making a secret one plain takes who may show it.
Each reveal is in the item's activity, and a person can reveal at most 30 values an hour.

## Who uses what {#scopes}

| Item | Listed for | Filled or got by |
|---|---|---|
| A team login, card or address | Everyone on the hub | Every project's leads and agents |
| A project's variable | Everyone who sees the project | That project's leads and agents |
| An order's variable | As the project | That order's agents, until the order closes. A `request_secret` answer makes one ([order variables](/docs/approvals-and-secrets#order-variables)). |

An order's variable wins over the project's of the same name: order > project. A change reaches an agent at its next
start. Setting a variable no longer needs the project's machine online: the hub delivers it as soon as the machine is
back.

**Set aside** is a small section under the team vault's list, shown only when it has items: what the
[upgrade](#team-vault) kept for you alone. Nothing fills or delivers those. **Move to team vault** (a variable: **Add
to a project…**) puts one to use; **Delete** sends it to Trash. Nobody else sees them, admins included.

## How agents fill {#fill}

The node hosting the agent's browser asks the hub for the value. The hub checks, from its own records, which project
and order the session works for, that the item is in the team vault, and that the page is on one of the item's
sites. It then seals the value to that node alone, which types it into the page itself, as
[a 1Password fill did](/docs/browser-sessions#sealed): the same guards keep the value from the agent, its transcript,
the recording and every log. Masked output reads `***vault:Amazon/password***`.

| Kind | Fills only |
|---|---|
| Login | On one of its sites or their subdomains. Shared-hosting suffixes (`github.io`, `vercel.app`, `netlify.app`, `pages.dev` and the like) match only as whole hosts. |
| Card | At a [purchase](/docs/projects#purchases) recorded in that session, in the shop's page and its payment provider's card frames, once, within 15 minutes. |
| Address | At a checkout recorded in that session, on one of its own sites, or on a site the team vault has a login for. |

An agent can list the items it may use (`vault_items`: the team vault's labels, kinds and sites, and the names of the
variables in its environment, never values). It has no tool to show, create, change or delete one. Fills are limited to 30 an hour per item per project and 300 an hour per
machine. A refused fill is logged, and three in 10 minutes put one quiet line in the project's chat. You aren't asked
before a fill or a payment; only your bank's 3-D Secure, a captcha or a passkey is handed to you.

## Activity {#activity}

Each item lists its last 20 uses, with **All activity** for the rest: who (you on a device, or an agent with its task
and order), what (filled, refused, given to an agent, shown, added, changed, deleted, imported, paid), where (the
site, the machine, the project) and the outcome. Never a value. Rows are kept for 365 days. The team vault's page
shows its items' activity; a project's, its variables'. An item set aside is yours alone, its activity too.

## Import from 1Password {#import}

With your service account token saved under Settings › You › Your accounts › 1Password:

1. Press **+ › Import from 1Password…**, search, and tick the items to bring in. You see titles, kinds, sites and
   vaults, never a value; one already imported says so.
2. Press **Import**. A machine holding your token reads the items and seals them to the hub there, so no value passes
   through the app or any agent. They go in the team vault, with you as their creator.

A lead can do the searching: it proposes items in its chat as a card with each one ticked. **Import** brings in the
ticked ones, **Dismiss** turns it down. That's the only confirm in the vault. Once imported, 1Password isn't asked
again for that item.

For this release, an agent's `fill_credential` with an `op://` reference fills from the item imported from it, or
falls back to 1Password and proposes importing it. In the release after, `op://` references are refused.

## The vault key {#key}

Every value is encrypted at rest with AES-256-GCM under a data key of its own, wrapped by the vault's root key. The
root key isn't in the hub's database: a copy of the database alone opens nothing. Settings › Hub › Every project › Vault says where it
is and offers **Rotate…**.

| Kept in | After a restart | How (on the hub; fleetd vault --help lists them) |
|---|---|---|
| A file (the default) | Works | `~/.fleetd/vault/root.key`, mode 0600 in a 0700 folder, outside `~/.fleetd/hub` |
| The system keychain | Works where a keychain is unlocked at login | fleetd vault key --store keyring |
| A passphrase | Locked until an owner or admin unlocks it in Settings › You › Vault; fills fail meanwhile, variables already given keep working | fleetd vault key --store passphrase |

:::caution
Save the recovery code: on the hub, fleetd vault recovery-code prints it, and fleetd vault restore-key takes it
back. Without the key file and the code, every login, card and address is lost. Variables can be taken back in from
the machines that hold them.
:::

Rotate after an admin leaves, or if the key file may have been copied: every item is sealed again under a new key.
Rotating doesn't undo a leak; change those secrets where they come from. No mode keeps the vault from an agent running
on the hub's machine as the same OS user ([why](/docs/security#vault)).

## Moving in {#migration}

On the first start of a hub with the vault, its project variables, order variables and stored `request_secret` answers
move into the vault, losing nothing. Each machine hands over the secrets it holds, sealed to the hub. fleetd's own
`GH_TOKEN` order variables stay where they are. A machine that's offline, or still runs fleetd's Rust build, keeps its
secrets working where they are, and they move in once it's back on the Bun build: Settings › Hub › Every project › Vault lists what is
still waiting. A card picked from 1Password for [Payments](/docs/projects#purchases) is imported once a machine with the
token is online.

## Upgrading to one team vault {#team-vault}

Hubs before this release kept items at four levels: a person's own ("Yours", which they could share with projects), a
project's, an order's, and the hub's (admins only). The first start after the upgrade moves them, deleting nothing and
sealing nothing again:

- The hub's and every project's logins, cards and addresses join the team vault. One whose label another team item of
  its kind has gets its project's name appended: "Shop (Storefront)". A project's item keeps its creator.
- On a hub with one person, their own logins, cards and addresses join the team vault, and each of their variables
  becomes a variable of every project not archived that has none of that name.
- On a hub with more people, an item its owner had shared with a project, or that a project pays with, joins the team
  vault (a variable: that project's, unless it has one of that name). Everything else of theirs is **set aside**: it
  stays theirs alone and nothing uses it until they move it or delete it, so nobody's private card becomes fillable by a
  teammate's agents without them.
- A person removed from the hub leaves their team items behind for admins to manage; their set-aside items go with
  them, as their own items did before.

An export written before the upgrade ends the same once loaded with `fleetd import`. An app older than the hub still
lists everything, but adding a login, card or address from it, at any level, is refused with "This app is older than
the hub: update it to add vault items."; nothing is stored. A newer app on an older hub lists what that hub gives
and adds new items as your own there, as it always did.

## From an MCP client {#clients}

`vault_list`, `vault_get`, `vault_save`, `vault_delete`, `vault_restore`, `vault_move`, `vault_reveal`, `vault_audit`,
`vault_status`, `vault_unlock`, `vault_rotate`, `vault_import_search` and `vault_import` take human keys only.
`vault_save` takes the fields sealed to `vault_status`'s `hubBoxKey`: a new login, card or address names no scope (it
goes in the team vault), a variable `scope` `project` or `order`. `vault_move` puts an item set aside to use.
`vault_reveal` answers sealed to a one-time key you send. See the [tool reference](/docs/reference/agent-tools).
