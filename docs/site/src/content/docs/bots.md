---
title: Bots
description: Make a bot, give it repos, change its settings, and archive or delete it.
---

A bot is a chat with a lead, in a folder of its own on one of your machines. It can hold one repo, several, or none.

A bot with repos ships code: its lead starts agents that open pull requests. A bot with no repo is an assistant: its lead chats, remembers, writes notes, browses and uses screens in its folder.

## Make a bot {#new}

1. Click **+** at the top of the sidebar.
2. Give it a name.
3. Under **Repos**, click **+** to add a GitHub URL, `owner/repo`, or a folder already on the machine. Add none for an assistant.
4. With several machines, pick where it runs.
5. Click **Create**.

The chat opens at once and the lead is ready for your first message. Repos clone in the background; the dialog shows their progress.

On the phone, tap **+** in Chats, then **New Bot**.

From a terminal on the hub machine:

```sh
fleetd project add https://github.com/acme/storefront   # clone a repo
fleetd project add ~/src/storefront                     # an existing checkout
fleetd project add --new "Field notes"                  # an empty folder
```

`project add` prints what the lead will need on GitHub first, such as a repo with no CI.

## Repos {#repos}

A bot can hold several repos, so one lead works across them. The lead picks the repo for each agent.

- **Add:** Settings › Bots › *your bot* › Bot › **Add repo**, or ask the lead in the chat.
- **Remove:** **Remove…** on the repo's row. Its agents stop; its files stay on disk.
- **One repo can be in several bots,** each with its own copy. Adding a repo never takes another bot's folder: fleetd clones a separate copy beside it, such as `~/src/web-2`. If a copy no bot uses is already there, it asks: **Use the same copy** or **Make a separate copy**.

When work in a bot with no repo grows into real software, the lead offers once to make a GitHub repo for it. Say no and it won't ask again for that work.

## Settings {#settings}

Open **Settings › Bots** and pick the bot, or right-click it in the sidebar and choose **Open settings**. Its pages:

| Page | Has |
|---|---|
| Bot | Picture, look, name, repos, variables, merging, approvals, what the lead can use, archive and delete |
| Agents | How many agents at once, models, skills |
| Instructions & memory | What every agent is told, what the lead remembers |
| Automations | Scheduled and triggered work, watchers |
| Vault | The bot's environment variables and secrets |

The main settings on **Bot**:

- **Picture and look:** upload an image, or pick a shape and color for the bot's character.
- **Repos and setup:** each repo's setup commands run in every new agent's copy of it, such as `pnpm install`.
- **Environment variables:** given to every agent. Paste a `.env` file or add one at a time. See [Vault](/docs/vault).
- **Who merges:** **You** (the default) or **fleetd**. See [Merge train](/docs/merge-train#who-merges).
- **How it merges:** **Test, then merge** or **Merge, then verify**. See [Merge train](/docs/merge-train#verify).
- **Approvals:** what the lead asks before it acts. See [Approvals and secrets](/docs/approvals-and-secrets#modes).
- **MCP servers, sign-ins, skills and payments:** what the lead can use. See [MCP servers](/docs/mcp-servers), [Payments and sign-ins](/docs/payments-and-sign-ins) and [Skills](/docs/skills).

## Ask the lead to change it {#lead-changes}

Ask in the chat and the lead changes its own bot: add or remove a repo, rename it, change its picture, set its instructions, setup commands or plain variables, or archive it.

Each change posts one line in the chat with **Open** and **Undo**.

Some things stay yours alone: approval mode, models, agent limits, the card it pays with, secrets, MCP servers, and deleting the bot. The lead can propose a new bot, but only you can tap **Create it**.

## Organize the sidebar {#sidebar}

- **Pin:** right-click a bot and pick **Pin to top**.
- **Sections:** right-click a bot, then **Move to section › New section…**. Or drag it onto a section. Click a section's label to fold it.
- **Reorder:** Alt+↑ and Alt+↓ move the selected bot.
- **Jump:** ⌘1 to ⌘9 open the first nine bots.

Sections are yours: teammates have their own. They follow you to every computer and your phone.

## Archive {#archive}

Right-click the bot and pick **Archive**. It leaves the sidebar and its lead stops. Its chat, memory, folder and settings stay.

To bring it back, open **Settings › Bots › All bots**, find it under **Archived**, and click **Bring back**.

## Delete {#delete}

1. Open the bot's settings.
2. At the end of **Bot**, click **Delete bot…**.
3. Type the bot's name to confirm.

Deleting stops its agents and erases everything fleetd keeps for it: chat, memory, skills, automations and sign-ins. Its checkout, branches and pull requests stay. Tick **Also delete its folder** to remove the files too.

If any agent copy has uncommitted changes, the dialog names them first.

## Bots talk to each other {#bots-talk}

A lead can text another bot's lead: a question, a heads-up, or an ask for work. Both chats show each text as a quiet line. A text from another lead can't approve anything or answer for you.

Work this bot asked of others shows in the panel's **Plan** tab, under **Asked of other bots**.

## Who sees a bot {#who-sees}

Every bot is open to everyone on the hub, as their [role](/docs/people#roles) allows. For work only you should see, use a hub of your own.

## Clean-up {#cleanup}

Each agent works in its own copy of the repo. Every night, fleetd removes copies from finished agents older than 3 days, if their work is safe on a branch. One with unsaved work is kept, and the chat says so once.
