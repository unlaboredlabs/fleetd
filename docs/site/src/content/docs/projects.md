---
title: Projects
description: "Add a project or start a new one, choose who sees it, its branch, task profiles and settings, what its lead asks first, and how it plans the work."
---

A [project](/docs/glossary#project) is a chat with a lead, in a folder of its own, holding zero or more repos. Send
it work and follow that work to merged pull requests, or keep one with no repo as your own assistant: one for home,
one for taxes. Every project has the same abilities: memory, [automations](/docs/automations),
[screens](/docs/browser-sessions), [kept sign-ins](#sign-ins), [purchases](#purchases), [skills](#skills) and
[links to other hubs](#hub-links).

## Add a project {#add-a-project}

1. Add a GitHub repo. fleetd clones it onto a worker:

   ```sh
   fleetd project add https://github.com/acme/storefront
   ```

   Expected output:

   ```text
   cloning into /home/me/src/storefront on devbox
     starting
     receiving
     resolving
     inspecting
   ✓ ~/src/storefront cloned and added on devbox
   Lead needs: no CI found: the merge train holds its PRs until the repo has CI
   Default branch: main
   CI: none; required checks: none
   Merge: unprotected, squash allowed
   Write to its lead in the app's chat, or from any agent with chat_send; the lead starts with the first message.
   ```

2. Read the `Lead needs:` line. It names anything to fix or to know on GitHub before the first pull request, such
   as a repo with no CI.

### What you can pass

| You pass | fleetd does |
|---|---|
| A GitHub URL or `owner/repo` | Clones it onto the least busy online worker, into `~/src` (or `~/code`, `~/projects`). |
| A path, such as `~/src/storefront` | Adds that existing checkout on this machine. |
| A folder with no git, such as `~/notes` | Adds it as a plain folder: its lead chats, remembers and uses screens there. Agents that change code need a repo. |
| `--new <name>`, such as `--new "Field notes"` | Starts a new, empty project: the machine makes its folder. See [Start a new project](#start-a-new-project). |
| Nothing, in a terminal | Lists checkouts on every worker and your repos from `gh repo list`, to pick from. |

| Option | Does |
|---|---|
| `--machine <id>` | Clone to, or look for the path on, that worker. |
| `--dest <dir>` | Clone into that folder, or make a new project's folder there. |
| `--git-init` | With `--new`: run `git init` in the new folder. |
| `--only-me`, `--no-only-me` | Keep it to yourself, or share it with everyone on the hub. By default a project with no repo is [Only me](#only-me) and one with a repo is shared. |
| `--use-existing` | Add the folder's checkout when it already holds the same repo. Without a terminal, this is how you accept it. |

fleetd reads GitHub through `gh` on the hub machine, as the hub's [GitHub App](/docs/github/) where it is installed. A private repo clones on any worker where `gh auth login` was run.
When something is in the way, such as an offline worker or a folder that exists, it prints the command that fixes it.

### Start a new project {#start-a-new-project}

A project can start as a plain folder, with no repo. In the app, click **+** at the top of the sidebar
(**New project**) and type its name: the same box takes a GitHub URL to clone or a folder's path. The line above the
button names the folder and the machine (pick another there when you have several); check it and **Only me**, and
click **Create**. From a terminal:

```sh
fleetd project add --new "Field notes" --machine devbox
```

- The folder is `~/fleetd/projects/<name>` on that machine unless you change it.
- An empty folder that is already there is used as it is. A folder that holds files is refused, and nothing is added.
- It has no git unless you tick **Start a git repo in it** (`--git-init`).

The project opens at once and its lead starts with your first message. With no repo, the lead does the work
itself: it chats, remembers, writes drafts and notes, reads the web and uses screens in the folder. Agents that
change code need a repo. Add one when you need it in **Settings → Projects → Repos**, or with
`fleetd project repo add`.

### List and remove projects

```sh
fleetd project list
fleetd project remove devbox/storefront
```

`list` prints each project as `<machineId>/<projectId>`, its title and its folder; `--archived` includes archived
ones. `remove` stops the project's agents and erases it: see [Delete a project](#delete). Its files, branches and
worktrees stay.

### Repos {#repos}

A project is a lead and its own folder, holding zero or more git repos. A project added from a checkout holds that
checkout; add more to keep one lead across several repos.

```sh
fleetd project repo add devbox/storefront ~/src/api
fleetd project repo add devbox/storefront https://github.com/acme/web --name web
fleetd project repo list devbox/storefront
fleetd project repo remove devbox/storefront api
```

- **Add** takes a checkout on the project's machine, or a GitHub repo to clone there (with `--dest` and
  `--use-existing`, as for `project add`). The name comes from the remote or folder unless you pass `--name`.
- **The checkout stops showing as a project** while a project holds it. A checkout that was a project of its own is
  archived: its chat and history stay, and its lead no longer runs. fleetd refuses while its agents run.
- **One repo can be in several projects.**
- **The project's environment variables, MCP servers and skills** go to every one of its checkouts.
- **The lead's first message** lists the project's repos, and each agent works in the one the lead names: see
  [Agents in a project's repos](#agents-in-repos).
- **Remove** cancels that repo's running agents. The project's other work goes on. Nothing is deleted: the checkout stays
  on its machine and, once no project holds it, shows as a project of its own again. A project's own folder can't be
  removed this way; remove the project instead.

The same actions are in Settings → Projects → Repos, and agents have `project_repo_add`, `project_repo_list` and
`project_repo_remove`.

A project's lead adds and removes its own project's repos when you ask it in the chat: see
[What the lead sets up](#lead-setup).

## Project settings {#settings}

Open a project's settings in the desktop app: Settings → Projects, then pick the project, or **Open settings** in its
right-click menu. Its **Project** page has these, in order:

| Setting | Does |
|---|---|
| Icon | What its chat shows in the sidebar, the chat and on the phone: its bot, whose motion shows what the project is doing, or an image of your own. **Upload image…** (or drop a png, jpeg or webp on the icon); **Move and scale** lets you drag and zoom it before **Save**. The hub keeps only the circle's square, at most 512 px, without the file's metadata. **Remove image** brings the bot back. |
| Color | The bot's color: slate (the default), mono, blue, lilac, coral, amber, sage or teal, each tuned for the light and the dark theme. A pick shows at once on every device that sees the project. On the phone it's in the project's info, under **Edit** on its icon. |
| Name | How fleetd shows the project. Its folder keeps its own name. |
| Only me | Who sees and uses it. See [Only me](#only-me). |
| Repos | The git repos the project holds, each with its remote, base branch and checkout (machine and path). A plain folder holds none. **Add repo** and **Remove…**: see [Repos](#repos). Under them, each repo's **Setup**: what runs in its new worktrees. See [Setup commands](#setup). |
| Environment variables | Variables every new agent of the project gets. See [Environment variables](#env). |
| Linked hubs | Hubs its lead opens and follows work on. See [Hub links](#hub-links). |
| Approvals | Who approves its lead's sends and first visits, and what ran without asking. See [What the lead asks first](#approvals). |
| MCP servers | One list of the project's MCP servers: the ones its lead reaches for you, which follow Approvals and may sign in with your account ([Integrations](/docs/integrations)), and the ones its agents get too, by role ([MCP servers](/docs/mcp-servers)). Below them, the global ones it gets. |
| Sign-ins | **Forget sign-ins…** signs its browser out of every site. It shows once its machine keeps sign-ins for it; until then the row says "None kept yet." See [Sign-ins](#sign-ins). |
| Skills | **Open its skills** goes to the list on its Agents page. See [Skills](#skills). |
| Payments | The card it pays with, and its purchases. See [Purchases](#purchases). |
| Archive | See [Archive](#archive). |
| Delete project | See [Delete a project](#delete). |

Its other pages: **Agents** has its [max agents](#max-agents), the [task profiles](#models) it allows and its
[skills](#skills). **Instructions & memory** has its instructions, what its lead remembers, and **Refresh memory every
night**: on (the default), around 04:00 on a day with chat or orders, the lead tidies the project's memory and the chat
shows one line of its changes, with Undo; off, memory changes only as the lead and you write it. Beside the switch are
the refresh's hour, its next and last run, and **Run now**. See [The nightly refresh](/docs/what-agents-are-told#memory-refresh).
**Automations** has its [automations](/docs/automations). **Built-in prompts**, at the foot of Instructions & memory,
opens the prompts fleetd itself sends its agents.

The project's worktrees live on its machine in `~/.fleetd/node/worktrees/<project>/`, one per agent, each starting
from the repo's default branch, freshly fetched (see [Which branch](#branches)). The chat lists any the nightly
[cleanup](#cleanup) keeps, and Delete lists any with uncommitted changes.

### Environment variables {#env}

A project's variables live in its [Vault](/docs/vault): Settings › Projects › *project* › Vault (the project's
General page has a line with **Open Vault**). Add one at a time with **+ › Variable**, or paste a `.env` file with
**+ › Paste .env**. A pasted file may use `export`, quotes and `#` comments, and a quoted value may run over several
lines, as a certificate chain or a service account's JSON does. A name that looks like a credential (`STRIPE_KEY`,
`GH_TOKEN`, `DB_PASSWORD`) starts as a secret, and each one can be switched.

| Kind | Where its value lives | Shown |
|---|---|---|
| Plain | The hub's vault and the project's machine. | In the list. |
| Secret | The hub's vault, encrypted, and the project's machine. | As dots; its creator or an admin can [show it](/docs/vault#reveal) behind Touch ID or Face ID. |

A value is sealed in the app to the hub's own key. The hub keeps it encrypted in the vault and delivers it to the
project's machine, sealed to that machine's key, whenever it changes or the machine comes back online. The node keeps
the project's variables in a file of its own in `~/.fleetd/node/project-env/`, mode `0600`, and adds them to every
claude it starts for the project from then on. An agent already running gets a change at its next start. Your own
variables (Settings › You › Vault) reach your Only me projects and the orders you start, unless the project or the
order has the same name. Every start of an agent is in the vault's activity, by variable name.

If an agent prints a secret (`printenv`, a stack trace, a config dump), the node replaces it with `***NAME***` before
the output leaves the machine, in command output, the agent's replies and live text alike. Exactly these are masked:

- the whole value, and its base64 and URL encodings, and its encoding as a web form submits it (`+` for a space);
- for a secret of several lines, each whole line of 8 characters or more, wherever it appears. PEM armor lines such as
  `-----BEGIN CERTIFICATE-----` are the same in every file and stay readable.

Only exact matches are caught. Part of a line (`head -c 20` of a key, one field cut from a line), the value in another
encoding, or a value under 4 characters goes out as printed, so keep secrets out of output where you can. A line of a
secret is masked even where the same text comes from somewhere else, such as a generic line of a JSON file.

Lists show a secret by its name, fingerprint and size in bytes (the size counts toward the project's total), never
its value.

Names are letters, digits and `_`. fleetd sets `HOME`, `PATH`, `USER`, `TMPDIR` (and `TMP`, `TEMP`, `CLAUDE_CODE_TMPDIR`) and every
`FLEETD_` variable itself, and a project can't change how claude itself runs: `ANTHROPIC_*` and `CLAUDE*` names are
refused. A variable the node already gives every session, from its own environment or
[`claude.env`](/docs/config-and-files), keeps the node's value.

`HEAVY_LANGUAGE_SERVERS=1` turns Claude Code's heavy language servers (rust-analyzer and the like) back on for the
project's agents, at about 5 GB each: see [Heavy language servers are off](/docs/what-agents-are-told#language-servers).

| Limit | Is |
|---|---|
| Variables in a project | 100 |
| One value, plain or secret | 64 KiB, any number of lines, no NUL character |
| All of a project's values together | 512 KiB: every one goes into every agent's environment, and the system refuses to start a process whose environment is too large |

An agent that needs a variable no one set asks its lead for it by name; the value you enter then reaches only that
order's agents, until the order closes: see [A variable an agent asks for](/docs/approvals-and-secrets#order-variables).
Each agent's brief lists the variables it gets by name.

From an MCP client: `project_settings_get` reads a project's settings, `project_settings_set` renames it or sets
`setup`, and the [vault's tools](/docs/vault#clients) set and remove variables. For one release,
`project_env_set` (a secret sealed to the machine's `boxPubKey`) still works and its variables land in the vault. Both
take only a human key. Give either settings call a `repo` (a repo's name, such as
`api`) to read or set that repo's own `setup`; without one, or with the project's own directory's, it is the project's.

### Setup commands {#setup}

Each repo's **Setup**, under the repos (**Setup: api** and so on once the project has more than one): commands that
run in each new worktree of that repo, before its agent starts: install dependencies, generate code. The project's
own directory's is the project's; a repo without any runs none. One a line, in order; each runs with `sh -c` in the
worktree, with the project's variables (and the order's), the machine's build jobs and the agent's own `$TMPDIR`. The
first that fails, or runs past 10 minutes, stops the rest.

- Each command shows on the agent's thread in the app as it runs, with its exit code and the end of its output, and
  the agent's brief says what ran.
- A failure doesn't stop the agent: it starts anyway, and its brief names the command that failed, how it ended and
  the end of its output, so it can fix what it needs.
- **Skip when unchanged**: name the files whose contents decide what setup makes, such as `pnpm-lock.yaml`. A worktree
  set up before (a task restarted on its own worktree) is not set up again while the commands and those files are
  unchanged. With none named, setup runs every time.
- A worktree that is gone when its agent goes on (removed, or deleted) comes back and is set up again first. Setup
  counts as done only once it has run to its end: if the machine's fleetd stops in the middle, it runs again at the
  agent's next start. Stopping or interrupting the agent during setup ends it there, and the agent doesn't start.
- Readers and reviewers start ready to test. Their setup runs at most 5 minutes a command, and a failure never stops
  them: they hear what failed. Without setup commands, each app the PR touches gets its lockfile's install
  (`pnpm install --frozen-lockfile --prefer-offline`, `npm ci`, with the shared package cache). A finished
  reviewer's cargo `target/` goes to the next reviewer of the same checkout, so only what changed rebuilds; the machine
  keeps the newest two (`warmBuilds` in node.json) and drops any older than a week.
- Setup runs only in agents' worktrees, never in the project's checkout, and only on machines whose fleetd is new
  enough; the page says when it isn't.

### Only me {#only-me}

An Only me project is its owner's alone: only they see it and use it, in the sidebar, chats, approvals, screens,
**Hub links** and tools. Nobody else on the hub does, an admin neither. A shared one (Only me off) is open to everyone
on the hub, as every project with a repo is by default.

- **On by default** for a new project with no repo, and for every personal assistant an earlier fleetd made; off for
  a clone or a repo folder. The **Only me** switch in New project sets it as the project is made.
- **Who changes it:** its owner, or an admin, who may turn it off and share it with everyone on the hub (decision
  `projects.one-model`, D310). Only an admin turns it on for a project nobody owns, which then becomes theirs. On a
  hub from before people, a project made earlier belongs to the person whose device made it, else the hub's owner.
- **Your private life stays in it.** Keep family, health, money and accounts in an Only me project's memory, never in
  your user memory: every piece of work you start reads your user memory, so it holds only how you like to work.
  [Memory import](/docs/what-agents-are-told#memory-import) runs only in an Only me project of yours.
- **Its lead uses its owner's.** An Only me project's lead and agents run on its owner's Claude, and its lead's
  1Password fills ([purchases](#purchases), [secure input](#secure-input), logins) fall back on its owner's token. A
  shared project's lead has only the project's own `OP_SERVICE_ACCOUNT_TOKEN` variable.
- **Its automations' runs close themselves.** In an Only me project, an [automation](/docs/automations)'s run closes its
  order once the lead's turn for it ends; in a shared one, the lead closes it.

Your sidebar lists projects newest first, your pinned ones on top; pin one from its right-click menu. ⌘1–9 (Ctrl on
Linux and Windows) open the first nine.

### Sections {#sections}

Sections group your chats in the sidebar under names of your own. Right-click a chat and pick **Move to section**: it
lists your sections with a tick on the chat's own, **No section**, and **New section…**, which asks for a name. Or drag
a chat onto a section's label or onto one of its chats to move it there, and onto a chat in no section to take it out
of its own; while you hold it there, the chat says where it would go. A section is made with its first chat and goes
away with its last.

Under the pins, the chats in no section come first, with no label. Then each section sits under its quiet label, in
your order, its chats newest first. Click a label to fold the section to one line: its name, how many chats it holds,
and a dot when one of them waits on you or has a new message. ⌘1–9 skip the chats of a folded section. Which sections
are folded is kept on this computer. Right-click a label for **Rename…**, **Move up**, **Move down** and **Remove
section**, which puts its chats back on top and deletes none of them. A pinned chat shows among the pins only, and
keeps its section for when you unpin it. With [several hubs](/docs/several-hubs), each hub's group has its own pins,
chats in no section, and sections.

Your sections are yours: the hub keeps them, in your order, for each person, so they're the same on each of your
computers and on [your phone](/docs/mobile#sections). A teammate's sections never change your list, and each hub keeps
its own. A name is up to 40 characters, no two sections share one, and you can have up to 50. A project that's deleted
leaves its section by itself; an archived one keeps its place. A change shows at once; if the hub refuses it, the list
goes back and a notice says why.

### Archive {#archive}

**Archive**, in a project's right-click menu or at the end of its settings, takes it out of the sidebar and stops its
lead, with **Undo** in the notice. Its chat, memory, folder and settings stay. An archived project is still in
Settings › Projects, last and marked *Archived*, and its **Archive** setting says **Bring back**; it comes back as it
was, and its lead starts with your next message. A message to an archived project waits until you bring it back.

```sh
fleetd project archive devbox/taxes
fleetd project unarchive devbox/taxes
```

### Delete a project {#delete}

**Delete project…** stops the project's agents, removes the worktrees they worked in, and erases the project: one rule
for every project (D310). On the hub and its machine its chat, memory, skills, approvals and purchases, asks and
decisions, orders and tasks, automations, kept browser sign-ins, transcripts, attachments and screen recordings go, and so do its links to other hubs, each revoked on its hub. A machine whose node is older refuses the delete until you update fleetd there.
**Also delete its folder** (`removeFolder`) deletes its folder with everything in it; fleetd refuses that for a home
folder, its own directory, or a folder holding another project. Type the project's name to confirm. If any of its worktrees has uncommitted changes, the dialog names them:
those changes are lost. The app lists the worktrees again when you click it, so Delete waits while the project's
machine is offline or can't list them.

What stays, unless you delete its folder: the checkout itself, untouched, every branch (so every commit stays reachable), your own worktrees of the
repo, and its pull requests on GitHub. Add the folder again any time, as a new project with nothing it had; the toast
after a delete has **Add the folder again**. A project whose machine was removed from the hub has no worktrees to
list: its delete only forgets it in fleetd.

### Nightly worktree cleanup {#cleanup}

Some worktrees outlive their agent: a cancelled writer's, one whose pull request closed unmerged, a failed task's,
and any whose removal failed. Every night around 04:00, and once about 10 minutes after the hub starts, the hub removes
those of agents that finished more than 3 days ago. No model runs for it.

- Only a worktree whose work is safe elsewhere goes: no uncommitted changes, and every commit on a remote branch or
  already in the base. Its branch stays unless it merged, so every commit stays reachable.
- A worktree holding work that exists only there is kept, and the project's chat says so once: one line a night, like
  "Cleanup kept 2 worktrees with unsaved work", which opens to each one's task, what is unsaved and its path to copy.
  Push or delete that work, and the next night's cleanup removes it.
- One its machine couldn't remove (offline, a git error) is tried again the next night. After a week of failed tries
  the cleanup gives it up and says so once in the chat: delete it by hand if that machine is still in use.

The hour is 04:00 in the zone of the global decision `policy.tz`, else the hub machine's. To keep worktrees longer or
shorter than 3 days, record a global decision `policy.worktree_days` with the number of days (`decisions_record`).

## Which branch fleetd works on {#branches}

| What | Is |
|---|---|
| The base each writer branches from | The checkout's `origin/HEAD`, else its current branch. |
| A task's branch | `fleetd/T<n>-<slug>`, such as `fleetd/T1-fix-readme-typo`. Change the `fleetd/` prefix with `branchPrefix` in the [policy file](/docs/config-and-files#policy). |
| Where the merge train merges | Each pull request's base branch. See [Merge train](/docs/merge-train). |

The `Default branch:` line that `project add` prints is GitHub's default branch. fleetd uses it to watch main's CI and
to read its protection rules. To work against another branch, point the checkout's `origin/HEAD` at it on the worker:

```sh
git remote set-head origin release
```

## Its lead {#its-lead}

Each project has one [lead](/docs/glossary#lead) and one chat with it. Your first message starts the lead: there is
nothing to start by hand. See [Chat with the lead](/docs/chat).

If the lead can't start, your message waits and the chat says why. Common causes:

| Cause | Fix, on the worker |
|---|---|
| `claude` is logged out | `claude auth login` |
| `claude` is outside the supported versions | See [claude versions](/docs/troubleshooting#claude) |
| The worker is offline | See [Machines](/docs/troubleshooting#machines) |

Once the worker is back with a working `claude`, the lead starts and reads every waiting message.

### Agents in a project's repos {#agents-in-repos}

A project that holds [repos](#repos) lists them in its lead's first message, and the lead names the repo each agent
works in (`spawn_agent`'s `repo`). The agent's worktree and branch come from that repo's checkout, its new worktree
runs the repo's setup commands (or the project's, when the repo has none), and its policy file and the repo's own
skills are read from that checkout. Its pull request is on that repo. Without a `repo`, an agent given a PR, such as a
review, works in that PR's repo, and any other in the project's own repo, or its folder for a project with none. A
repo the project doesn't have is refused, with the project's repos. An agent whose repo is removed before it starts
fails, and its lead hears why. An agent in another repo always gets a worktree of its own, so it doesn't start in a
repo with no commits yet, nor run a reader on a machine whose fleetd is too old (update that machine).

A writer is checked for duplicates against the work in flight on its own repo only. The lead's `agents` list names
the project's repos (`Repos: R1 api, R2 web.`), and each agent's `repoId` says which one it works in.

### What the lead sets up {#lead-setup}

Ask the lead in its chat and it changes its own project itself, with no approval card, in every approval mode:

| You ask for | The lead calls | What happens |
|---|---|---|
| A repo, by GitHub URL or `owner/repo` | `repo_add` with `url` | It is cloned onto the project's machine, as **Add repo** does. The lead is woken when the clone ends, or when it fails, with the fix. |
| A repo that is already a checkout on the project's machine | `repo_add` with `path` | The checkout joins the project. |
| A repo taken out | `repo_remove` | As **Remove…**: its agents stop, and its checkout stays on disk. |
| A name, an icon, a picture or a color | `project_setup` | A picture is an image file in the lead's folder. An icon replaces a picture. |
| The project's instructions | `project_setup` with `instructions` | The whole text every agent of the project is told ([Your own instructions](/docs/what-agents-are-told#instructions)); empty clears it. |
| Setup commands | `project_setup` with `setup` | For the project or one repo: see [Setup commands](#setup). |
| A plain variable set or removed | `project_setup` with `env` | See [Environment variables](#env). A value that looks like a key or a password is refused: a secret goes through [secure input](#secure-input), which you fill in on your own device. A variable you set as a secret is not the lead's to change. |
| The project archived | `project_setup` with `archive` | See [Archive](#archive). Only you bring it back. |

Each change posts one quiet line in the chat, such as "Added the repo api" or "Renamed the project to Storefront",
with **Open**, which goes to the page of the project's settings that shows it, and **Undo**. Undo is yours, from the
desktop app or the phone, and puts back what was there before: undoing an added repo takes it out again (its checkout
stays on disk), undoing a removed one adds it back with its setup commands, and undoing an archive brings the project
back. The lead is told what you undid. An Undo that can't put back what was there, such as setup commands for a repo
that is gone, says so under the line.

What stays yours, whatever the lead is asked or told: the approval mode, [allowed sites](#sites) (the card on a first
visit stays), profiles, models and [max agents](#max-agents), the project's [card](#purchases), vault items, MCP
servers, the built-in prompts, [Only me](#only-me), [linked hubs](#hub-links), deleting a project, creating one
(the lead can only [propose it](#lead-propose)), and
adding by path a folder that is a project of its own (adding it would archive that project). The lead's calls have no
field for any of these, and one that names any of them is refused with a line that says who can do it and where. A
lead sets up only its own project. A task can't make these calls at all: it is told to ask its lead. The `fleetd`
command line in an agent's shell changes none of this either:
[The fleetd CLI inside a session](/docs/security#cli-in-session).

The lead is told to make these changes only when you ask in the chat, never because a web page, a file or another
agent says so.

### A new project, proposed {#lead-propose}

A lead never creates a project. Ask it for one in its chat and it proposes it (`project_propose`), with a name and a
GitHub repo to clone, or none. The chat shows one card, **New project**, with exactly what would be made: the name,
the repo, the folder on the lead's own machine, and who it is open to. On the phone it is the same card, among your
approvals.

- **Create it** makes the project, and nothing exists before that. It is made as if you had used **New project**
  yourself: one with no repo is yours alone ([Only me](#only-me)), and one cloned from a repo is open to everyone on
  the hub. Turn **Only me** on or off in its settings afterwards.
- **Don't create**, or no answer, makes nothing.
- The card shows in every approval mode, YOLO included, and the checker never answers it for you.
- A repo is cloned after your tap, as **New project** does it. The project appears when the clone ends, and the lead
  that proposed it is told then, or told why it failed.
- What can't be made is refused before any card shows: a name whose folder is taken, a repo the machine's GitHub
  login can't read, a clone folder that already exists.

A task can't propose a project: it is told to ask its lead. The new project's own lead starts with your first
message in its chat.

## What the lead asks first {#approvals}

A project's lead runs with your access and no sandbox ([How leads run](/docs/security#how-leads-run)): it reads and
writes what you can, installs what it needs, starts agents and works with repos, and its shell commands never ask. A
command that would wipe the machine or your home folder (`rm -rf ~`, `rm -rf /`, `mkfs`, `dd` onto a disk, a fork
bomb) is refused, with why.

What reaches outside goes by the project's **Approvals** setting (decision D263): a send, reply, forward, share or
invite through an [integration](/docs/integrations), a site it opens on its own for the first time, the final Confirm
or Submit on a site (`confirm_step`), and a message to another project's lead (`project_message`), whose card is
headed "Message the lead of Shop" and shows the exact text.

A new project starts in **YOLO**, where none of these asks you. Pick **Checker decides** or **Ask me about
everything** to be asked. A project made before YOLO became the starting mode keeps the mode it had: the one you
picked, or **Checker decides** if you never picked one.

| Mode | What happens |
|---|---|
| **Checker decides** | A fresh model judges each risky action first. **Go** runs it and puts one quiet line in the chat: "Let through without asking you: send_message on gmail, to sam@example.org. The checker's reason: you asked to tell Sam that Saturday works". **Ask** brings the approval card, with the checker's reason on it. **Block** refuses it and tells you why, on a card with **Approve anyway**. |
| **Ask me about everything** | Every risky action waits for you on a card. No checker runs. |
| **YOLO** (a new project starts here) | No checker runs and nothing asks, not even for the cases fleetd's own rules ask about below (a recipient only an email named, a public share, a link carrying data). The floors still hold. Nothing shows in the chat; each action is still in the log below. |

A card shows in the chat with **Approve** and **Deny**, and the sidebar marks the project *approve* until you answer.
**Approve** runs the tool with exactly the input shown; **Deny** tells the lead you said no, with your reason if you
give one. A prompt that goes away on its own (the run ended) closes its approval.

### Sites {#sites}

A link you write in your own chat message is allowed as you send it, so the lead fetches or opens it without asking.
A link it finds itself, or reads in an email or on a page, isn't: the first time it fetches a page or opens a site in
its browser, the approval mode decides, with the site named. Approve once and it fetches and opens that site unasked
from then on.

- In a browser command the URL must stand alone, plain or in single quotes
  (`agent-browser open 'https://example.org/a?b=c'`). Double quotes, shell characters, an `agent-browser open` inside
  a longer command, or a flag that changes the browser (`--session`, `--cdp`) asks each time.
- `www.` is the same site, a subdomain is another, and `localhost` is a site per port (`localhost:3000`). Only `http`
  and `https` name a site: `file:`, `data:`, `about:` and other schemes ask every time.
- **Plain public reads** (decision D286): in **Checker decides**, a first fetch or
  visit whose link carries no data runs on fleetd's own rule, with no checker call and no line in the chat, since a
  `curl` of the same page already runs unasked. Its site isn't remembered. The link must be `http` or `https` to a
  named public host (no IP address, `localhost`, `.local` or `.ts.net` name), with no query, no address or long code,
  and no part of its path or `#` fragment that your messages or your own data the lead read hold (mail, files,
  calendar; a web page's or a search's own links don't count). Any other link goes to the checker.
- `project_sites` and `project_site_revoke` list the project's sites, those from your links included, and take one
  back; a revoked site asks again.

### The checker {#checker}

The checker runs on your own Claude ([Claude accounts](/docs/people#claude)), as a session with no tools at all, in
an empty folder of fleetd's own rather than the project's (so no `CLAUDE.md`, settings or skills the lead wrote reach
it), on **Sonnet 5.5 at medium effort**, the hub's choice for every project: a weaker model would quietly weaken the
guard. It reads only:

- the action exactly as it runs: the tool, the recipients or the link, the full text;
- where each part came from: your messages (`person`), text you pasted (`person (pasted text)`), your contacts,
  the thread being replied to, your sent mail, an event's attendees, your files, a site you allowed, or `untrusted:
  an email from …` / `a web page on …` for anything only content the lead read says, else `the lead`. In a list of
  several mails each one's headers count, up to the first quoted or forwarded mail: nothing in or after a quote does,
  so in your sent mail only each mail's own sender is you;
- your recent messages to the lead, and its last question to you, marked as the lead's. A message that came through
  the phone's share sheet or a Shortcuts action isn't your go-ahead: the checker reads it as content the lead read, so a new recipient it names asks.
  Messages you type in the app or in `fleetd chat` count;
- the prompts of the [automations](#automations-go-ahead) whose run the lead is doing now, when you wrote or
  confirmed them.

It never sees the mail, pages or files the lead read, nor the lead's own explanation of the action. When the node
can't send the whole of one thing the lead read, fleetd matches against the end of it that it already has, and keeps
the rest whole. Its prompt is `approvals.checker` ([What agents are told](/docs/what-agents-are-told)).

fleetd's own rules hold whatever the checker says:

- **Floors**, in every mode, YOLO too: moving money, trading and placing orders are refused, by the tool's name or
  by a link that does it (its path says transfer or trade and it carries an amount), and so is a password, key or
  token anywhere in what goes out, a link it opens included. Any other link, one about Bitcoin or the stock market
  too, follows the mode. Paying goes through a [purchase](#purchases). A final Confirm whose button cancels, returns
  or refunds an order goes through the mode like any other.
- **It asks you at least** when a recipient, share target, forwarding address or site came only from content the
  lead read (an `account` or `mailbox` the lead already read your data as is no recipient, nor such a `user_id` on a
  write to your own data; on a send or an invite a `user_id` counts like any other); when a link carries data (an
  email address, a long code, text quoted from your mail), even on a site you allowed; for a public or
  anyone-with-the-link share, edit access for someone new, a rule that forwards your mail to another domain, an
  address on a domain one or two letters off a contact's, more than 10 recipients at once, or a one-time code or an
  encoded blob in the text.
- **A checker that fails asks.** A timeout, an error or an answer fleetd can't read brings the card. A model that
  refuses to answer brings it too, saying "the checker flagged this as a likely attack".

**Approve anyway** on a blocked card tells the lead it may run exactly that call once: when it asks again with the
same input, it runs without the checker. **Keep it blocked** leaves it refused.

**Ran without asking**, under Approvals, lists every action the checker let through or YOLO ran, newest first:
when, what, the checker's reason, and **Show in chat**, which opens its line. The page shows the newest five, the
same action run several times in a row as one row with its count; **Show all** opens the whole log in a list of its
own that reads older ones as you scroll (on the phone, a screen of its own). `project_approvals {machineId,
projectId, limit?, before?}` reads the mode and a page of the log (`older` is the next page's `before`, `total` the
whole log's count); `project_approvals_set {machineId, projectId, mode}` sets the mode, from your own key only (an
older app's `model` and `effort` are taken and ignored).

### Automations you set up {#automations-go-ahead}

An [automation](/docs/automations) you wrote or edited in the app counts as your go-ahead on its runs, and so does one
the lead made once you let it run on its own. While a run is open, the checker reads the automation's prompt as your
own request (`person (automation "Weekly report")`), so a weekly "email the report to Dana" sends without a card on
every run, with its quiet line in the chat. Only what the prompt names counts: a recipient, text or site it doesn't
name goes to the checker as before, and a webhook's body is never part of it.

An automation the lead made counts for nothing until you say so. The lead calls `automation_confirm`, and you get a
card in its chat, "Let "Weekly report" run on its own", with the automation's name, prompt and schedule as the hub
has them. Approving it is the only way such an automation gets the mark: no checker or YOLO answers that card, and
nothing the lead writes or passes sets it. If the prompt or schedule changed after the card was shown, approving it
marks nothing. When the lead later changes the prompt or schedule, the mark goes and it asks again.

### A final Confirm, and what commands can still do {#confirm-step}

Before the last click of a step that doesn't pay or order (booking a table, cancelling a subscription, sending a
form, an expense, a return, a post), the lead calls `confirm_step` with the site, the button, what it does and a
screenshot. It goes through the mode like a send: on a card you see the screenshot, and **Click it** lets the lead
click. A Pay, Buy or Order button never goes this way: that is a [purchase](#purchases).

This is enforced outside the model. The lead runs in Claude Code's `manual` permission mode with an allow-list
([Agent tools](/docs/reference/agent-tools#claude-code-tools)). The node answers its commands, and every other prompt
goes to the hub, which allows a site you allowed before or linked in your message and decides the rest by the mode.
Through a command or a screen, a send is the lead's instruction, not fleetd's rule: it runs such a command with
`gated_run`, which asks with exactly that command.

The site gate covers fetching and opening a site; it doesn't follow a page after that, or a command's own network
use. Browser commands inside an open page run unasked: clicks, fills, typing, snapshots, a script in the page. A
command such as `curl` reaches the network unasked too, and so do the project's agents, which never get an
integration. A click or a form that leads to another site isn't asked, and Android, iOS and desktop screens
(`agent-device`) don't ask per site at all. That the lead calls `confirm_step` before a final click is its prompt,
not fleetd's rules.

## Purchases {#purchases}

A project can book a hotel or a flight, or buy something online, with a card in the [vault](/docs/vault). You aren't
asked (decision `projects.one-model`, D310): each purchase goes in its purchases log, fleetd fills the card into the
checkout, the lead never sees it, and the chat says what was paid. Any project's lead can pay, except an archived one's.
Make it a virtual card with a monthly limit or a low-limit card ([why](/docs/security#agent-reach)).

1. **Pick a card.** In the project's settings, **Payments › Pick a card…** lists the vault's cards the project's work
   can use: its own, yours shared with it (or any of yours, in an [Only me](#only-me) project), and the hub's. **Add a
   card…** and **Import from 1Password…** are beside the list, and pick the card they add. fleetd keeps `vault:<id>`.
   On a hub without the vault, Payments lists the Credit Card items the project's 1Password token reads instead, and
   keeps their `op://vault/item` reference; a hub with the vault imports that card once.
2. **The lead records it.** At the checkout's payment step it calls `purchase_request` with the shop's domain and
   name, the total and currency, and what is in the basket. The page must be on that domain. Your chat shows its
   record: the shop, the total, each item, and the card.
3. **The card is filled.** Within 15 minutes the lead calls `purchase_fill`. The hub seals the card to the node
   hosting its browser, once for that purchase, and the node types the number, expiry, security code and name into the checkout's fields: on the shop's own page and in the
   card frames of payment providers (Stripe, Adyen, Braintree, Checkout.com, Square, PayPal, Mollie, Worldpay), even
   when they're on another site. It fills once per purchase, and only on its shop. The chat gets a quiet line: "Paid
   129.90 EUR at Hotel Adlon with Visa ••4242". The card's activity in the vault lists each payment.
4. **The lead pays.** It checks the total and clicks Pay or Book itself. If your bank asks to confirm (3-D Secure, a
   code, its app), it hands the browser to you with a takeover, and finishes once you hand it back.

| | |
|---|---|
| What the lead sees | Never the card's number, expiry or code. From the fill on, its browser session refuses to read values back (scripts of its own, `get value`, page snapshots). Every answer it gets, its transcript and the recording are scrubbed of the card. Filled fields show as blurred dots in the video, the live view and screenshots. |
| Wrong shop | A request whose domain isn't the page's is refused. A fill on any other site gets nothing; the purchase stays good for the shop until its 15 minutes run out. |
| Never | Paying an exchange or a broker (trading, crypto) or a money-transfer service is refused. That's decided by who is paid, not by what the basket says: an airport transfer is a purchase like any other. A command of a payment CLI (`stripe`, `shopify`, `paypal` and the like) through `gated_run` only you can approve. |
| Unfilled | A purchase whose card isn't filled within 15 minutes ends as expired. |

**Payments** in the project's settings also lists every purchase it made: the shop, the amount, when, and whether
its card was filled.

## Secure input {#secure-input}

Some pages need something only you may give, which the lead must never see: a passport or ID number, a code texted to
you. The lead doesn't ask for it in the chat. On that page it calls `request_secure_input` with the site, the field and
why, and fleetd checks the page is on that site and the field is there.

- **You type it.** The chat shows a sealed field: the site, what it is and why. What you type is sealed on your device
  to the project's machine, whose node types it straight into that field on that site (in its frames too), once. The
  phone app shows what is asked and sends you to the desktop app to enter it.
- **From 1Password.** If it's in an Identity, Passport, Driver License or Social Security item, the lead names that
  field (`op://vault/item/field`), and its node fills it from 1Password, once, within 15 minutes, with the token a
  [purchase](#purchases) uses. You aren't asked (D310).

The value never reaches the lead, the chat, a transcript, a recording or a log. From the fill on, the project's
browser session refuses to read values back, and the field shows as blurred dots. A page that moved to another site
gets nothing.

## Sign-ins {#sign-ins}

The browser of a lead that does its own work (one whose project has no repo) stays signed in. Sign in to a site
once, yourself in a takeover or by the lead, and its next browser session is still signed in there. No login page,
captcha or approve-on-your-phone step each time. A lead with repos gets its browser placed by the hub, as an agent
does, on a fresh profile.

- **What's kept:** the browser's cookies and site data (local storage, IndexedDB), in a browser profile of the
  project's own. Its history, cache, open tabs, saved passwords and form entries are not kept. Logins filled from
  1Password aren't saved either: each session that fills one still refuses to read it back.
- **Where:** on the project's machine, under fleetd's node directory (`browser/kept/<project id>`; a project from an
  earlier fleetd keeps `browser/navis/<project id>`). Only the browsers fleetd starts on it use them, though with no
  sandbox the lead's own commands could read them, as yours can.
- **Whose:** that project's alone. Another project's lead keeps its own, and agents each start with a fresh, empty
  profile that is thrown away when the session ends.
- **One at a time:** one browser runs on the profile. If the lead opens a second session while one is open in another
  of its chats, the second is refused until the first ends.
- **Its machine only:** the lead's browser always runs on the project's own machine, where its profile and folder
  are, never on another one the hub would pick.
- **Your own screens:** a browser you open for the project on its own machine runs on the same profile, so a site you
  sign in to there stays signed in for the lead. While the profile is busy, yours opens on a fresh one, and so does
  one on another machine.

**To sign it out of everything,** open the project's settings (**Open settings** in its right-click menu), find
**Sign-ins** and click **Forget sign-ins…** (shown once its machine keeps sign-ins for the project). A browser session it has open now ends, and the profile is deleted. Its
chat, memory, folder and allowed sites stay. Deleting the project deletes its sign-ins too. To sign out of one site
only, ask the lead to sign out there.

## Hub links {#hub-links}

A project's lead can open and follow work in projects on another hub, such as a team hub when the project lives on
your personal one. You make a link key on the hub it reaches and add it to the project. It acts as you there, and
either side can revoke it. [Security](/docs/security#hub-links) has the rules.

**On the hub it reaches.** Open **Settings › Hubs & devices**, **Hub links**, **Links to this hub** (with several hubs, *Links
to* that hub), and click **Make a link key**:

1. Name the other hub as you think of it, such as *home*. Requests through the link read "*you* via home" there.
2. Leave **Every project you can reach**, or pick **Only some projects** and tick them.
3. **Make link key** shows the key (`flk_…`) once. **Copy** takes it with the address other hubs reach this hub
   at: its HTTPS or tailnet URL. When the hub has no such address set, type it in the box that appears.

The list below shows the links made as you: what each is for, its projects, when it was last used, and **Revoke**.
Signing out the device you made a link on revokes the link too.
An admin sees everyone's on **Settings › Hub › People**, under **Hub links**, each with the person it acts as.

**On the project's hub.** Open the project's settings, **Linked hubs**, and click **Link a hub**. Paste what you
copied into **Link key**: the address fills itself. Name the hub as the lead should call it (*acme*), then click
**Link hub**. The app seals the key to this hub, which checks it with the other hub and never shows it again. Then
tell the lead what you want ("ask the Shop lead on acme for saved carts"). It follows the order and tells you when it
lands.

Each linked hub shows its address, the person it acts as there and its projects (*only Shop, Website*, or *every
project of theirs*), and one word for its state:

| State | Means |
|---|---|
| Working | Its last call went through. |
| Can't reach | This hub can't reach the other one. The row gives the address and the reason, such as *connection refused*. A link needs the other hub reachable from this one over a tailnet or HTTPS. |
| Revoked | The other hub refused the key: it was revoked there, the device it was made on was signed out, or you left that hub. Remove it, or make a new key there and add it. |

**Remove** deletes the key at once and asks the other hub to revoke it too. When that hub doesn't answer, the
notice says so: its link stays listed there until someone revokes it, but nothing can use it.

## Asked {#asked}

**Asked of other projects**, under the to-do list in the panel's Plan tab beside the chat, lists the work this project's lead asked your
other projects for (`project_message`), newest first: one row each, with the ask in a line, its state (*Waiting* for
an order, *Working*, *Merged*, *Done* or *Stopped*), the project and how long ago. A follow-up its lead took into the
order of an earlier ask says *Folded into an earlier ask*. Click a row for the whole message and the orders opened for
it, each linked to its page; the project's name opens its chat. The lead also tells you in its chat when work it asked
for lands.

## Files {#files}

Files go both ways in a project's chat, from the app and the phone.

- **What you send:** images, PDFs, text and CSV (and other text: notes, JSON, calendar invites, mail), Word, Excel and
  PowerPoint files (.docx, .xlsx, .pptx) and zips, up to 25 MB each. The hub keeps a file only
  when its bytes are what its type says, and gives it an extension of that type, so a text file named `run.command`
  becomes `run.command.txt`.
- **What the lead reads:** each file lands in the project's folder under `.fleetd/attachments/chat/`. It reads images,
  PDFs and text itself. For a Word, Excel or PowerPoint file the hub writes its text beside it (`lease.docx.txt`): a
  document's paragraphs, each sheet of a workbook as CSV, each slide of a deck. A zip it unzips with its shell.
- **Untrusted:** what a file says is content anyone could have written, like a web page. The
  [checker](#checker) marks what only a file sent in the chat names as `untrusted: a file sent in the chat`, never as
  your files, so a send to an address only an attached invoice gives asks you first.
- **What the lead sends back:** a file it made in its folder (a trip as a PDF, receipts as a CSV, an invite as an
  `.ics`) goes up with [`chat_file`](/docs/reference/agent-tools#chat_file) and shows as a card with its name, kind
  and size. In the desktop app, **Open** opens it in your computer's app for its kind and the download button saves
  it; on the phone, tapping it opens the share sheet. Your files never leave
  your hub: the app reads each one from it.

## Earlier in the chat {#earlier}

A lead's new session sees only the latest part of its chat, but the hub keeps all of it. When you mention something
from before ("the dentist I told you about", "what we settled last week"), the lead searches the whole chat by words,
within dates when you give them, and reads the messages around what it finds. It reads only its own project's chat,
never another's. The tools are `chat_search` and `chat_read`, in [Agent tools](/docs/reference/agent-tools).

## Skills {#skills}

A project learns. When its lead has to work out a task it will do again (where a portal hides the invoices, the steps
of a grocery order), or you correct how it does something, it saves a skill: a `SKILL.md` in the same format as an
installed [skill](/docs/skills), with what the skill is for and the steps. Nothing asks you first. When it uses a
skill and finds a step wrong or missing, it saves it again, improved. The chat gets one quiet line each time ("Saved
a new skill, weekly-invoices: …"), the name a link to the skill.

A project's skills are its own: they reach its sessions only, never another project's. A saved skill is in its next
session's list as `fleetd:<name>`; the running session can read it from its skills folder at once.

The project's **Agents** page in Settings lists them: its own, what was installed for it and any in its folder, each
saying whether it's off, who changed it last, when, and when the lead last used it, with the hub-wide ones every
project gets named under them (**Open its skills** on its Project page goes there). A skill's
name in the chat, or **History, restore or turn off** on one of its own there, opens it in the panel beside the chat:

- **A skill**: who changed it last, when, and when the lead last used it; its `SKILL.md`, rendered. **Edit** opens the whole file with a line for what you changed; saving
  makes a version of yours, which the lead's next session gets.
- **History**: every version, newest first, with who wrote it (the lead or you), when, and why. Open one to see what
  it changed against the one before. **Restore** puts an older version back as a new version, so nothing is lost.
  The hub keeps the newest 100 versions of each skill.
- **On**: turn a skill off and the project's sessions stop getting it, without deleting it. A lead that saves an off
  skill again is told it stays off until you turn it back on.
- **Delete**: removes the skill and its history.

An installed skill stays yours: the lead doesn't change it, and saves its own version under another name. The tools
are `skill_save` and `skill_install`, in [Agent tools](/docs/reference/agent-tools). Each skill it installs posts a
quiet line in its chat naming the source and the commit it's pinned to, such as *Installed the skill pdf from
acme/skills@0123456789ab*.

## For the app and other clients {#clients}

A new project is `project_add {create: true, title, machineId?, gitInit?, onlyMe?}`; `project_settings_set
{machineId, projectId, title?, onlyMe?}` renames it or changes [Only me](#only-me); `project_archive {machineId,
projectId, archived?}` archives it or brings it back. A project summary says `onlyMe`, its `owner`, `createdBy` (the id and name of the key that made it)
and, once archived, `archivedAt`; for one more release a former Navi's also says `kind: "assistant"`, which older apps
read, and the `navi_*` tools still answer as aliases. Its bot's color is `project_settings_set {machineId, projectId,
avatarColor}`, one of `slate`, `mono`, `blue`, `lilac`, `coral`, `amber`, `sage` and `teal`; a summary's `avatarColor`
says which it wears, and has none for slate. Its picture is `project_avatar_set {machineId, projectId, attachmentId?,
crop?}` (an image from `attachment_put` and the square to keep; no `attachmentId` removes it) and
`project_avatar_get {machineId, projectId}`; a summary's `avatar` names the one it has.

| What | Tools |
|---|---|
| Sites | `project_sites {machineId, projectId}`, `project_site_revoke {machineId, projectId, site}` |
| Approvals | `project_approvals {machineId, projectId}`, `project_approvals_set {machineId, projectId, mode, model?, effort?}` |
| Payments | `project_purchases {machineId, projectId}` reads its card and purchase log; `project_card_set {machineId, projectId, card?}` picks its card (a person's own device only) from `onepassword_cards {machineId?, project?}`, the Credit Card items their 1Password token reads (the project's own token's, when it has one; refused in a shared project without one). |
| Asked | `project_asks {project}`, with the orders opened for each, on a hub whose ready frame names the `navi_asks` feature. |
| Sign-ins | `project_signins_forget {machineId, projectId}`; it needs the project's machine online and on a fleetd that keeps them. |
| Hub links | `hub_links_get {project?}`, `hub_link_mint {label, projects?}`, `hub_link_revoke {linkId}`, `hub_link_add {project, label, url, sealed}` (the key sealed to `boxPubKey` from `hub_links_get`), `hub_link_remove {linkId}` |

A project's [skills](#skills) are `scope: "project"` skills with its `projectRef`, on a hub whose ready frame names
the `navi_skills` feature. `skills_list {projectRef}` gives each with `changed` (its newest version: `version`,
`author` `agent` or `person`, `by`, `at`, `why`), `off` and `lastUsedAt`. `skill_get {origin, projectRef, name,
version?}` adds `versions`, newest first, without their texts; with `version`, its text is that version's.
`skill_set {scope, projectRef, name, text, why?}` is the person's edit, `skill_revert {scope, projectRef, name,
version}` puts a version back as a new one, `skill_off {projectRef, name, off}` turns one off in that project, and
`skill_delete` removes it with its history. A chat message with `skillSaved {name, version, created, why,
installed?}` is the line a save posts; `installed` (`<source>@<commit>`) marks one a `skill_install` posted.

## Max agents {#max-agents}

Each machine runs as many agents at once as it fits, and each project has a cap of its own. The hub enforces both; the
lead plans to them.

| Cap | Counts | Default | Set it |
|---|---|---|---|
| Per machine | Every project's agents on the machine. Not the leads. | Auto, what it fits: one per CPU less one in eight, and 2 GB of memory each after a quarter of it (4 to 16 GB) is left for the system, at most 64. An 8 GB laptop fits 2, a 32 GB one 12, a 60 GB one 22. | The machine's page in Settings › Hub › Machines → Max agents; "Use auto" goes back. Owners and admins only. |
| Per project: Max agents | The project's agents: writers, readers, reviewers. Not the lead. | Its machine's cap: it follows a change to it at once | Settings → Projects → Agents: the gear at the end of the panel's row opens the project's settings, and **Max agents** in the command palette its slider. Once set it is the project's own, which no machine change moves; "Use the default" goes back. Past its machine's cap, the slider says the machine holds it there until an admin raises the machine. |
| Fleet-wide | Every project's agents together. Not the leads. | None: the machines' caps added up | Only from a terminal or an MCP client, with an admin key (below); the app has no slider for it. A fleet cap saved before stays until you change it, and while it holds the machines below their total, Settings › Hub › Machines says so. |

New agents on a machine also wait for disk: 5 GB each above the free-space floor (`minFreeGb`), with agents started
in the last 10 minutes still counted, since their worktrees haven't grown yet. The lead's state line names what sets
its cap, e.g. "agents: 4 running of 6 (auto: memory 18 GB, about 2 GB an agent), 2 queued, 0 free", or "fleet cap
set", "machine cap set" and "max agents set". When slots have sat free for 10 minutes, with no agent starting or ending,
while approved work is open, the state says so in one line, and the lead splits that work into parts whose files don't
overlap and runs them at once.

The memory figure only sizes a machine's auto cap. No agent waits for the memory it might take: a Max agents you set
starts that many, as far as the machine's cap and disk allow, and a machine you set runs that many whatever it is
estimated to fit. Memory in use and CPU load don't hold new agents back either: builds take turns for the machine's
[build slots](/docs/machines#fair-share) instead.

The Agents tab shows "2 queued" when agents wait their turn. While you move the slider it says what the change will do; it
applies when you let go, with Undo.

Writers in a project run side by side, each in its own worktree and branch. The lead gives them slices that touch
separate files; if two PRs still conflict, the [merge train](/docs/merge-train) sends the later one back to its writer.

![Settings › Projects › Agents: Max agents per project, with storefront set to 12 ("Set for this project. The default is 16.", Use the default, "6 agents running now"), billing at 3 with 3 running and 2 queued, and checkout following the hub's fleet cap of 16.](/docs/img/max-agents.png)

From a terminal:

```sh
fleetd project set devbox/storefront --max-agents 3
fleetd project set devbox/storefront --max-agents 2 --pause-extras
fleetd project set devbox/storefront --max-agents default
fleetd project set --fleet-cap 20        # needs an admin key
fleetd machine set devbox --max-agents 40   # needs an admin key
fleetd machine set devbox --max-agents auto
```

From an [MCP client](/docs/mcp-clients): `cap_set {project: {projectRef, maxAgents, pauseExtras?}}` with an operate
key (`followDefault: true` in place of `maxAgents` goes back to the default), or `cap_set {cap}` for the fleet cap with an admin key, or `cap_set {machine: {machineId, maxAgents}}` for a machine with an
admin key (`auto: true` in place of `maxAgents` goes back to what it fits).

When the cap is reached:

- A new agent **queues**; it doesn't fail. The lead is told its place in line, and the hub starts it the moment a
  slot frees.
- New agents also wait while their machine is short of disk or its Claude login nearly out of a usage window ([Disk and usage](/docs/machines#guard)).
- Reviewers count toward the cap, but a review that gates a merge goes first, so a low cap never stalls
  the merge train.

Changing it while work runs:

| You | What happens | The line in the chat |
|---|---|---|
| Lower the cap | Running agents finish their current work; new ones wait. Nothing is killed. | Max agents 6 → 3: 6 running finish their work; new agents wait. |
| Lower it, then click "Pause the 3 extras now" ("Pause the extra one now" for one) | Agents over the cap push their work in progress and wait. Each resumes when a slot frees. | Two lines: Max agents 6 → 3: 6 running finish their work; new agents wait. Then: Max agents 3: 3 agents push their work and wait; 3 keep running. |
| Raise the cap | Queued agents start at once, and the lead is told how many slots are free. | Max agents 3 → 6: 2 queued agents start now, 1 slot free. |

The lead plans to the cap: at most that many slices at once, the rest queued by value, each slot filled as it frees.
It never works around the cap: it doesn't do a writer's work itself, or ask you to raise it unless you asked about
speed. At a cap of 1 it works one piece at a time and says so once.

## Models and cost {#models}

Every agent runs on a task profile: a name, a one-line note on what it is for, a model, an effort and fast mode. The
hub keeps any number of them, and one is the default. Leads start on the default too, unless a profile is picked for
them (**Lead runs on**). A new hub has two:

| Profile | Runs | For |
|---|---|---|
| `high` (default) | `claude-opus-5-5` at effort high | Every review, claude's helper calls (session titles and the like), every task the lead names no other profile for, and the lead while no other profile is picked for it. |
| `medium` | `claude-opus-5-5` at effort medium | Mechanical tasks only: dead-code deletions, renames, test removals, doc fixes, moving files, plain wiring, screenshot recaptures, cleanup. Never design, architecture or anything subtle. |

A project allows the default and the profiles it picks; nothing else. Its lead is told each allowed profile's name and
note, and names one in `spawn_agent` when the note fits the work; `spawn_agent` refuses a profile the project doesn't
allow and says which it does. A task on another profile whose review finds blockers twice is redone on the default.
Each agent's profile shows on its lane (`T12 medium`), and the time view splits agent time and output tokens by
profile.

| To change | Do |
|---|---|
| Which profiles a project allows | Settings → Projects → Agents → **Allowed profiles**: a checkbox each, the default checked for good. Or `fleetd project set <machine>/<project> --profiles medium,quick` (`none`: the default alone). |
| A profile's model, effort, fast mode or note, or which is the default | Settings → Hub → Every project → **Profiles** (owners and admins): New profile, Edit and Delete. Or `fleetd project profile <name> --model claude-sonnet-5-5 --effort xhigh --key-file <your human key>`: a name that doesn't exist yet makes a new profile; `--delete` removes one. |
| Which profile leads run on | Settings → Hub → Every project → Agents → **Lead runs on** (owners and admins): any of the hub's profiles, the default until another is picked. Or `fleetd project profile <name> --lead --key-file <your human key>`. Every project's lead starts on it at its next start, or when an admin [restarts the hub](#lead-profile) from Settings › Hubs & devices; reviews and tasks that name no profile stay on the default. Members see it on a project's Agents page, under Allowed profiles, with who to ask. |
| How the lead picks | Edit the **Task profiles** prompt (`lead.profiles`) like any [prompt](/docs/what-agents-are-told), or a profile's note. It takes effect at the lead's next start. |

### What a profile runs on {#profile-settings}

A profile's model is one of the models the hub's Claude configuration offers: what the Models API lists on the hub's
API key when it has one (Settings › Hub › Setup › Claude), else fleetd's own list of current Claude models. Its effort is
one Claude Code takes: low, medium, high, xhigh or max; a model without that level runs the nearest one below. Fast
mode is Claude Code's (`"fastMode": true` in the session's settings), only on the models that have it (Opus 5.5, Opus
5 and Opus 4.8), at a higher price per token.

`fleetd project profiles [<machine>/<project>]` lists them, and with a project which it allows:

```text
high       claude-opus-5-5 at high (default, allowed)
           The default: design, architecture and anything subtle. When in doubt, this one.
medium     claude-opus-5-5 at medium (allowed)
           Only for mechanical work: dead-code deletions, renames, test removals, doc fixes, moving files, ...
quick      claude-opus-5-5 at low (fast, not allowed)
```

From an MCP client, `profiles_list`, `profile_create`, `profile_update`, `profile_delete` and `project_set` do the
same; `lead: true` on `profile_update` picks the one leads start on. The default can't be deleted, only replaced; nor
can a profile a task not yet ended runs on. A renamed profile keeps its tasks: the ones not yet ended move to the new
name, ended ones show the name they ran on.

### The lead's profile {#lead-profile}

Leads start on the profile picked under **Lead runs on**, the default until someone picks another. It is one setting
for the whole hub, not one per project, and applies at each lead's next start: a lead already running keeps the model
and effort it started on (`lead_start {fresh: true}` starts it again now). Each lead's
lane, and its time by profile, name the profile its session started on.

To move every lead to it at once, an admin clicks **Restart hub…** on the hub's row in
[Settings › Hubs & devices](/docs/several-hubs#restart). Once the hub is back, each lead whose profile changed since it started
(another profile picked, or its model, effort or fast mode edited) starts again on the current one, as
`lead_start {fresh: true}` does: it keeps its chat, memory and open orders. A lead in the middle of a turn switches
when the turn ends, and one whose machine is offline when it comes back. Leads already on the current profile carry on
as they were. Only that button does this: the hub's restart for an update switches no lead.

```text
$ fleetd project profile lead --model claude-opus-5-5 --effort xhigh --lead --key-file ~/.fleetd/human.key
✓ Projects allow lead once they pick it on their Agents page (project_set); new agents on it run claude-opus-5-5 at xhigh. Leads start on lead (claude-opus-5-5 at xhigh) from each lead's next start.
```

`fleetd project profiles` marks it `lead`. Picking the default
(`fleetd project profile high --lead --key-file ~/.fleetd/human.key`) puts leads back on whichever profile is the
default. Deleting the lead's profile does the same, and says so: `medium is gone, and no project allows it any more.
Leads ran on it, so they start on the default, high, again from their next start.`

A change applies to agents started after it. Agents already running keep the model and effort they started on, and
each agent's usage, time and lane report the model it really ran on. A node older than the hub runs effort `xhigh` as high, and
no profile in fast mode: update fleetd there.

If claude refuses a model (one your account or gateway has no access to), no agent is stranded: the agent goes on at
once on `claude-opus-5-5`, in the same run, and its thread says why. The hub then flags the profile:
`fleetd project profiles` shows which machine refused it and when, and new agents on it run on `claude-opus-5-5` until
you set its model again.

The policy file has no say in any of this: an older `.fleetd/policy.yaml`'s `defaults.model` and `defaults.effort`
are ignored.

## How the lead schedules work {#scheduling}

The lead plans each piece of work as small items, sized S, M or L, some waiting `after` others. It starts every item it can
in parallel. Spawns past the cap queue and start by themselves as slots free, and the lead is woken whenever an agent
finishes or a PR merges. fleetd never starts work of its own.

Slices are reviewed as they land: once a writer's PR is ready (not a draft), on its branch or one named after it,
fleetd puts it on the train and starts its reviewers, while the writer goes on. On a repo whose PRs have never been on
the train, that starts with the writer's result. A new commit is reviewed again from what changed.

No gate relaxes. Every PR still gets its review and green CI and goes through the train, and anything that needs
your approval still waits for it. The reviewers fleetd starts count against the slots and the lead's limit of 32 open
tasks like any task.
