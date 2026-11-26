---
title: Memory
description: What leads remember about you and each bot, and how to read, edit, undo or import it.
---

Leads remember how you work and what each bot decided, so you never say the same thing twice.

## How it remembers {#memory}

When you correct the lead or state a rule, it remembers it in that turn. The chat shows **Remembered: …** with
**Undo**. When something no longer holds, the lead forgets it, and the chat shows **Forgot: …** with **Undo**.

There are two kinds of memory:

- **Your memory**: how you work, across every bot. Only you can read or edit it.
- **A bot's memory**: what that bot decided. Only that bot's agents see it.

The lead and the bot's writers get both at the start of each session.

On a workspace with several people, a bot's lead starts with nobody's personal memory, since it answers everyone. What it
learns about you still goes into your memory.

## Read and edit it {#edit}

- Your memory: **Settings › Memory**.
- A bot's memory: the bot's settings, then **Instructions & memory**.

Memory is plain text, kept on the workspace, in no repo. It never holds a secret.

Each memory has a size limit. When a bot's memory is full, the lead merges entries to make room. When yours is full,
fleetd tidies it.

## The nightly refresh {#memory-refresh}

Each night, around 04:00 in your time zone, each bot's lead tidies that bot's memory:

- it adds what the chat taught but nobody remembered;
- it merges entries that overlap;
- it removes what no longer holds.

A bot with no chat or work since its last refresh is skipped. When it's done, the chat shows **Memory refreshed: +2
~1 −3** (added, changed, removed), each change with **Undo**, and **Undo all**.

The refresh can only read and write memory. It never posts anything else, or touches code.

To run it now, open the bot's **Instructions & memory** and press **Run now**. To move the hour, set the decision
`policy.memory_refresh_at` (as `HH:MM`).

## Your memory's tidy {#memory-tidy}

Once a night, fleetd also tidies your own memory. It merges duplicates, replaces old entries with newer corrections and
tightens the wording. It never drops a rule just because it didn't come up lately.

You get one **Memory refreshed** line, with **Undo all**, at the top of **Settings › Memory**.

## Import from another assistant {#memory-import}

Bring what ChatGPT, Claude or another assistant knows about you:

1. Open **Settings › Memory › Import memory**.
2. Press **Copy prompt**, and paste it into a chat with the other assistant.
3. Paste its answer into the box, and press **Add to Memory**.

About a minute later, it says how many entries it added. Entries you already have are skipped, and anything that
looks like a password or key is refused.

The pasted text is read as data only. Instructions inside it are never followed.
