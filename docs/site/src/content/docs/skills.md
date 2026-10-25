---
title: Skills
description: Reusable SKILL.md workflows every fleetd agent can use, from the repo, the project or the whole hub.
---

A skill is a workflow an agent follows when it fits: how to cut a release, review a PR, fill a PDF form. Every fleetd
agent (the lead, writers, reviewers) gets the skills of its repo, of its project and of the whole hub. fleetd uses the
skills.sh format, so skills installed with `npx skills add` work as they are, and so do Claude Code skills.

## What a skill is {#format}

A skill is a folder named for the skill, with a `SKILL.md` and any files it uses (scripts, references, templates):

```text
release/
  SKILL.md
  scripts/tag.sh
```

`SKILL.md` starts with frontmatter that names it and says when to use it:

```markdown
---
name: release
description: Cut a release. Use when asked to ship, tag or publish a version.
---

1. Run `scripts/tag.sh` with the new version.
2. …
```

- `name` is the folder's name: lowercase letters, digits and single hyphens, at most 64 characters.
- `description` (at most 1,024 characters) is what agents see before they open the skill. Put the use case first.

This is the [Agent Skills](https://agentskills.io) format that [skills.sh](https://skills.sh) installs and Claude Code
loads. Other frontmatter fields Claude Code knows (`allowed-tools`, `disable-model-invocation`, …) work as there.

## Where skills come from {#sources}

An agent gets skills from four places. When two have a skill of the same name, the first one wins:

1. **The repo's `.agents/skills/<name>/`**: where `npx skills add` puts a project's skills.
2. **The repo's `.claude/skills/<name>/`**: Claude Code's project skills.
3. **The project's skills**, kept by the hub.
4. **Global skills**, kept by the hub for every project.

Each agent reads the repo's folders in its own checkout, so a skill a branch adds is that branch's. The hub keeps its
skills as plain folders in its home (`skills/global/` and `skills/projects/<machine>/<project>/`), never in a repo, so
they never show in `git status`.

Claude Code's own skills (`~/.claude/skills`, plugins, the built-in ones) still load as they do outside fleetd. A skill
of yours with the same name as one of fleetd's is turned off for fleetd's agents: fleetd's wins.

## How an agent uses them {#agents}

Each time a session starts, the node puts the winning skills in a plugin for that session only, under the node's home
(`sessions/<id>/plugin`), and starts `claude` with `--plugin-dir` pointing at it. Claude Code then lists each skill to
the agent as `fleetd:<name>` with its description. The agent opens a skill with the Skill tool when it needs it, so the
rest of the text costs nothing until then.

Every new agent gets a skill as soon as it is added, edited or installed. A running session gets it with its next
message: the node writes it into the session's skills folder at once (`$FLEETD_SKILLS_DIR`, where the agent can read
it), and the session's skill list has it from its next start. A deleted skill goes the same way.

## Manage skills in the app {#app}

Open Settings → Skills. Pick **Global** or a project.

- **List**: every skill the agents of that scope get, marked with where it comes from. A skill that another source
  outranks says which one.
- **View and edit**: open one to read its `SKILL.md`. Project and global skills are editable here. Repo skills change
  in the repo.
- **New**: name it, write its `SKILL.md`, save.
- **Delete**: removes a project or global skill from the hub.
- **Install**: give a source and fleetd fetches its skills into the project or global scope:
  - `owner/repo`: every skill in a GitHub repo.
  - `owner/repo@skill`: one of them.
  - `https://github.com/owner/repo/tree/<branch>/<folder>`: a branch or tag, and a folder in it.
  - Any other git URL.

  The hub runs `git` to fetch the source. It finds skills as `npx skills add` does: a `SKILL.md` at the folder you
  gave, else the folders in `skills/`, `.agents/skills/`, `.claude/skills/` and the top level.
- **Update**: an installed skill is pinned to the commit it was fetched at, and nothing updates on its own. Update
  fetches the same source and branch again and moves the pin. An edit you made to an installed skill is replaced.

A lead can install skills too, with its `skill_install` tool, when you ask it to ("install
vercel-labs/agent-skills@web-design-guidelines for this project"). It installs from GitHub or other remote sources
only.

## Name a skill in the chat {#chat}

Type `$` in the composer to pick a skill by name. The message you send names it, and the lead's copy lists it with its
description, so the lead uses it or puts it in the brief of the agent it starts.

## Limits {#limits}

- A skill folder holds at most 64 files and 512 KB. The hub sends a project's and the global skills' text files to the
  node with each session start, up to 4 MB in all.
- A scope holds at most 200 skills.
- A skill never holds a secret: one that looks like it is refused. Name the secret instead, and the agent asks for it
  with `request_secret`.
