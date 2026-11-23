---
title: Skills
description: Give agents reusable workflows, install them from GitHub, and see the ones a bot learns itself.
---

A skill is a written workflow an agent follows when it fits: how to cut a release, review a PR, fill a form. Every agent, the lead included, gets its bot's skills.

fleetd uses the same format as [skills.sh](https://skills.sh) and Claude Code, so skills from either work as they are.

## Install a skill {#install}

1. Open **Settings › Bots** › *your bot* › **Agents**, then find **Skills**.
2. Click **Install from a source…**.
3. Enter a source:
   - `owner/repo` for every skill in a GitHub repo;
   - `owner/repo@skill` for one;
   - a GitHub URL to a branch and folder, or any git URL.

Or ask the lead: "install vercel-labs/agent-skills@web-design-guidelines".

An installed skill stays at the version it was fetched. Click **Update** to fetch it again.

## Write a skill {#write}

1. In the same list, click **+** (New skill).
2. Name it in lowercase with hyphens, such as `release-notes`.
3. Write its `SKILL.md` and save.

A skill is a folder with a `SKILL.md` and any files it uses:

```markdown
---
name: release
description: Cut a release. Use when asked to ship, tag or publish a version.
---

1. Run `scripts/tag.sh` with the new version.
2. …
```

Agents see only the `description` until they open the skill, so put when to use it first.

## Skills in your repo {#repo}

Skills in the repo's `.agents/skills/` or `.claude/skills/` folders reach that bot's agents too. Change those in the repo itself.

When two skills share a name, the first of these wins: the repo's `.agents/skills/`, the repo's `.claude/skills/`, the bot's own, then hub-wide ones.

## Skills for every bot {#hub-wide}

Owners and admins add hub-wide skills under **Settings › Hub › Bot defaults › Agents**. Every bot gets them.

## Skills the bot learns {#learned}

When the lead works out a task it will do again, or you correct how it does something, it saves a skill. Each save posts one line in the chat, such as "Saved a new skill, weekly-invoices".

Click the skill's name to open it beside the chat:

- **Edit** it; the lead's next session uses your version.
- **History** lists every version. **Restore** puts an older one back.
- Turn it **off** to stop the bot using it without deleting it.

A bot's skills reach only that bot.

## Use a skill in the chat {#chat}

Type `$` in the message box to pick a skill by name. The lead uses it, or hands it to the agent it starts.

## Limits {#limits}

- A skill holds at most 64 files and 512 KB.
- A bot, or the hub, holds at most 200 skills.
- A skill can't hold a secret. Name the secret instead, and the agent asks for it.
