---
title: Chat with the lead
description: Give a bot work, answer its questions and follow the work, all in one chat.
---

Each bot has one lead and one chat. You tell the lead what you want in plain words, and it plans the work and starts agents to do it.

![A bot's chat with the panel open beside it](/docs/img/chat.png)

## Send a message {#send}

1. Click the bot in the sidebar.
2. Type in the box at the bottom.
3. Press Enter. Shift+Enter adds a new line.

You can also:

- **Attach files:** paste, drop or attach up to 20 files, 25 MB each. Images, PDFs, text, CSV, Word, Excel, PowerPoint and zips work.
- **Bring back your last message:** press ↑ in the empty box.
- **Pick a skill:** type `$` to name a [skill](/docs/skills) for the lead to use.

A draft you haven't sent stays in the box, even after you quit the app. If the bot's machine is offline, your message waits and goes in once it's back.

## Answer the lead {#reply}

The lead asks only what it needs: product calls, money and steps that can't be undone. It numbers its questions and gives a recommendation for each.

```text
Lead:  Two calls before I ship:
       1. Keep the old endpoint for a release? I'd keep it.
       2. Bump the minor version? I'd bump it.
You:   1 go, 2 rec
```

- Reply in your own words, or tersely: `do it`, `nvm`, `2: keep it for two releases`.
- Click **Approve**, **Deny** or a choice button when the lead offers them.
- Hover a message and click **Reply** to quote it.
- **Not needed, skip it** under the questions tells the lead to go on without you.

The lead records each answer as a decision, so it doesn't ask the same thing twice.

## What needs you {#needs-you}

The sidebar marks a bot that waits on you:

- **reply**: the lead asked you something.
- **approve**: a command or action waits for your OK.
- **secret**: the lead needs a key or password.
- **blocked**: something outside the work holds it up, such as an offline machine.
- **CI red**: a check fails on the main branch. Work goes on.

The bar at the top of the chat says what it waits on. Click **Show** to jump to it. ⌘. (Ctrl+. on Linux and Windows) opens the next bot that needs you.

### Things to look at {#look-at}

The lead can flag a message for you to look at, such as a screenshot of a UI change. The bar names it until you've seen it, or click **Dismiss**.

## Follow the work {#follow}

The chat stays quiet about routine steps. The lead writes when you must decide, when work lands or fails, and to answer you.

- **The island** above the message box shows what the lead and its agents are doing. Click it to see each agent.
- **The line under a reply** shows how long the lead has worked and what it started.
- **Cards** show a pull request, an agent, a chart, a table or a file, live.

The panel beside the chat (⌥⌘B, or Ctrl+Alt+B) has more:

| Tab | Shows |
|---|---|
| Agents | Each agent at work and what it's doing |
| Shipping | The bot's pull requests, their checks and reviews |
| Plan | The to-do list and work asked of other bots |
| Artifacts | Reports and files from the chat |
| History | Everything that happened, step by step |

## Pull requests {#prs}

Open **Shipping** in the panel, or click a PR number in the chat. A PR shows where it is on its way to main, its checks, its reviews and the agent that wrote it.

- Click **Changes** to read the diff, in one column or side by side.
- Click **Open on GitHub** for anything else.

## Reports and files {#artifacts}

A long report, such as a dependency check or a chart, arrives as a card in the chat. Click it to read it in the panel's **Artifacts**.

- Publishing a report again under the same name adds a version. Pick an older one from the version picker.
- An HTML report runs in a sealed frame with no network.
- **Files** under the reports lists every file sent in the chat. Click one to open or save it.

## Search {#search}

Press ⌘F (Ctrl+F) in a chat. Search covers the whole chat, back to its first message.

- Words match the start of a word, in any order: `deplo friday` finds "Deployed on Friday".
- Quotes find an exact phrase: `"staging password"`.
- Filters narrow it: `from:lead`, `from:me`, `has:link`, `has:image`, `has:file`, `has:pr`, `has:pinned`, `on:today`, `before:` and `after:` a date.

Enter opens a result at that message. On the phone, tap the bot's name, then search.

## Pin a message {#pins}

Right-click a message (press and hold on the phone) and pick **Pin**. Everyone in the bot sees the same pins, up to 50. The newest shows under the chat's name; click it to jump there.

## Stop everything {#stop}

Click **Stop** beside Send. The lead's turn and all its agents stop, and the chat says what stopped. Merged work stays; write again to start new work.

To redirect the lead without stopping it, see [Steer and stop](/docs/steering).

## From a terminal {#terminal}

Make a key once, on the workspace machine:

```sh
fleetd workspace key create --human --name terminal --out ~/.fleetd/human.key
```

Then:

```sh
fleetd chat devbox/storefront "fix the checkout button" --follow --key-file ~/.fleetd/human.key
fleetd chat history storefront --key-file ~/.fleetd/human.key
fleetd project stop devbox/storefront --key-file ~/.fleetd/human.key
```

`--follow` prints the lead's reply when it's done. A script or another tool can write with an agent key instead; its messages show under its own name and can't approve anything.

## Good to know {#details}

- After an hour idle, the lead starts fresh from the bot's memory and recent chat. Repeat anything older that matters.
- The lead can search the whole chat itself when you mention something from before.
- Messages from before the chat existed show at the top, under "From before this chat".
- To change how the lead talks, edit its **Voice** prompt: see [What agents are told](/docs/what-agents-are-told).
