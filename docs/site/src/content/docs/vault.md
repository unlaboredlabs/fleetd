---
title: Vault
description: Keep logins, cards, addresses and variables that agents use without ever seeing them.
---

The vault keeps the logins, cards, addresses and environment variables your agents use. Agents fill them in or get
them in their environment, but never read the values. Every use is logged.

- **Workspace vault** (Settings › Vault): logins, cards and addresses. Every bot's agents may use them.
- **Bot variables** (Settings › Bot › Vault): environment variables for one bot's agents.

The phone app has the same lists, under Settings › Vault and a bot's Info › Vault.

## Add an item {#add}

1. Open Settings › Vault, or a bot's Vault for a variable.
2. Click **+** and pick a login, card, address or variable. A bot's Vault also takes a pasted `.env` file.
3. Fill it in and save.

- A **login** fills only on the websites you list for it. Add a one-time code seed to fill 2FA codes too.
- A **card** fills only at a checkout an agent is on.
- A **variable** is secret by default: masked in lists and logs. Agents get it at their next start.

Values are encrypted on your device before they're sent. Deleted items stay in **Trash** for 30 days.

## See a value {#reveal}

Values show as dots. **Show** reveals them for 30 seconds, after Touch ID or Face ID where the device has it. **Copy**
copies one field and clears the clipboard a minute later.

Only an item's creator or an admin can show or change it. Everyone else's agents can still use it.

## How agents use it {#fill}

| Item | Agents use it |
|---|---|
| Login | On one of its own websites |
| Card | At a checkout, once |
| Address | At a checkout, or on a website the vault has a login for |
| Variable | In their environment, from their start |

Agents can list what they may use, but have no way to show, change or delete an item. You aren't asked before a fill
or a payment. Only a bank check, a captcha or a passkey is handed to you. See
[Payments & sign-ins](/docs/payments-and-sign-ins).

An agent can save a secret it holds, such as a key it made, as a new variable of its bot with `vault_store`. It
writes the value to a file only it can read; fleetd seals and saves it, then wipes and deletes the file, so the value
never shows in the chat or the agent's session. You aren't asked: the variable's activity names the agent that saved
it. The person it works for, or an admin, can show it. A variable that's there already is never replaced, and an
agent can't use a name that changes what later sessions run, such as `LD_PRELOAD`, `BASH_ENV` or `GIT_SSH_COMMAND`.

A variable set for one order wins over the bot's variable of the same name, until the order closes. See
[Order variables](/docs/approvals-and-secrets#order-variables).

## Activity {#activity}

Each item lists its uses: who, what, where and whether it worked. Never the value. **All activity** shows the full
list, kept for a year.

## Import from 1Password {#import}

1. Save a 1Password service account token in Settings › Accounts › 1Password.
2. In Settings › Vault, click **+ › Import from 1Password…**.
3. Tick the items and click **Import**.

Values go straight from 1Password into the vault, never through the app or an agent. A lead can also suggest items to
import, as a card in its chat.

## The vault key {#key}

The vault's key is kept outside the workspace's database, so a copy of the database alone opens nothing. Owners and admins
manage it in Settings › Workspace › Bot defaults › Vault.

:::caution
Save the recovery code. On the workspace, `fleetd vault recovery-code` prints it, and `fleetd vault restore-key` takes it
back. Without the key file and the code, every login, card and address is lost.
:::

By default the key is a file on the workspace, `~/.fleetd/vault/root.key`. You can keep it in the system keychain or behind
a passphrase instead; see `fleetd vault --help`. After an admin leaves, click **Rotate…** to seal every item under a
new key.
