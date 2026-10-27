# Navi: a personal and company assistant inside fleetd

Status: design, partly built. Written in W94 (T733, read-only research, fleetd at `792a73551`); updated in W97 with the
person's answers (§6) and the core as built (§7). This records intent when written; the code is the source of truth.

**The person's answers (W97), which override the text below where they differ:**

- Navi **sends email itself after the person approves it in the app**, with no "always allow" at first.
- **No chat-app bridges in v1** (Telegram, Slack, iMessage): a mobile app comes later.
- **Unlimited Navis per person**, each a named assistant, as Grok bots and OpenAI dots are. Not one per person.
- **v1 includes Google (Gmail, Calendar, Drive), Notion and custom MCP integrations.**

## The recommendation in brief

Build **Navi** as **one special project with no repo**, whose lead runs an assistant prompt. A project already
comes with a lead, a chat, memory and its nightly refresh, automations, screens, 1Password fills, secrets, approvals
and a checklist. Making Navi a project means it gets all of that unchanged. Four things are genuinely new:

1. A project that is just a directory (multi-repo stage 2, already planned).
2. An assistant role whose tool rules differ from a lead's.
3. A small **factory bridge**, so Navi can open orders in other projects, read their status, and be told when work
   lands.
4. ~~A chat-app channel for the phone. Telegram comes first.~~ Not in v1 (W97): a mobile app comes later.

Email and calendar arrive as MCP servers, which fleetd already manages. They are gated by permission prompts, relayed
as approvals. (The research said that relay existed. It didn't: #356 had removed it as unreachable, since every
session ran with full access. W97 brought it back; see §7.)

---

## 1. The references: what each does and what to take

| | What it is (Oct 2026) | Take | Leave |
|---|---|---|---|
| **Grok Bot** (xAI/SpaceXAI, beta Aug 2026) | Named bots that act as "teammates" on one cloud Linux VM per user. A **Primary Bot** takes everyday requests and routes them to specialist bots. Routines run on a schedule or a trigger (Slack message, Git event). "Teach a task" records you doing something and turns it into a skill. Plugins for Gmail, Calendar, Notion, Linear and Stripe come first; the browser is the fallback. Approval is needed for send, publish, purchase, delete, permission or prod changes and legal terms, with allow once / deny / always allow, and require-approval rules beat always-allow. Secrets go in masked fields. Mobile apps can watch the computer and take it over. | The **primary-bot-routes-to-owners** model, which is Navi routing to project leads. The **approval list**, with require-approval rules beating always-allow. **Connectors before the browser.** Take over from the phone. | All bots share one VM, cookies and credentials, so "separate bots are not separate security zones". fleetd's fresh session per screen is better. |
| **OpenAI dots** (Sep 2026, ChatGPT Pro) | Built out of their coding agent (Codex), repackaged as "an entity and a single conversation". It works in the background and messages you first: a morning review of email, calendar and tasks, meeting briefs, and "proactive research" from what it knows of you. It uses every app connected to ChatGPT. It won't pay or share personal information without asking, but may book a meeting on its own. Early reviews say it asks too often and is sometimes late with alerts. | **A coding factory turned assistant** is exactly fleetd's path. Take **one conversation that feels like one entity**, the **morning review**, and **low-risk actions on its own, money and personal information always asked**. | Coarse permissions (no read-only drive access). Proactive research that builds a profile of your contacts. |
| **Claude Duet** (Anthropic, Oct 21 2026; iOS, Android, claude.ai) | Proactive, and messages you first. One main thread plus **topic channels** that share one memory. A **Tasks tab** with statuses: Duet can say a task looks done, but only you close it. Morning brief, follow-ups on stalled threads, calendar conflict catches. It scans accounts every few hours, not continuously, because scans cost usage. It asks before sending, paying, signing or deleting, and each approval shows destination, content and every recipient. A check outside the agent confirms each action matches your request. Some actions always need approval, and moving money or trading is blocked even if you approve. Passwords never reach the model, and an outgoing classifier blocks credentials and IDs. It has its own cloud computer, but you **can't watch or take over** its browser. The reviewer's complaint: "it can see the Claude sessions on his computers but can't direct them." | **Approval cards that show every recipient and the exact content.** **A gate outside the model.** A **blocked-even-if-approved** list. **Scan every few hours, not continuously.** **Only the person closes a to-do**, which fleetd's checklist already does. Channels later. | Its biggest gap, directing coding sessions, is fleetd's core. That is the reason to build Navi. |
| **Hermes Agent** (Nous Research, open source, Feb 2026) | A self-hosted personal agent: "one agent, one memory, every surface". **MEMORY.md + USER.md**, bounded and curated, which the agent manages itself. Full-text search over past chats. Skills it writes and improves from experience. Cron jobs. A single **gateway** process for Telegram, Discord, Slack, WhatsApp, Signal, SMS, email, Teams, Matrix and iMessage (through BlueBubbles). Start on the CLI, get notified on Telegram, carry on in Discord. | **Its memory design is the same as fleetd's** (`user.md` + `MEMORY.md` with caps), which confirms the foundation. Take the **gateway**: one process, many chat apps, the same agent and memory behind it. Take **skills learned from use**, since fleetd already has `skill_install`. | Unattended self-editing of skills, unless a person reviews them. |

**What fleetd should claim.** Every reference has proactive check-ins, email and calendar, and approvals. None of
them can **hand work to a team of coding agents and follow it to a merged PR**. Navi's distinctive job is to be the
front door to the factory as well as a personal assistant.

---

## 2. The foundations in fleetd today

Paths are under `crates/fleetd/src/` unless shown otherwise.

### Leads and chat: reusable as is
- One lead per project: a Claude thread on the project's machine, started with the lead prompt plus the digest
  (`hub/leads/lead.rs:1`, `start` at `:68`). It comes back fresh after an hour of quiet (`LEAD_FRESH_AFTER`,
  `hub/leads/lead.rs:426`).
- The lead's first message is `lead.start`, then voice, digest, custom instructions, then memory: `user.md` and the
  project's `MEMORY.md` (`hub/leads/prompt.rs:1-2`, joined at `:43`). Prompts are stored and editable
  (`hub/prompts/`), so an assistant prompt `navi.start` is just another prompt.
- One chat per project is the main surface (`hub/chat/mod.rs:1-4`). A message joins the lead's turn, or starts a new
  one when the lead is idle (`hub/chat/flow.rs:1-3`).
- `chat_send` from a human key writes as the human. From any other key it writes "as an agent, by its name: input for
  the lead, never the human's answer or approval" (`hub/mcp/descriptions.rs:4`). **This is the safe hand-off from
  Navi to the factory, and it already exists.** Key kinds: `crates/fleetd-contracts/src/auth.rs:46`.
- `fleetd chat` reaches a lead from a terminal over the same socket (`cli/chat.rs:1-5`).
- Wakes are scheduled on the hub clock and wait for an offline machine (`hub/wakes/mod.rs:1-3`). Triggers to a lead
  are coalesced into one message behind the code-rendered digest (`hub/leads/wakes.rs:1-2`, `hub/leads/digest.rs:1-3`).
- **The catch:** a lead may not `Edit`, `Write`, `WebFetch` or `WebSearch`. Those are "its agents'" job
  (`node/runner/claude/mod.rs:98-117`; roles at `crates/fleetd-contracts/src/sessions.rs:113`). An assistant needs to
  read the web and write notes in its own directory, so **it needs its own role. That is new, and small.**

### Memory and the nightly refresh: reusable as is
- Plain markdown under `<hub home>/memory`, in no repo. `user.md` is shared by every project. Each project has its
  own `MEMORY.md` plus topic files, never read for another project. The hub is the only writer, and a write past a cap
  is refused, never truncated (`hub/memory/mod.rs:1-5`).
- Caps: user 16k, index 16k, topic 32k, project total 128k characters, settable up to 100k / 400k
  (`crates/fleetd-contracts/src/memory.rs:19-26`). Every write passes a secret check before the cap check
  (`hub/memory/mod.rs:313`).
- **Open PR #621 (W87):** a new `forget` tool and a nightly refresh (`hub/memory/refresh.rs`). It runs around 04:00 in
  `policy.tz` with a 3-hour window. It skips quiet projects. It is a fresh lead-role session allowed only
  `memory_read`, `remember` and `forget`. It may only add to `user.md`, and posts one line, "Memory refreshed: +a ~b
  −c", with Undo per item. It has a per-project off switch. **Navi gets this unchanged**, and its nightly review is a
  second job on the same schedule (§3.4).
- **Privacy:** `user.md` goes into *every* lead's prompt. Navi's personal facts (family, health, money) must go in
  **Navi's own project memory**, not `user.md`, or every coding lead reads them.

### Automations: reusable as is
- A project's stored prompt with triggers: a 5-field cron in an IANA zone, an incoming webhook, or Run now
  (`hub/automations/mod.rs:1-8`, `crates/fleetd-contracts/src/automations.rs:1,33-44`). The webhook route is
  `/hooks/{automation_id}/{secret}` (`hub/http/mod.rs:41`). A run missed while the hub was down runs once, late.
  This covers Navi's **morning brief**, its **every-few-hours look around**, and **"email me when X happens" via a
  webhook**.
- What doesn't fit: a run opens an *order* (channel `automation`). For Navi, a run should usually be a chat turn, not
  an order. Small change.

### Screens: reusable as is
- Browser sessions are a fresh Chrome with an empty profile, thrown away at `session_end`. They are recorded (video,
  DOM after each step, an action log) and scrubbed (`node/browser/session.rs:1-4`, `node/browser/record.rs:1-4`), with
  retention and prune (`hub/browser/mod.rs:1-6`) and a live view (`hub/browser/live.rs:1-4`).
- Android (`node/device/mod.rs:1-7`), iOS on a Mac (`node/device/ios/mod.rs:1-6`) and Linux desktop with computer-use
  actions (`node/desktop/mod.rs:1-6`). Placement is by machine role (`hub/machine_roles/mod.rs:1-6`).
- **Takeover:** `request_takeover` asks a person to drive, and it waits until a person has control
  (`hub/browser/tests.rs:492`). This lets Navi draft and leave the final "Send" or "Pay" click to you.
- **1Password fills:** the node resolves `op://` with the project's `OP_SERVICE_ACCOUNT_TOKEN`, which a person enters
  through `request_secret` and which is kept out of every agent's environment (`node/browser/onepassword.rs:1-5`).
  After a fill, the session refuses to read values back (`node/browser/credentials.rs:1-7`, `refusal` at `:339`).
- Leads already have the screen tools (`cli/agent_mcp.rs:77-83`, `session_start` at `:363`, `fill_credential` at
  `:399`).
- **Gap:** the profile is thrown away every time, so Navi has to log in on every visit. A persistent profile per site
  is new (later step).

### Secrets and approvals: reusable as is
- Requests `Q<n>` (`hub/approvals/mod.rs:1-11`):
  - **`request_secret`**: the desktop app seals the value to the target machine's key, and the hub relays only
    ciphertext and keeps a fingerprint (`app/desktop/src/main/secret.ts:1-3`, `node/secrets.rs:1-4`).
  - **`gated_run`**: the exact command is stored and runs only after a person approves it.
  - Preview-setting approvals.
- Gate classes are `Irreversible`, `Money` and `Credential` (`crates/fleetd-contracts/src/ledger.rs:220`). Money and
  irreversible requests are **urgent and break through quiet hours**; the rest are loud. Notifications are coalesced
  into 20-minute windows, with quiet hours 23:00–08:00 by default (`hub/attention/mod.rs:10-27`).
- **Session permission prompts are already relayed as approvals.** A session can run in `manual` permission mode with
  an `--allowedTools` list (`node/runner/claude/mod.rs:355-372`). Any tool off that list asks first, and the ask
  becomes a chat approval showing the tool and what it would do (`crates/fleetd-contracts/src/chat.rs:163-176`,
  `ToolPermission` at `ledger.rs:332`). **This is the gate outside the model for "send email": it already exists.**

### MCP servers and skills: reusable as is
- Per-project or global MCP servers. A secret in a server's env or headers is sealed in the app to each machine; the
  hub keeps fingerprints only (`hub/mcp_servers/mod.rs:1-7`). **Gmail, Google Calendar, Slack and Notion arrive here**
  as off-the-shelf MCP servers, with no new integration code.
- Skills per project or global (`hub/skills/mod.rs:1-6`), and a lead can `skill_install`.

### Projects as workspaces with zero or more repos: partly built
- "A project is a workspace: a lead and its own directory … It holds zero or more repos. A plain directory with no
  git has none" (`docs/design/multi-repo.md`, "The model"). Stages 1a and 1b have landed (`crates/fleetd-contracts/
  src/repos.rs:27`, `ProjectSummary.repos` at `model.rs:119`).
- **Today `project_add` still refuses a non-git directory** (`hub/projects/mod.rs:284-290`). "A project that is just
  a directory" is **stage 2** of the multi-repo plan. Navi's first version depends on that slice.
- Workers in a no-repo project need somewhere to run besides a git worktree. That belongs to stage 3, and the first
  version doesn't need it.

### Factory reads: reusable through the hub's MCP
- `status_get` and the status rows (`hub/status/mod.rs:1-3`), `orders_board` / `order_get` (`hub/orders/mod.rs:1-2`),
  the checklist (`hub/checklist/mod.rs:1-3`), PRs (`hub/prs/mod.rs:1-3`), the merge train (`hub/train/mod.rs:1-3`),
  landings on the base (`hub/work/landings.rs:1-3`), and `events_wait`.
- All of these exist for **app and human keys** on `/mcp` (`hub/http/mod.rs:36`). **None of them is a lead tool:** a
  lead sees only its own project (`hub/tasks/policy.rs:49-134`). The bridge is new.

### Desktop app and remote access: the phone is the genuine gap
- The Electron app (`app/desktop/`) has desktop notifications (`app/desktop/src/main/notify.ts:22`) and pairs over the
  LAN or Tailscale (`cli/pair.rs:220-235`, `app/desktop/src/main/pairing/appPairFile.ts:58`). Previews have a tailnet
  proxy for the owner's devices only (`node/preview/proxy.rs:1-4`).
- **There is no phone client today.** An earlier phone app was removed (`crates/fleetd-contracts/src/ledger.rs:110`,
  commit `c483057e6`), and there is no Telegram, Slack or iMessage channel.

### What's reusable as is, and what's new

| Reusable as is | Genuinely new |
|---|---|
| Lead thread, chat, digest, wakes | Assistant role: the lead's tools plus WebSearch/WebFetch and Write in its own directory, run in `manual` mode with a read-only allow list (**s**) |
| Memory, caps, remember/forget, nightly refresh (#621) | A project that is just a directory (multi-repo stage 2, **s**), and Navi pinned at the top of the app (**s**) |
| Automations (cron, webhook, Run now) | Automation runs that are chat turns rather than orders (**s**) |
| Browser, Android, iOS and desktop screens, recordings, takeover, 1Password | Factory bridge: `project_message`, `factory_status`, and a wake when the order Navi opened changes (**m**) |
| `request_secret`, `gated_run`, permission prompts relayed as approvals, quiet hours | A blocked-even-if-approved list, and approval cards that show recipients (**s**) |
| MCP servers with sealed secrets (the route to Gmail and Calendar), skills | Telegram gateway on the node (**m**), and later Slack or iMessage |
| Checklist as the person's to-do list | A persistent logged-in browser profile per site (**m**) |

---

## 3. The design

### 3.1 Where Navi lives: a no-repo project per Navi, as many as the person likes

**Pick: a project with no repo, marked as an assistant (`kind: assistant`). A person makes any number of named Navis
(W97); each is its own project, with its own chat, memory, folder and lead.**

- **Why a project and not a new entity:** every per-project system is keyed by `ProjectRef` (multi-repo.md, "The
  model"): lead, chat, memory, env and secrets, MCP servers, skills, automations, checklist and screens. A new
  top-level entity would mean re-plumbing all of them. A project gets them free, and the multi-repo work already makes
  a no-repo project valid.
- **Who made it:** each Navi records the key that created it (`createdBy`: key id and name). Nothing filters on it
  yet. When a company shares a hub, a team and auth design (separate work) can give each person their own Navis from
  it, with their own human key, memory and secrets. That is a step, not a redesign.
- **What makes it special** is small: an assistant prompt (`navi.start` instead of `lead.start`), the assistant role
  (§3.5), the factory bridge tools (§3.8) allowed only in this project, and a pinned place in the app's sidebar.

### 3.2 How you reach it
1. **The app, from the first version.** Navi's chat is pinned above the projects. Desktop notifications and quiet
   hours work as they do today.
2. **The terminal:** `fleetd chat <machine>/<navi> "…"` works as it is, and `fleetd navi` makes and lists them.
3. ~~**Phone, through Telegram first (step 3).**~~ Not in v1 (W97); kept for the record. A **gateway on Navi's node** long-polls the Telegram Bot API, so the
   hub needs no public URL. The bot token is a sealed node secret, as a 1Password token is. Messages come only from
   one allow-listed Telegram user ID, and go into Navi's chat as the person's messages.
   - Navi's replies and urgent notices go back to Telegram, and quiet hours apply.
   - **Approvals, secrets and takeovers are never answered over Telegram.** Telegram shows "needs you: open the app",
     because a Telegram account is a weaker identity than a paired device's human key, and secrets must be sealed in
     the app (`secret.ts:1-3`).
   - Low-risk confirmations ("yes, draft it") are fine as ordinary chat.
   - Slack and iMessage use the same gateway later. iMessage needs a Mac and a BlueBubbles-style bridge, so it is the
     largest.
4. **A real phone app** (a PWA over the tailnet, or native) is the last step.

### 3.3 Memory
- **Navi's `MEMORY.md` and topics** hold the person's life and work: people, preferences, routines, accounts by name
  (never values). The project cap is 128k by default and can go up to 400k.
- **`user.md`** stays the short, shared "who the person is and how they like to work" file that every lead reads.
  Navi's prompt says plainly: private facts go in Navi's own memory, never `user.md`.
- Every write passes the secret check (`hub/memory/mod.rs:313`). Remember and forget lines show in the chat with Undo,
  as they do for any lead.

### 3.4 The nightly review
- **The memory refresh** (#621) runs for Navi as for any project: tidy, merge, forget, one undoable summary line.
- **A morning brief** is a built-in automation that ships switched off and is offered in onboarding: cron `0 7 * * 1-5`
  in `policy.tz`. It reads today's calendar, the inbox since yesterday, the factory (what merged overnight, what is
  red, what waits on you in each project), and Navi's checklist. It posts one message and puts new to-dos on the
  checklist.
- **A look around every few hours** is optional. Duet does this, and it is cheaper than watching continuously. It
  stays silent unless something needs the person.

### 3.5 Its tools
- **Screens:** browser, Android, iOS and Linux desktop sessions with recordings, takeover and 1Password fills, all as
  they are. The browser is the **fallback**; connectors come first, as Grok Bot does it.
- **Integrations (v1, W97):** Google (Gmail, Calendar, Drive), Notion and any custom **MCP server**, added to a Navi
  in Settings › MCP servers. Their OAuth tokens are sealed to the machine. Read tools run unasked; write and send
  tools ask, the approval showing recipients and content (a separate writer's part).
- **Web:** WebSearch and WebFetch, allowed in the assistant role.
- **Files:** Navi's project directory on its machine is its filing cabinet: notes, drafts, downloads, exports. Files
  attached in the chat arrive through intake (`hub/intake/mod.rs:1`). Write is allowed only inside that directory.
- **To-dos:** the checklist, as it is. Only the person ticks an item done, which is the same rule Duet has.
- **Skills:** as they are. A skill Navi writes is installed with `skill_install` and shown in the chat. "Teach by
  recording" (Grok Bot) is a later idea, not planned.

### 3.6 What it may do unasked, and what needs approval
Enforcement sits **outside the model**. Navi runs in `manual` permission mode with an allow list of read tools only.
Every other tool raises a permission prompt, which fleetd already relays as an approval (`chat.rs:163-176`). Commands
go through `gated_run`, and browser "final clicks" go through `request_takeover`.

| Unasked (allowed) | Needs approval, every time (no "always allow" in the first versions) | Blocked even if approved |
|---|---|---|
| Read email, calendar, web, files, factory status | **Sending** any email or message to someone else (the card shows recipients and full text) | Moving money between accounts, trading |
| Draft replies and events (saved as drafts) | **Spending** money (`Money`, urgent) | Creating accounts in the person's name |
| Remember and forget in its own memory; update its checklist | **Posting publicly** (social, forums, public repos) | Sharing credentials or ID numbers |
| Open screens; log in with 1Password | **Deleting** anything: mail, events, files (`Irreversible`, urgent) | |
| Message a project lead (agent input only, §3.8) | Accepting or declining invites, or changing others' calendars (this counts as sending) | |
| Create or pause its own automations (shown in the chat) | Signing or accepting terms; changing passwords or 2FA (`Credential`) | |
| | Opening an order in a project **unless the person asked for it in this conversation** | |

The blocked list is enforced as a hub policy on Navi's tools and gated classes, not as a prompt instruction. Later,
"always allow" can come to low-risk sends (for example, to yourself).

### 3.7 Where its credentials live
- **On Navi's machine's node, sealed. The hub keeps fingerprints only:**
  - project secret variables through `request_secret` (`node/secrets.rs:1-4`);
  - MCP server tokens (`hub/mcp_servers/mod.rs:6-7`);
  - the Telegram bot token.
- **1Password:** Navi's project has its own `OP_SERVICE_ACCOUNT_TOKEN`, a service account that sees **one "Navi"
  vault** the person fills. It never sees their whole account, and no coding project shares it.
- Never in memory (the secret check refuses it), and never in the chat. Recordings are scrubbed
  (`node/browser/record.rs:1-4`).

### 3.8 How Navi talks to the factory
New lead calls, allowed only in the assistant project (`hub/tasks/policy.rs` gains one rule):

- **`project_message {project, text, kind: order|question}`** writes into that project's chat as the agent **"Navi"**,
  which is the same thing `chat_send` from a non-human key does today. The lead reads it as input, **never as the
  person's approval** (`hub/mcp/descriptions.rs:4`). So Navi can't approve a gated command, a secret or a merge in any
  project. Those still need the person, in that project's chat, and Navi links them.
- **`factory_status {project?}`** returns, in one read, each project's status row, open orders, checklist items
  waiting on the person, PRs and train state, and what landed since a time. It is built from `status_get`,
  `orders_board`, the checklist, `pr_list` and landings (`hub/work/landings.rs:1-3`). It is read-only.
- **Being told:** Navi gets a wake when anything it opened through `project_message` changes, and when a question it
  asked gets a reply:
  - the order's workstream opens or closes;
  - a PR opens or merges;
  - the lead asks the person something;
  - the lead replies to Navi's question.

  It is the same wake machinery (`hub/leads/wakes.rs:1-2`), keyed by the order Navi opened. Navi then tells the person
  in its own chat or on Telegram: "the cart-saving order you asked for merged: PR #640".
- **The morning brief** uses `factory_status` for "what merged overnight, what's red, what waits on you".

This makes Navi Grok Bot's "primary bot" with the project leads as the specialists. That is the thing Duet's reviewer
wanted and couldn't get.

---

## 4. The phased plan

**First version: Navi in the app, wired to the factory (m in total).**
1. Allow a project that is just a directory (multi-repo stage 2, the directory slice only). **s**
2. An assistant project kind: the `navi.start` prompt, the assistant role (lead tools plus web and Write in its own
   directory, `manual` mode with a read allow list), and a pinned place in the app with a first-run "Create Navi".
   **s**
3. The factory bridge: `project_message`, `factory_status`, and the wake on change for what Navi opened. **m**
4. A morning brief automation that runs as a chat turn rather than an order, switched off by default, with factory and
   checklist only until step 5 adds email. **s**

Already there for this version, unchanged: memory and the nightly refresh (#621 once merged), screens with 1Password,
approvals, the checklist, automations, and notifications with quiet hours.

**Later steps**
5. **Email and calendar:** documented MCP servers for Gmail and Google Calendar (and Microsoft 365), approval cards
   that show recipients and content for send tools, the blocked-even-if-approved list, and email and calendar in the
   morning brief. **m**
6. **Telegram gateway** on the node: allow-listed user, chat both ways, urgent notices, "open the app" for approvals.
   **m**
7. **Persistent browser profiles** per site for Navi, so it stays logged in, kept on its node and scrubbed in
   recordings. **m**
8. **A look around every few hours**, with a person-set frequency, silent unless needed. **s**
9. **Channels** (Duet): topic threads in Navi's chat (money, hiring, home) sharing one memory. **m**
10. **Slack**, then **iMessage**, through the same gateway. Slack **m**; iMessage **l** (Mac bridge).
11. **Company Navi:** one Navi per person on a shared hub, with per-person human keys, private memory and secrets, and
    an optional shared team memory. **l**
12. **Phone app:** a PWA over the tailnet, or native, with approvals and takeover from the phone. **l**

---

## 5. Name

**Navi** is decided by the person. It reads as "navigator" and as a helper, and in Italian *navi* means "ships".

**Clash risk:** Navi, the fairy guide in Nintendo's Zelda games, is the famous one. There are also several AI products
called Navi: Coupa Navi (procurement), Atlas's Navi (maps), a Navi travel guide app, and Navi AI for pilot training.
India's Navi Group is a fintech. None of these is a general personal assistant, but search results and app stores
will be crowded, so check trademarks before a public launch.

(For the record, other candidates checked before the decision: Marina clashes with marina.computer, a proactive Mac
assistant in the same category. Bosun and Steward each clash with open-source approval-first personal agents. Skipper
names several AI assistants. Shipmate is a large cruise app. Mate is a translator. Cay had no notable clash.)

---

## 6. Product questions for the person, answered (W97)

1. **Should Navi send email itself after you approve each one, or only draft for you to send?** *Answered: send after
   approval in the app*, with the card showing recipients and full text, and no "always allow" at first.
2. **Which chat app comes first for the phone?** *Answered: none in v1.* A mobile app comes later.
3. **One Navi per person now, or a shared company Navi?** *Answered: unlimited Navis*, each a named assistant, like
   Grok bots or OpenAI dots. Each records who created it, for per-person Navis on a shared hub later.
4. **Integrations in v1:** *Answered: Google (Gmail, Calendar, Drive), Notion and custom MCP servers.*

---

## 7. The core as built (W97)

The first part of v1: plain-folder projects, the Navi kind, the assistant role and the permission relay. The factory
bridge (`hub/navi/bridge`) and the integrations (`hub/integrations`) are separate parts; the app's UI comes after.

### Plain-folder projects (multi-repo stage 2, the directory slice)
- `project_add {path}` takes a directory with no git (`hub/projects/mod.rs`, `checkout`). Its inspect says so
  (`inspect::folder`, `leadNeeds`: "a plain folder with no git: …"). No own repo is recorded, and no work scope is
  bound. `fleetd project add <path>` prints only that line for it.
- A relative `project_upsert` root (`navi/ada`) is a folder under the node's home, made when missing. Each part must
  be a safe name, so it never leaves the home. The node answers `{kind: "folder", path}` with the absolute path. Only
  nodes listing `CAP_ASSISTANT` get one.
- Agents that change code still need a repo: spawning a writer in a plain folder fails at its worktree (stage 3).

### The Navi kind
- Hub table `assistants` (machine, project, `created_ms`, `created_by_key`, `created_by_name`, `archived_ms`),
  owned by `hub/navi/store.rs`. It is stored by the hub, never by the node: `projects_upsert_many` drops `kind`,
  `createdBy` and `archivedAt` from a node's row, and `with_repos` (`hub/store/hub_store.rs`) fills them when the hub
  serves a summary, as it does `repos`. Any reader goes through `project_get`/`projects_list`, never
  `projects.data`.
- `ProjectSummary` gains three optional fields. A project of code has none of them.
  - `kind: "assistant"` (`ProjectKind`, open for later kinds).
  - `createdBy: {keyId, name}`: the key that made it.
  - `archivedAt`.
- MCP tools (`hub/navi/tools.rs`), each returning the Navi as a `ProjectSummary`:

  | Tool | Input | Does |
  |---|---|---|
  | `navi_create` | `{name, machineId?}` | Makes a new folder `navi/<slug>` (`-2`, `-3` when a project or a folder left behind has it; the node refuses an existing one with `FOLDER_TAKEN`) on the best worker, records the creator, emits `project.added` with the folder inspect. Refuses a node without `CAP_ASSISTANT`, with "Run fleetd update". |
  | `navi_list` | `{machineId?, archived?}` | Oldest first; archived ones only with `archived: true`. Its empty `next` is "No Navis yet: navi_create makes one." |
  | `navi_rename` | `{machineId, projectId, name}` | Renames it on the node in place: the folder keeps its name. |
  | `navi_archive` | `{machineId, projectId, archived?}` | Default true: stops its lead and holds it. `false` brings it back. Both emit `project.settings` with `kind`, `title` and `archivedAt`. |

- CLI: `fleetd navi create|list|rename|archive|unarchive`.
- An archived Navi's lead takes no turns. `Leads::launch` refuses it (no first start, restart or fresh start of a
  cold lead), `auto_start` and `start_with` refuse it before returning a running lead, and `LeadWakes` drops its wakes.
  A chat message is held with the reason until it is back.

### The assistant role
- A Navi's lead starts from the `navi.start` prompt (stored and editable like the others, `hub/prompts`), with its
  name, ref and folder. Then come `lead.voice`, automations, the digest and memory, but no task profiles. It runs as
  `SessionRole::Assistant` in `manual` permission mode (`hub/leads/lead.rs`). An older node can't decode the role, so
  the hub refuses the launch without `CAP_ASSISTANT` (`hub/leads/wiring.rs`).
- On the node (`node/runner/claude/mod.rs`):
  - Its agent-browser reads only an empty config fleetd writes in the session's directory (`AGENT_BROWSER_CONFIG`),
    never `./agent-browser.json` or `~/.agent-browser/config.json`. A `screenshot` saves unasked only inside the
    folder or its scratch directory, to an absolute path (agent-browser's daemon resolves a relative one), checked as a
    Write is.
  - The role keeps a lead's fleetd tools (`agent-mcp --role lead`), and `Edit`, `Write`, `WebFetch` and `WebSearch`.
  - `role_allowed` adds `ASSISTANT_ALLOWED` to `--allowedTools`: `WebSearch`, `Skill`, `mcp__fleetd`, `agent-device`,
    and agent-browser's commands that work the open page (`click`, `fill`, `snapshot`, …). Not `open`, `eval` or `tab`,
    nor `get cdp-url`, whose DevTools URL is raw control of the browser: it asks.
  - A session held to its allowed tools (`allowed_only`) refuses every ask before the Navi's own rules
    (`state::node_answer`).
  - `role_ask` puts `ASSISTANT_ASK` (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`) in the
    settings overlay's `permissions.ask`. An ask rule outranks every allow rule, a person's own settings' included,
    so each of these reaches the node's prompt.
  - `role_answer` answers a file tool there: inside the folder or the session's scratch directory (symlinks
    resolved, no `..`) it is allowed, except an
    edit to `.claude/`, `.mcp.json`, `.fleetd/` or `agent-browser.json`, checked on the resolved path and whatever its case (a disk that
    ignores case writes `.Claude` into `.claude`). A Glob pattern or Grep file filter that is absolute or climbs with
    `..` is refused too. The hub also drops a policy file's allow rules from an assistant's
    launch (`hub/executor/mod.rs`), so nothing the Navi writes can widen its own rules. Outside it is refused, whoever would approve it. So the session's `mcp.json`
    (with its resolved tokens), the node's env files, `~/.ssh` and gh's login are out of the Navi's reach. A `Bash`
    command that reads them asks the person, showing the command.
- The site gate (`hub/navi/sites.rs`, table `navi_sites`): a `WebFetch`, or an `agent-browser open|goto|navigate
  <url>`, is a visit to its host, without `www.`.
  - A site the person allowed goes through unasked. Any other site asks, the approval naming it in
    `permission.site`, and approving it allows the site.
  - A command that does more than open one plain URL asks every time, with no site: a second word, a quote inside
    it, a backslash, whitespace, a user in the authority, or a scheme other than http(s). The host compared is the
    URL library's, after IDN to punycode. Only http(s) names a site (`file:`, `data:`,
    `javascript:`, `about:` ask each time), and a loopback host is a site per port (`localhost:3000`).
  - `navi_sites {machineId, projectId}` lists the sites; `navi_site_revoke {…, site}` takes one back, and it asks
    again.
  - Not covered: a click that follows a link to another site, and a final Send or Pay click on an allowed site. The
    prompt hands those to the person with `request_takeover`; the docs say so.

### The OS sandbox (D196, `node/runner/sandbox.rs`)
Reviews kept finding new ways around the path checks above, so a Navi's session also runs in an OS sandbox. The
checks stay, as a second layer. Only `SessionRole::Assistant` gets one: the node's `spec` builds its `Fence` and puts
it on `SessionSpec.sandbox`, and `ClaudeRunner::spawn` wraps the command in it (inside the systemd scope, when there
is one). Every other session's spec has none.

- **The fence** (`navi_fence`), all paths with symlinks resolved:
  - *write*: the folder; the session's scratch dir (`TMPDIR`); `<session dir>/agent-device`; in claude's config dir,
    the folder's `projects/<slug>` (its conversation, which a resume needs), `session-env/<id>`, `file-history/<id>`,
    and `.credentials.json` when it exists: a refresh rotates the token, and one claude couldn't save would log out
    every session on the machine.
  - *private* (Linux): `<session dir>/claude/<name>` mounted over claude's shared `shell-snapshots`, `todos`, `tasks`,
    `plans`, `paste-cache`, `statsig`, `debug` and `telemetry`. Every session reads these back (a snapshot is sourced
    by every command), so a Navi gets its own. On macOS they are read-only: `sandbox-exec` can't mount a private copy,
    so a Mac Navi's todos, plans and shell snapshot may not save.
  - *hide*: fleetd's dir and the node's home (worktrees, the hub, the node's secrets and tokens);
    `HIDDEN_IN_HOME` (`~/.config`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.netrc`, `~/.git-credentials`, `~/.docker`,
    `~/.kube`, `~/.password-store`, `~/.local/share/keyrings`, `~/.npmrc`, `~/.pypirc`, cargo's credentials,
    `~/.android/adbkey`, `~/.mozilla`, `~/.pgpass`, `~/.vault-token`, `~/.azure`, `~/.terraform.d`, `~/snap`, shell
    (fish's too) and REPL histories, `~/.Xauthority`, `~/.agent-browser`); `~/Library` on
    macOS; `$XDG_RUNTIME_DIR`; `/tmp/.X11-unix`; the docker socket; claude's record of other sessions
    (`CLAUDE_HIDDEN`: `projects`, `history.jsonl`, `file-history`, `session-env`, `sessions`, `ide`, `backups`, with
    its own bound back); and every other project's root the node knows, unless it holds the folder or the whole home.
  - *show* again, read-only, shallower than what it hides inside: the session dir (its MCP config, settings overlay, skills, browser config), the
    `fleetd` binary its MCP server runs, the node's socket, claude's config dir, and the node's tools
    (`browser/agent-browser`, `device`). Chrome's profiles stay hidden.
  - *keep* read-only inside the folder: `ASSISTANT_KEPT` (`.claude` and `.fleetd` are made empty first, so they can't be
    made later).
  - *config_copy*: claude's global config (`~/.claude.json`, or `.claude.json` in `$CLAUDE_CONFIG_DIR`) is bound
    over with `<session dir>/claude/.claude.json`, written fresh by `prepare` at each start through `sanitized_config`:
    no `mcpServers`, no `projects`, no key named like a secret (`token`, `secret`, `password`, `credential`, `apikey`)
    but `primaryApiKey`, claude's own login. On macOS the real file is hidden instead. Its copies beside it
    (`.claude.json.backup.*`, any `.claude.json.<suffix>`) are hidden on both.
  - *home* (Linux): the user's home itself is hidden (an empty tmpfs, read-only), so the home is an allow-list:
    what comes back is the fence's other paths in it, `home_programs` (claude's binary; each `PATH` dir in the home,
    a `bin` as its parent install but `~/.local/bin` alone; for each program there that links elsewhere in the home,
    the install it lands in by the same rule; never an install that is, holds or sits in fleetd's dir, the node's
    home or another project's root, so `~/.fleetd/bin` comes back alone and a link into a project brings nothing),
    `HOME_READ` (`~/.gitconfig`, git's `~/.config/git/config`, `ignore` and `attributes` but never its
    `credentials`, which `HIDDEN_IN_HOME` names too, and `~/.rustup`), the `.claude.json` copy (bound even where there
    is no real one) and a private `~/.cache` (`<session dir>/home-cache`). Hidden paths in the home are kept only inside what
    comes back, or equal to it (`~/.claude/projects`, `~/.cargo/credentials.toml`), and a shown path that is also hidden
    isn't shown; the rest are out of sight and not mounted over,
    so a file that vanishes before bwrap starts (another session's `.claude.json.tmp…`) can't fail a start. macOS keeps
    the deny-list for now: its profile could deny reads under the home and allow the same paths back, but no
    private `~/.cache` or `.claude.json` copy can stand in there, and it can't be tried on a Mac from here.
  - Everything else reads as it is and takes no writes, `~/.claude/settings.json` included.
- **Linux: bubblewrap only** (decision `navi.sandbox-linux-requires-bwrap`). `--ro-bind / /`, then `--dev`, `--proc`
  with `--unshare-pid` (no other process, so no `/proc/<pid>/root` back to the real disk), `--unshare-ipc`, a tmpfs
  `/tmp`, then the fence's paths shallowest first: a hidden dir gets an empty tmpfs (remounted read-only at the end), a
  hidden file `/dev/null`. `--new-session`, so no controlling terminal of the node's takes keystrokes (TIOCSTI).
  `NO_ENV` (`XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, `DISPLAY`, `XAUTHORITY`) is left out of a
  Navi's environment, and unset again inside: a D-Bus or systemd socket would start a command outside, and an X server
  takes keystrokes for a terminal outside. Landlock alone was not enough: it can't stop a connect to those
  sockets by path. The network is shared, for the site gate. Abstract sockets (an X server's `@/tmp/.X11-unix/X0`,
  reachable on default GNOME through `xhost +si:localuser`) are closed by Landlock instead: `scope_hook` runs in the
  spawned process before it execs (systemd-run's or bwrap's) and restricts it to a domain that handles no file access,
  so bubblewrap still mounts, and scopes abstract Unix sockets (ABI 6, Linux 6.12). Its processes still reach each
  other's. Below ABI 6 it runs without, and says so.
- **The machine says which** (`RunnerInfo.sandbox`, `NaviSandbox {status, line, fix}`, from `sandbox::describe` in the
  node's probe): `ready`, `gap` (an old kernel) or `missing`. The doctor's `navi_sandbox` check shows it on Machines:
  pass, warn, or unknown for missing (quiet, since only a Navi needs it and other agents run as before).
- **macOS:** `sandbox-exec -p` with a generated profile: `(allow default)`, `(deny file-write*)` then allow the
  written paths and the usual devices, deny writes to the kept ones, then one `file-read-data` rule per hidden
  (deny) and shown or written (allow) path, shallowest first, so the deeper one wins as a bwrap mount does (metadata
  stays readable, so paths still resolve).
- **No fallback.** `Runner::fence`, awaited before `Runner::spawn`, runs `sandbox::check` on a blocking thread: it
  prepares the paths and starts the sandbox once with `true`. `wrap` then only builds the command. The probe's
  `describe` runs on a blocking thread too. A setuid-root bwrap gets its own fix, enabling unprivileged user
  namespaces: the scope hook's `no_new_privs` keeps it from elevating, so it makes its sandbox as any user would. A
  hidden file gone before bwrap starts (a short-lived `.claude.json.*`) is skipped: arguments mount over only what is
  there, and a failed start check runs once more when the hidden paths changed meanwhile. When the program is missing or that
  run fails, the session fails with `RunnerError::Sandbox {message, fix}`, which reaches the app as the session's error
  with its fix: how to install bubblewrap, and, when the user namespace was refused, the AppArmor profile
  (`/etc/apparmor.d/bwrap-userns-restrict`) or `kernel.apparmor_restrict_unprivileged_userns=0`.
- Its agent-browser daemon listens in its scratch dir (`AGENT_BROWSER_SOCKET_DIR`).
- Tests (`sandbox_tests.rs`) run real bwrap or sandbox-exec: writes to fleetd's dir, another worktree, the home,
  claude's settings and the folder's `.claude` fail; the token store, `~/.ssh`, `~/.config`, other projects, other
  sessions' conversations and history, `~/.Xauthority` and `~/.npmrc` can't be read, and no X server is in reach;
  files, git, scratch, `/tmp`, the session's own files and a refreshed login work. Without a sandbox they skip and say why; CI's
  `rust (linux)` installs bubblewrap and `rust (macos)` uses sandbox-exec, both with `FLEETD_REQUIRE_SANDBOX`.
- Readable to it, as claude needs them: the session's MCP config (with the resolved tokens of its own servers), the
  login, and the folder.

### The permission relay (`hub/approvals/permissions.rs`)
- The relay answers a Navi lead's prompts only (`ApprovalHub::navi_lead`); any other session's are left as before.
- A prompt reaches the hub as `thread.waiting` with `data.permission`. The tool's input, up to 64 KiB of JSON, rides
  on `PendingPermission.input` and is read off the thread (an event's data is capped at 2 KB).
- For an MCP server's tool, the integrations policy decides first (`hub/integrations/policy.rs`, `verdict`, against
  the project's servers). A read answers Allow at once. A blocked tool is denied with why, and nothing is filed. An
  asking tool opens an approval with its preview: recipients, subject and body. Any prompt whose input the node didn't
  send (over 64 KiB) is refused: no card could show what approving it runs. Any other tool (a
  command, an edit) opens an approval with its summary and input.
- An approval is a request with `permission: {threadId, requestId, toolName, summary, input, preview?}`, shown in the
  chat as a `command_approval` item.
- At launch, a Navi's lead also gets the policy's `launch_rules` (`hub/executor/mod.rs`): its integrations' reads in
  `--allowedTools`, and tools the blocked list refuses in `--disallowedTools`.
- The site gate runs first, for a Navi's fetches and browser visits (above).
- Only a person answers. Approve sends `Allow {updatedInput: <the input shown>}`. Deny sends "`<who>` said no (`Q<n>`):
  `<reason>`". Withdrawing or closing a request denies the prompt. A second prompt, or the run ending, closes an older
  request ("expired: the run ended"). An approve the node didn't take because it was offline goes back to open.
- Not built: reminders for a prompt left waiting, and a sweep for prompts whose run ended while the hub was down
  (#356's version had both).

---

## 8. The factory bridge (W97)

Navi works with the other projects on its hub through three things: a message to a project's lead, one read of the
whole factory, and a wake when what it asked for changes. The code is `crates/fleetd/src/hub/navi/bridge.rs`; the
contracts are `crates/fleetd-contracts/src/navi.rs`.

**Who may use it.** Only a Navi's lead: a project the hub keeps in `assistants`, not archived. Any other lead is
refused (`bridge::may_use`), and a task never makes the calls (`hub/tasks/policy.rs`). A Navi can't message its own
project or one the hub doesn't have. One person owns every project on a hub today, so there is no owner check yet:
owners arrive with company Navi (one Navi per person on a shared hub), and the check goes in the same function.

**`project_message {project, text}`.** `project` is a title or project id. The text goes into that project's chat as
the agent "Navi <title>" (`chat::flow::send_as_agent`), never as the person, so its lead reads it through `chat.agent`:
input, never the person's answer or approval. Navi can't approve a gated command, a secret or a merge anywhere; those
stay with the person, in that project's chat. Each message is an ask with a handle, `N<n>`, which the call returns and
the message ends with:

> (Ask N3. If you open an order for it, pass asked: "N3" to brief, so Navi hears when it lands.)

A retry, with the same words to the same project within 10 minutes, returns the first handle and posts nothing new. The
person sees all of it: Navi's message in the target chat under Navi's name, and Navi's own turn in its chat.

**`factory_status {project?}`.** One read-only call over every other project, or the one named. Each project comes
with its status row's state (working, waiting on the person, blocked, idle), why it's blocked, a red main
(`warning`), running agents, its last merge and merges over 7 days. It also lists open orders with their headlines,
checklist items not done, and this Navi's last asks to it with the orders opened for each.

**Being told.** The lead that opens an order for an ask passes `asked: "N3"` to `brief`. Its `workstream.created`
event carries the handle, and the order is linked only when it is in the project that was asked. From then on
`bridge::run` follows the event log, with its cursor in `time_cursors` as `navi.bridge`, and wakes the asking Navi's
lead with one line (`LineKind::Factory`) when:

- its lead opens the order: `- N3 to Storefront: its lead opened order W12 "Gift cards"`;
- a PR of the order merges, fails CI, is refused or is given up by the train (`change.state`);
- the order is closed as done, or stopped.

Orders a lead opens on its own wake no Navi. A reply to a question doesn't wake Navi yet: the person sees it in that
project's chat.

**In the app.** The hub tool `navi_asks {navi: {machineId, projectId}}` gives the app a Navi's asks, newest first,
each with the project it went to, Navi's words, when, and the orders opened for it with their state and headline. It
takes read on the Navi's machine, and a hub has it when its `ready` frame names the `navi_asks` feature
(`APP_FEATURES`), so an app can check for it before calling. The app doesn't call it yet. The answer lists the newest
100 asks. A project on a machine the caller can't read shows only its id, without its orders, as `order_get` filters.

**Storage.** `navi_asks` holds one row per message (from, to, text, when); `navi_ask_orders` maps each order opened
for an ask to it. An ask may become several orders.

## 9. Integrations and approvals (W97)

A Navi reaches outside services through MCP servers marked with what they are (`McpServer.integration`: `google`,
`notion` or `custom`). The code is `crates/fleetd/src/hub/integrations/`; the contracts are
`crates/fleetd-contracts/src/integrations.rs`.

**Connecting.** From the Navi's settings (Integrations), never a coding project's: `mcp_server_set` refuses an
`integration` on a project whose kind isn't `assistant`, since a coding lead runs with full access. Notion is its
official server (`npx -y @notionhq/notion-mcp-server`) with the person's internal integration secret as `NOTION_TOKEN`;
a custom server is any URL or command, with the tools the person marked as only reading in `read_tools`. A key or token
is sealed in the app to the Navi's machine; the hub keeps its fingerprint only, and Disconnect (`mcp_server_remove`)
makes the node forget it. Google (Gmail, Calendar, Drive) is fleetd's own: the hub serves it as a server named `google`
of kind `google`, and `hub/integrations/google.rs` holds its tool names and the input fields its cards read.

**The gate, outside the model.** `policy::verdict(tool, input, servers)` answers each permission prompt for an MCP tool
of the Navi's lead: Allow for a read; Ask with a `ToolPreview` for a write, send, delete, share or spend; Block for what
is refused even if approved. `policy::launch_rules` puts the read tools in `--allowedTools` and the blocked ones in
`--disallowedTools`. The relay (Navi core) calls both. The order of rules:

1. The blocked list, by the words of any tool's name on any server: moving money (transfer, payout, withdraw, wire,
   money, funds, sending a transaction), trading (trade, sell, swap, stock, crypto; buying or placing shares, orders,
   positions) and creating accounts (sign up, create or open an account).
2. The integration's table: `google.rs`, `notion.rs` (`API-*` reads by verb, `API-patch-page` with `archived` is a
   delete), or a custom server's `read_tools`.
3. Anything else asks, with its action guessed from its name.

An ask is also blocked when its input looks like a credential (`hub/redact`): in its text, and inside an attached file
whose bytes read as text (valid UTF-8, almost no control characters). A value that decodes as base64 is a file, and its
base64 is never searched as it is, since random letters spell key shapes by chance; a binary file is shown by name and
size and the person decides (D193). A value under 256 characters is too short to be a real file, and its own text is
searched too, so a key can't go out as a tiny file. An ask is also blocked when its whole input, a file's bytes said by their size,
doesn't fit the card (100,000 characters). Nothing is ever "always allowed".

**The card.** `ToolPreview` carries the account, every To/Cc/Bcc, an audience line when the tool picks recipients
itself, the subject or title, the time, the attachments (name, size, source), the target and the whole body, all read
from the input the tool runs with, plus that input as JSON. The app names the Navi ("Ada wants to send an email"), marks
an address outside the account's domain and Bcc, puts its one warning word only on a share, delete or spend, names the
act on its buttons (Send it / Don't send), and once answered folds to what was decided ("Approved: send an email to …"),
never "Sent": the hub knows the answer, not the tool's result.

---

## Sources
- Grok Bot: [Flavio Copes, deep dive](https://flaviocopes.com/grok-bot/), [VentureBeat](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month), [Grok Automations](https://aitoolhunt.co/blog/grok-automations-scheduled-email-tasks-2026)
- OpenAI dots: [TechCrunch, Oct 26 2026](https://techcrunch.com/2026/10/26/how-openai-turned-its-coding-tools-into-dots-an-always-on-personal-assistant/), [MindStudio](https://www.mindstudio.ai/blog/chatgpt-dots-how-to-use)
- Claude Duet: [DataCamp](https://www.datacamp.com/blog/claude-duet), [US News](https://money.usnews.com/investing/news/articles/2026-10-21/anthropic-unveils-claude-duet-ai-agent-app)
- Hermes Agent: [GitHub](https://github.com/nousresearch/hermes-agent), [site](https://hermes-agent.nousresearch.com/), [Dupple](https://dupple.com/learn/what-is-hermes-agent)
- Name checks: [Coupa Navi](https://procurementmag.com/technology-and-ai/coupa-unveils-navi-real-time-ai-aid-debuts-at-inspire-vegas), [Atlas Navi](https://atlas.co/blog/introducing-navi-ai-that-builds-maps-from-conversation/), [Navi Group](https://en.wikipedia.org/wiki/Navi_Group), [marina.computer](https://marina.computer/), [Bosun agent](https://github.com/PerishableDave/bosun), [Shipmate](https://apps.apple.com/us/app/shipmate-plan-track-cruises/id380449520)
