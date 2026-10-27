# Team-ready fleetd: people, sign-in, roles, group chats and private Navis

Research W98 (T746) at `4e2d25279`; step 1 is W99. Paths are under `crates/fleetd/src/` unless shown
otherwise, and the file:line references are as of that research commit. Builds on the Navi plan and multi-repo
([multi-repo.md](multi-repo.md)).

## Decided

The product questions (§10) are answered, and these decisions override anything below that says otherwise:

1. **Projects are open to everyone on the hub by default**, with a switch to make one private. **Navis are always
   private** to their one person.
2. **Hub admins can read people's Navis.** Navis are private between members, not from the hub's admins.
3. **Accounts:**
   - **Claude: each person chooses** (D200), in their own settings, and can switch at any time:
     - **their own Claude subscription**, connected from the app with a long-lived token (what `claude setup-token`
       makes), sealed to the hub's machines like other secrets; or
     - **the hub's API configuration**: the admin's Claude API key and an optional custom endpoint.
   - **Whose account runs what:**
     - An order's agents (writers, readers, reviewers) use the choice of the person who started it (`startedBy`).
     - A Navi, its lead included, uses its owner's.
     - **A project's lead serves everyone**, so it always runs on the hub's API configuration, else the hub owner's
       subscription. It never switches accounts per turn: one lead turn mixes several people's work, and switching
       would throw away the prompt cache.
     - Work nobody started (automations, train fixes) runs the same way as the lead.
   - The admin can **turn the hub's API option off for members** on the Administration page. It is on by default, and
     it never affects leads or work nobody started. Someone with neither is **asked to connect before their first
     order**. One person's subscription is never used for anyone else's work.
   - **GitHub: one GitHub App per hub** (D190). The admin creates it during setup through GitHub's app-manifest link,
     so there is nothing to paste, and fleetd runs no shared app. No separate OAuth app.
     - Its **installation token** does the hub's own work: the train, merges, CI reads, webhooks, and PRs no person
       asked for.
     - **Each person connects their GitHub account through the same App's user sign-in** (a user-to-server token,
       refreshed as it expires).
   - **PRs open under the GitHub account of the person whose message started the order**, with their user-to-server
     token. Commits are authored by them, with `Co-Authored-By` the agent; anyone else in the order is added as a
     co-author.
   - **Automations and train-opened fixes use the App's installation token**, and so do merging and the train's checks.
   - A person without GitHub connected is **asked to connect before their first PR**. fleetd never silently uses
     someone else's account.
   - Each order records **which person started it** (`Workstream.startedBy`, from step 1), so this needs no migration.
   - Both are later steps (§8, step 8).
4. **Admin options live on a separate Administration page** in the app: people, invites, roles and hub-wide settings.
   It is shown only to owners and admins, and normal screens show no admin controls. Below, "Settings › People" and
   "Settings › Activity" mean that page.

## The recommendation in brief

Add **people** to the hub. A person owns devices (today's human keys) and agent keys. Each project gets **members**
and becomes a **group chat** with its one lead. Each Navi is a **private project with exactly one member**.

**Sign-in pick: hub-issued invite links.** fleetd is its own identity provider. An invite is today's pairing code,
bound to a person and valid for longer. When the hub is on a tailnet, a person can link their Tailscale login, and
their next devices sign in with that login and no code. There is no OAuth app, no SMTP and no fleetd cloud.

Keep it to **three hub roles** (owner, admin, member) and **two project roles** (maintainer, member). Approvals,
secrets and decisions record **the person**, not the device. The hub enforces who may answer what. A one-person
hub looks and behaves exactly as it does today.

**First step (m): people, invites and names.** Every key is bound to a person. Existing hubs migrate to one owner.
`fleetd invite`, the chat, approvals, decisions and the checklist record the person, and the lead sees who wrote.
This alone lets a small trusted team share a hub, which is what the security page already promises
(`docs/site/src/content/docs/security.md:6`, "built for one person or a small team").

---

## 1. What breaks for teams today

The root cause: **a key is a device, and grants are per machine, not per project.** `Caller` *is* the key
(`hub/api/registry.rs:16`, `pub type Caller = AgentKeyInfo`). A key has a name, a kind (`agent` or `human`) and grants
of `read|operate|admin` on `*` or a list of machines (`crates/fleetd-contracts/src/auth.rs:18-37,45-65`). Every check
asks "does this key hold role R on machine M" (`hub/auth/mod.rs:176-185`, `hub/api/grants.rs:24-67`). There are 186
such checks in 51 files under `hub/`. Nothing knows who the person behind a device is, or which projects they belong
to.

| Area | What happens today | Why it breaks with several people |
|---|---|---|
| **Keys and pairing** | `fleetd pair` mints a one-time code. The device trades it for a **human key with the code's role on every machine**, default `admin` (`hub/pair/mod.rs:29-31,279-283`; `cli/pair.rs:16-23`). `hub key create --human` defaults to operate on every machine (`cli/hub_key.rs:25-27`). | A teammate's laptop is "a human device" exactly like the owner's. It has no person, no project scope, and by default admin over the whole hub. Revoking "Alice" means finding her devices by name. |
| **Chat** | A human key writes `ChatAuthor::Human` with `by` = the **device name** (`hub/chat/flow.rs:194-205`; `crates/fleetd-contracts/src/chat.rs:52-60,246`). The lead is told only "The human writes in your chat:" (`assets/prompts/chat.human.md:1`; `hub/chat/flow.rs:401-414`). Writing needs operate on the machine (`hub/chat/flow.rs:217`). | The lead can't tell Alice from Bob. Every message is "the human", so it takes a stray "go ahead" from anyone as consent. |
| **Needs you** | One boolean per project: "the lead's last message waits for a human reply" (`crates/fleetd-contracts/src/chat.rs:270-282`). The lead prompt is built around one person: "You and the human share one chat" (`assets/prompts/lead.start.md:1`, "Asking the human" at `:16`). | No way to ask *Bob*. Everyone's badge lights up for every question. |
| **Approvals** (`gated_run`, preview settings) | Any human key with operate on the project's machine may answer, recorded as `human:<device name>` (`hub/approvals/mod.rs:872-907`). | Anyone with operate on the machine approves anything on it, including money or irreversible commands in projects they have nothing to do with. The audit shows a device name. |
| **Secrets** (`request_secret`) | Only a human key may submit, and it needs operate on the sink and project machines (`hub/approvals/mod.rs:586-617`). The value is sealed to the machine; the hub keeps a fingerprint (`app/desktop/src/main/secret.ts:1-3`, `node/secrets.rs:1-4`). | The crypto is sound. But the secret becomes the *project's*, and nobody records whose credential it was. Any member's device can overwrite it. |
| **Memory** | One `user.md` "shared by every project" (`hub/memory/mod.rs:1-5,26`). It is injected into every session as "How the human works" (`hub/memory/mod.rs:554-580`). Memory edits need operate on the machine (`hub/memory/tools.rs:30,125`). | Alice's preferences get applied to Bob, and Bob can read and edit Alice's profile. The nightly refresh (open PR #621) may only *add* to `user.md`, so it mixes everyone into one file. |
| **Decisions** | A human key's decision is `source: human`, `by: human:<device>` (`hub/ledger/tools.rs:54-67`; `DecisionSource` at `crates/fleetd-contracts/src/ledger.rs:167-174`). | "The human decided" is no longer meaningful. Anyone can overturn anyone. |
| **Checklist** | "The lead's to-do list for the human", one list per project, and items have no owner (`hub/checklist/mod.rs:1-3`; `crates/fleetd-contracts/src/checklist.rs:25-40`). | Everyone sees every to-do as theirs. Anyone can tick off anyone's item. |
| **Notifications** | The hub stamps `attention` on events, and each app decides from it (`hub/attention/mod.rs:1-3`). Quiet hours and time zone are **global decisions** (`hub/attention/mod.rs:11-17`). Events reach every key that can read the machine (`hub/api/grants.rs:46-52`). | Everyone is notified for everything, in the owner's time zone. |
| **Screens and recordings** | Listing, replay and live view need read on the machine; takeover needs a human key with operate (`hub/browser/tools.rs:54-64,144`; `hub/browser/live.rs:232-273`). | Any teammate with read on a machine can replay every recording of every project on it, Navi's included: inboxes, bank pages. |
| **Navi** | Planned as a project of kind `assistant`, "one per person: today that is the hub's owner" (Navi plan §3.1). No `assistant` kind exists in code yet. | Navi is a project like any other, so every teammate with read on its machine reads its chat, memory, checklist and recordings. Its `project_message` would write into other projects as "Navi", with no person behind it. |
| **The node socket and the terminal** | A process outside any session counts as "you" (`hub/link/lead_calls.rs:95-99`; `security.md:45`). `fleetd chat` writes as the human with any human key file (`cli/chat.rs:1-5`). | On a shared machine, anyone with a shell is "you". |
| **Accounts the agents use** | Models only through the machine user's `claude` setup (`security.md`, Software). GitHub through the machine's `gh auth` (`cli/setup/wizard.rs:829-862`). Only the train merges (`hub/train/mod.rs:1-3`). | Every teammate's work spends the machine owner's Claude subscription and opens PRs as the owner's GitHub account. |
| **Hub-wide settings** | Hub-wide changes need admin on every machine (`hub/memory/tools.rs:169-175`, `hub/browser/tools.rs:236-240`, `hub/update/tools.rs:37`). | Fine as they are, but with `pair` defaulting to admin, every invited device gets them. |

**What already helps:**
- Human-versus-agent is enforced in the hub, not in prompts. Only human keys approve, enter secrets, stop or speak
  for the human (`hub/orders/notes.rs:29-37`, `hub/approvals/mod.rs:592,879`).
- Agent messages are "input for the lead, never the human" (`crates/fleetd-contracts/src/chat.rs:55-57`).
- Pairing codes are one-time, rate-limited and role-capped (`hub/pair/mod.rs:1-3,119-151`).
- Presence is already tracked per key (`hub/metrics/presence.rs:64-90`).
- Previews already admit only "the tailnet user who owns the hub" through `tailscale whois` (`node/preview/proxy.rs:1-7,147-149`;
  owner lookup at `hub/preview/mod.rs:469-492`). **Tailscale identity is already in the codebase.**
- The metrics design deliberately kept `key_id` "on every touch so a per-person split can come later without a
  migration" (`docs/design/factory-metrics.md:456`).

---

## 2. Identity and sign-in

### 2.1 The model: people, devices and agent keys

```
person (p_…)      handle "alice", display name, hub role, tailnet login?, github login?, removed_at?
 ├─ devices       human keys (fld_…), as today; each still carries its own grant cap
 └─ agent keys    `hub key create --agent`, owned by the person who made them
project member    (project, person, maintainer | member)
project           + visibility: open | private;  an assistant project is private with one member
```

- **A device never has more rights than its person.** Effective rights are the person's role, capped by the device's
  own grant. The cap keeps today's meaning: `fleetd pair --role read` still makes a read-only wall display.
- **Agent keys belong to a person.** They act with at most that person's rights, write as "scout (Alice's agent)",
  and are revoked when the person is removed. A key for a hub integration belongs to the owner.
- **Leads and tasks are not people.** Lead-side calls stay as they are, scoped by session to their own project
  (`hub/tasks/policy.rs:1-3`). Navi's factory bridge is the one place where an agent acts *for* a person (§5).

### 2.2 The options

| Option | For | Against, for self-hosted fleetd |
|---|---|---|
| **Tailscale identity** (`whois` on the peer) | No UI at all. The identity comes from the team's IdP, with its SSO and MFA. fleetd already uses it for previews. Node sharing covers people on other tailnets. | Not every hub is on a tailnet. `fleetd init` falls back to `127.0.0.1`, and some hubs sit behind an HTTPS proxy, where the peer is the proxy. Tagged machines and shared logins have no person. Admitting "whoever is on the tailnet" hands the hub's membership to the tailnet admin. |
| **GitHub OAuth** | Most members have GitHub. It maps PR authors and reviewers to people. | Every self-hoster must register an OAuth app with a callback the hub serves. The device flow avoids the callback but still needs a registered app. Designers and PMs using Navi may have no GitHub. It still needs an invite step to decide who gets in. |
| **Passkeys / WebAuthn** | The strongest per-device credential, phishing-proof. | Needs a secure context and a stable domain (HTTPS on a MagicDNS name, or a cert). Support inside Electron is uneven. A passkey is per device anyway, which is what a device key already is. |
| **Email magic links** | Familiar. | Needs SMTP, and the hub has no public URL. The link would point at a tailnet address anyway. |
| **Invite links (hub-issued)** | Reuses pairing, which is one-time, hashed, rate-limited and role-capped (`hub/pair/mod.rs`). Works on any network, with no third party. The admin decides who joins, like Linear, Slack and Tailscale invites. | A code or link has to be passed to the person, once per person. Adding a second device needs either another code or a link to the person's first device. |

### 2.3 The pick: invite links, with Tailscale login as an optional fast path

1. **Invite.** An admin runs `fleetd invite alice [--admin]` or uses Settings › People › Invite. This creates the
   person and a single-use link, `fleetd://pair?hub=…&code=…`, the same deep link as today (`cli/pair.rs:64-67`).
   The code is bound to the person and lives **7 days**, not 15 minutes, because it travels by chat or email. The
   same 40-bit code, hash and per-address limiter apply (`hub/pair/mod.rs:21-26,159-182`). Alice opens it and her
   app pairs; the key it mints belongs to her.
   - Older apps redeem it unchanged: they POST the same `{code, deviceName}` to `/pair`.
2. **More devices.** There are two ways, both without the admin:
   - **From a signed-in device:** Alice's app, under Settings › My devices › Add a device, mints a code for *her*.
     This is how Signal and WhatsApp link devices.
   - **Sign in with Tailscale (hub on a tailnet only):** the first time Alice pairs over the tailnet, the hub runs
     `tailscale whois` on her connection, the same call as `node/preview/proxy.rs:60-70`, and offers to link that
     login to her person. From then on, a new device on her login gets an **"Is this you, Alice?"** screen with one
     click. The key it mints belongs to her, with member rights, never admin by itself. Tagged devices are refused,
     as previews already refuse them (`proxy.rs:147-149`). Behind `tailscale serve`, the peer is loopback, so the
     hub trusts `Tailscale-User-Login` only from loopback and only when configured for it.
3. **The owner** is created by migration (§7) or by `fleetd init`. `fleetd pair` keeps working and pairs one more
   device **for the owner**. `fleetd pair --person alice` pairs for Alice.
4. **Sign out and remove.** Settings › My devices revokes a device. Removing a person revokes all their devices and
   agent keys at once (`Auth::revoke`, `hub/auth/mod.rs:290-306`). Their assignments go back to the project's
   maintainers (§4).

**Why this pick.**
- It is the only option that works on every hub with no dependency, and most of it already exists.
- It keeps "who is in" a decision of the hub's admin, as Linear, Slack and Tailscale invites all do. Network
  reachability alone never grants membership.
- Tailscale gives the convenient second-device flow, and the team's MFA, wherever it is available.
- GitHub comes later as a **connection on the profile** through the hub's GitHub App, not a sign-in to fleetd, so
  PRs open as the person (Decided, 3).
- Passkeys fit later, once hubs commonly serve HTTPS on a stable name.

---

## 3. Roles and permissions

Keep it to five words. Hub-level, as in Linear, Slack and Tailscale: **owner, admin, member**. Project-level, as in
Vercel's project roles: **maintainer, member**. A read-only "viewer" or "guest" (for a client) can come later by
capping a member's devices to read.

| Who may… | Hub owner | Hub admin | Project maintainer | Project member | Notes |
|---|---|---|---|---|---|
| Invite and remove people, set hub roles | ✓ | ✓ (not owners) | | | Owner is the hub machine's person; at least one always exists |
| Add machines, update fleetd, hub-wide settings (caps, retention, prompts, global decisions, default quiet hours) | ✓ | ✓ | | | Today's "admin on every machine" checks map here |
| Create a project | ✓ | ✓ | | ✓ on machines the admin opened to members | Its creator becomes its maintainer. Today: operate on the machine (`hub/projects/mod.rs:556-559`) |
| Add or remove project members, change visibility | ✓ | ✓ | ✓ | | |
| Project settings: env/secrets list, MCP servers, preview, automations, memory edits | ✓ | ✓ | ✓ | | Members see names and fingerprints, never values |
| Chat with the lead, start work, steer, answer the lead | | | ✓ | ✓ | Admins join a project to talk in it, like Slack admins joining a channel |
| Approve `gated_run`: `Credential` and session tool prompts | | | ✓ | ✓ | Or only the person it is addressed to (§4.4) |
| Approve `gated_run`: `Money` and `Irreversible` | | | ✓ | | Urgent classes (`hub/attention/mod.rs:20-31`) |
| Enter a requested secret | | | ✓ | ✓ | Recorded as given by that person (§6) |
| Stop all work in a project | | | ✓ | ✓ | Today any human key (`hub/orders/notes.rs:29-37`) |
| Live view, takeover, recordings of a project | | | ✓ | ✓ | Project members only, never "read on the machine" |
| See an **open** project, read its chat | ✓ | ✓ | ✓ | ✓ any member of the hub | Like Slack's public channels; joining is one click |
| See a **private** project | | | ✓ | ✓ | Its members only |
| See someone's Navi | ✓ | ✓ | | | Its one person, and the hub's owners and admins (Decided, 2). No other member |

How it is enforced: `Caller` gains the person (loaded at `Auth::verify`, `hub/auth/mod.rs:246`), and a
`require_project(caller, action, project)` replaces `require(caller, role, machine)` wherever a project is named.
Machine-scoped checks stay for machine things: doctor, machine settings, node enrollment. Event fan-out
(`hub/api/grants.rs:46-52`) and `readable_projects` (`hub/agents/mod.rs:32`) filter by membership. This sweep across
the 186 call sites is the largest single piece of work (§8, step 3).

---

## 4. A project as a group chat with one lead

### 4.1 Who "the human" is
- The lead talks to **the room**. Each human message is rendered with its author: "Alice (maintainer) writes:" in
  place of "The human writes" (`assets/prompts/chat.human.md:1`).
- The digest gains a short **roster**: each member's handle, role and whether they have been active lately.
- `lead.start` says "the people in this chat" instead of "the human". With **one member, the prompt text stays
  exactly as today**, so solo hubs see no change.
- When several people are active, the lead addresses replies by name. A reply to one person's question uses
  `reply_to`, which already exists (`crates/fleetd-contracts/src/chat.rs:249-250`).

### 4.2 Addressing the lead, and side talk
- **Every message goes to the lead by default**, as today: the chat exists to talk to it.
- `@lead` is accepted but never required.
- A message that **@mentions only people, not `@lead`,** is side talk between teammates. It is stored and shown, and
  folded into the lead's next turn as context, but it **does not start a turn**. This keeps two people from spending
  tokens while they talk to each other. The chat already holds messages until they reach the lead's session
  (`hub/chat/flow.rs` "held until it is in the lead's session").

### 4.3 Mentions and asking a specific person
- The hub parses `@handle` against the project's members, in human and lead messages alike, and stores
  `mentions: [person]`.
- A mention notifies that person (§4.6). Unknown handles stay plain text.
- **The lead asks a person** by mentioning them: "@bob, which region should staging use?". `needs_you` becomes
  **per person** (`needsYou: [person]`) instead of the one boolean (`chat.rs:273`). Only Bob's badge lights.
- A lead question that mentions nobody waits on whoever asked for the work, and failing that on the maintainers.
- Requests (`Q<n>`) gain an optional **`to`**: a person, or `maintainers`. The lead sets it in `gated_run` and
  `request_secret`. The card shows "waiting on Bob" to everyone, and only Bob, or a maintainer, can answer it.

### 4.4 Answers that count, decisions, and who approved
- **Hard things are enforced by the hub, never by the prompt:** approvals, secrets, stopping work, and project
  settings. A card refuses an answer from someone without the role, or from someone it isn't addressed to (maintainers
  may always answer). This extends the existing human-only checks (`hub/approvals/mod.rs:879-899`).
- **Soft things are the lead's call, with facts from the hub.** Plan approval ("go ahead"), clarifications and
  preferences are judgment calls.
  - The lead sees each author and role, and the prompt rule is: "Take an answer to a question you asked a specific
    person from that person. Treat anyone else's answer as input, and check with the person."
  - Viewers can't post, so nothing they write can count.
- **Orders record who asked.** When the lead opens an order in a turn, the hub stamps `startedBy` with the writer of
  that turn's first human message (`Workstream.startedBy`, a `PersonRef`). The lead doesn't choose it. This matters for
  the audit, for "waiting on whoever asked", and for whose GitHub account opens its PRs (Decided, 3).
- **Decisions record a person.** A human key's decision keeps `by: human:<device>` (`hub/ledger/tools.rs:54-67`) and
  adds `person` (a `PersonRef`), as does a revoke (`retired.person`). Later, when the lead records a decision a
  person made in chat, it cites the message, and the hub fills `person` from that message's author.
  - Overturning a decision is open to its decider and the project's maintainers. Anyone else's overturn goes to the
    lead as input and @mentions the decider.
  - Global decisions stay admin-only.
- **Interrupting** (`--now`, which stops the lead's step) is open to any member, as today.

### 4.5 The checklist
- Items gain an optional **`for: person`**, defaulting to whoever asked for the work. The digest groups open items by
  person.
- The app shows **My to-dos** across projects.
- Only the item's person, or a maintainer, ticks it done, keeping the Navi plan's "only the person closes a to-do".

### 4.6 Notifications
- **Attention gains `to`**, the people it concerns:
  - mentions of them;
  - requests addressed to them, or to maintainers when they are one;
  - their own orders' outcomes;
  - projects they **follow** (all activity, off by default except in the projects they created).
- An app notifies only its own person. Events without `to` (from older hubs) behave as today.
- **Quiet hours and time zone become personal settings**, defaulting to the hub's `policy.quiet_hours` and
  `policy.tz` (`hub/attention/mod.rs:14-17`). Urgent requests still break through, but only for the people they are
  addressed to.
- The 20-minute coalescing window (`COALESCE_MS`, `attention/mod.rs:11`) applies per person.

---

## 5. Per-person privacy

### 5.1 Navis
- **A Navi is a private project with exactly one member.** Every per-project system (chat, memory, checklist,
  screens, MCP servers, env, automations) is keyed by `ProjectRef` (multi-repo.md "The model"), so project membership
  makes all of it private at once. No Navi-specific privacy code is needed beyond step 3.
- Each person gets **"Create my Navi"**. Its directory is under the hub home's `people/<handle>/navi` or on a
  machine the person chooses, ideally their own laptop's node.
- **The factory bridge acts as its person** (Navi plan §3.8):
  - `factory_status` shows only the projects that person is a member of.
  - `project_message` writes into another project as an agent, labelled "Navi (Alice)", which is input and never
    an approval (`chat.rs:55-57`). It is allowed only in projects where Alice is a member.
  - A Navi never answers an approval, a secret or a takeover anywhere.
- Its secrets (a 1Password service account, Gmail tokens) are sealed to its machine and belong to that project
  only, as the Navi plan already says (§3.7).

### 5.2 Memory
- **`user.md` becomes per person:** `memory/people/<person>/user.md`. A lead reads the profiles of the members of
  its project only.
  - In a solo project this is one file, exactly as today.
  - In a team project, the lead reads the profiles of people active in the last 14 days, each capped smaller in team
    projects (4k instead of 16k), so ten members don't eat the prompt.
- **Remember scoping:** a lead may write to the `user.md` of **the author of a message in the current turn**, and of
  no one else. "Bob prefers small PRs" can only be remembered from something Bob said.
- The nightly refresh (#621) runs per person on that person's file.
- **A project's `MEMORY.md` is shared team knowledge**, readable and editable by its members, as today.
- **Private facts live in Navi's own memory**, never `user.md`, as the Navi plan already says. In a team that rule
  matters more, because `user.md` is read by team leads.
- Each person can see and edit only their own `user.md` in the app; owners and admins can read it too (Decided, 2).

### 5.3 Screens and recordings
- Recordings, live view and takeover belong to the project, so they follow membership. Navi's are visible only to its
  person.
- `request_takeover` goes to the person who asked for the work, or to a named person (§4.3).
- Retention stays hub-wide and admin-only (`hub/browser/tools.rs:236-240`).

### 5.4 The honest limit
Agents run as the hub's OS user and can reach its home and database (`security.md:33-36`). The hub's operator, and
any agent on the hub machine, can read anything on that disk. **fleetd's privacy is between members through fleetd,
not from the operator.** That is also how Slack and Linear work for workspace owners with data export. Say so in
Settings › People and on the Navi page. For strict privacy, run your Navi on **your own machine's node**:
- its screens, files, and the secrets sealed to that machine stay there;
- its chat and memory still live on the hub until memory can live on the node (a later, larger step);
- on a shared machine, a process outside any session acts as the machine's owner person (`security.md:45`). Document
  that teammates shouldn't get a shell on a machine they don't own.

---

## 6. Approvals and secrets in a team

**Whose credentials:**
- **Project secrets** (`request_secret`, env vars, MCP tokens) are the project's.
  - They are sealed to the machine, as today, and record **who gave them** (`answeredByPerson` on the request) and when, next to the fingerprint.
  - Members see names, fingerprints and givers, never values.
  - Maintainers rotate or remove them.
  - A person's own credentials (their email, their bank, their 1Password) belong in **their Navi**, never in a team
    project.
- **Accounts the agents use** (Decided, 3; a later step):
  - **Claude:** each person picks, in their own settings, their own subscription or the hub's API configuration
    (D200), and can switch at any time.
    - A subscription is connected from the app with a long-lived token (what `claude setup-token` makes). It is
      sealed to the hub's machines like other secrets, and the agents run for that person's work get it as
      `CLAUDE_CODE_OAUTH_TOKEN`. The hub's way sets `ANTHROPIC_API_KEY`, plus `ANTHROPIC_BASE_URL` when an endpoint is
      set.
    - An order's writers, readers and reviewers use its `startedBy`'s choice. A Navi, its lead included, uses its
      owner's.
    - A project's lead, and work nobody started (automations, train fixes), always run on the hub's API
      configuration, else the hub owner's subscription. The lead never switches accounts per turn, since one turn
      mixes several people's work and a switch would throw away the prompt cache.
    - The admin can turn the hub's API option off for members on the Administration page; then each member connects
      a subscription. The switch is on by default and never affects leads or work nobody started. Someone with
      neither is asked to connect before their first order. One person's subscription is never used for anyone
      else's work.
    - Usage limits are tracked per account: when one person's subscription hits its limit, only the work running on
      it waits for the reset, and everyone else's carries on.
  - **GitHub:** the hub's one GitHub App (D190). Each person connects their account through its user sign-in. An
    order's PRs open with the user-to-server token of the person who started it (`startedBy`), its commits authored
    by them with `Co-Authored-By` the agent and anyone else in the order. Automations, train fixes, merges, CI reads
    and the train's checks use the App's installation token. Someone with no GitHub connected is asked to connect
    before their first PR; no one's account is used for anyone else.

**Who approves what:** the table in §3, enforced in `Approvals::answer` and `submit_secret`.
- `Money` and `Irreversible` commands need a project maintainer; the rest need any project member, or the addressee.
- No self-approval rule at first: someone who asked for work may approve its commands. A per-project **"urgent
  requests need a second person"** switch is a later option, like Vercel's and GitHub's required reviewers.
- Merges stay with the train after review and green CI (`hub/train/mod.rs:1-3`), so starting work is the consent that
  matters.

**Audit trail:** the event log already exists and records pairings (`hub/pair/mod.rs:287-298`). Add the person
(and the device key id) to every human action:
- invite created, redeemed or revoked;
- device paired or revoked, through Tailscale or a code;
- role and membership changes;
- approval answered (`answeredByPerson`, a `PersonRef`, next to `answeredBy: human:<device>`);
- secret given (person, fingerprint, sink);
- decision recorded or overturned;
- order requested;
- checklist item done;
- takeover taken and handed back.

Settings › Activity, for admins, filters this by person and project and exports it. It is append-only, like the
events table today.

---

## 7. Migration from single-person hubs, older apps and nodes

**At the first start of the new hub (idempotent):**
1. Create **person #1, the owner**. The handle comes from the hub machine's Tailscale login when there is one
   (`hub/preview/mod.rs:469-492`), else the OS user. The person can rename it later.
2. Bind **every existing key**, human and agent, to the owner. Today they are all the owner's devices and agents.
   Each key keeps its grants as its cap, so a device paired `--role read` stays read-only.
3. Make the owner the **maintainer of every project**. Every existing project is **open**.
4. Move `memory/user.md` to `memory/people/<owner>/user.md`.
5. Map history: `by: human:<device>` on approvals and decisions, and `by` on chat messages, resolve through the key
   name to the owner on display. Nothing is rewritten. `key_id` on metrics touches maps the same way
   (`factory-metrics.md:456`).

**Solo hubs see no change:** one member, the same prompt text, no roster, no mentions UI until a second person joins.

**Older apps** (no people support):
- They keep working with their key, now bound to a person.
- They see `by` as today, can't render mentions, and show the project-wide `needsYou` (the hub keeps sending the old
  boolean as "needs anyone").
- They redeem invite links, since the request is unchanged.
- The hub gates new fields on `PROTOCOL_VERSION` (`hub/http/mod.rs:51-53`).

**Nodes:**
- Nodes don't know about people. Lead-side calls stay session-scoped, so older nodes keep working unchanged.
- Machines gain an **owner person** (default: the hub owner), for "a process outside a session is you" on that
  machine.

**CLI:**
- `fleetd pair` keeps its meaning: a device for the owner, admin by default. `--person` and `--role` still work.
- `fleetd hub key create --agent` keys belong to whoever creates them; from the CLI, the owner.
- New: `fleetd invite <handle> [--admin]` and `fleetd people`.

---

## 8. Phased plan

**Step 1: People, invites and names (m). The smallest useful step. Being built in W99.**
- The `people` table (id, name, hub role, created), with `person_id` on keys and the migration (§7).
- `fleetd invite`, invite links (7 days, single use), and the Administration page's People (invite, remove, role).
  A new person needs a name. Only an owner makes, unmakes or removes an owner, and the hub always keeps one.
- Hub roles owner, admin, member, with member = operate on every machine and admin = today's admin.
- The lead sees "Alice writes".
- Approvals, secrets, decisions and checklist ticks record the person; the activity events carry them. Each order
  records the person who started it (`startedBy`), for step 8.
- **No project scoping yet:** everyone in the hub sees every project. That is fine for a small trusted team, the
  model `security.md:6` already describes.
- Navi stays owner-only until step 3.

What step 1 adds, in the wire types (`crates/fleetd-contracts/src/people.rs`):
- `Person` (`personId`, `name`, `role`, `createdAt`, `removedAt`), `HubRole` (owner, admin, member), `PersonRef`
  (id and name at the time), `Invite` and `people.changed`.
- `person` on `AgentKeyInfo`, `ChatMessage`, `Decision` and `DecisionRetired`, `TodoItem` and `checklist.changed`;
  `answeredByPerson` on `HumanRequest` (approvals and secrets); `startedBy` on `Workstream`; `me` and `people` on
  `hub_info`.
- Tools: `people_list`, `invite_create`, `invite_revoke`, `person_set`, `person_remove`, `device_revoke`, and
  `checklist_edit` (a person ticks, edits or removes items).

**Step 2: The group chat (m).**
- Mentions and `@lead`, and side talk that doesn't start a turn.
- Per-person `needsYou`, and requests with `to`.
- The roster in the digest, and "the people" wording when there are two or more.
- Checklist `for`, and My to-dos.
- Per-person notifications with `to`, follow, and personal quiet hours and time zone.

**Step 3: Projects with members (l).**
- Project members (maintainer, member), and open or private visibility.
- `require_project` across the ~186 check sites.
- Event and project-list filtering.
- Approvals by role and class.
- Recordings and screens by membership.

This is what makes privacy real, and it is the biggest step.

**Step 4: Per-person memory (s).**
- `people/<person>/user.md`, loading member profiles with a smaller cap in team projects.
- Remember scoped to the turn's authors, and the per-person nightly refresh.

**Step 5: Per-person Navis (m).**
- "Create my Navi" for every member, private with one member.
- The factory bridge acting as its person and limited to their projects.
- "Navi (Alice)" labels.

This builds on the Navi plan's first version.

**Step 6: Easier devices (m).**
- Add a device from a signed-in device, and Sign in with Tailscale (whois, login linking, "Is this you?").
- Settings › My devices.

**Step 7: Activity (s).**
- Settings › Activity, filtered by person and project, with export.
- Attribution in the activity log by person; PR attribution comes with step 8.

**Step 8: Accounts (m).** (Decided, 3.)
- Claude (D200):
  - The hub's API key and optional endpoint on the Administration page, with a switch to turn that option off for
    members.
  - In each person's own settings, the choice: connect their own subscription (a `claude setup-token` token, sealed to
    the hub's machines) or use the hub's API configuration.
  - Each order's agent spawn gets the account of the order's `startedBy`, and a Navi's its owner's. A project's lead
    and work nobody started get the hub's API configuration, else the hub owner's subscription, the same on every
    turn. The account goes in as `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL`. Asked to
    connect before a first order; usage limits tracked per account.
- One GitHub App per hub, created by the admin through GitHub's app-manifest link: its installation token for the
  hub's own work, and its user sign-in (user-to-server tokens, refreshed) for each person.
- PRs under the account of the order's `startedBy`, commits authored by them with `Co-Authored-By` the agent and the
  order's other people; the installation token for automations, train fixes, merges and checks; asked to connect
  before a first PR.

**Later, if asked:**
- a viewer/guest role (s);
- the "second person for urgent" switch (s);
- OIDC sign-in for organisations that require SSO (l);
- passkeys once hubs serve HTTPS (m);
- Navi memory kept on its node (l).

---

## 9. What the strong products do, and what to take

| Product | What they do | Take |
|---|---|---|
| **Slack** | Workspace roles (owner, admin, member, guest). Public and private channels. DMs. Mentions drive notifications. Per-person do-not-disturb. | Projects as **channels with one bot member**: open by default, private when needed. **Mentions are the only way to page someone.** Personal quiet hours. |
| **Linear** | Workspace admin, member and guest. Teams can be private. Invite links. Assignees on every issue. "My issues". | **Invite links**, few roles, **an owner on every to-do**, and a My to-dos view. |
| **Vercel teams** | Team roles plus project-level roles. Git commits by non-members are blocked from deploying. | **Project roles separate from team roles**, and **only members' actions count** for gated actions. |
| **Tailscale** | The identity comes from the team's IdP, and users join by invite. Devices are listed per user and can be removed. Tagged devices belong to no user. | **Whois as a sign-in fast path**, devices listed under their person, and tagged devices never admitted. fleetd already does this last one for previews. |

---

## 10. Product questions

Answered: see Decided at the top. The research's recommendations, as asked:


1. **Are projects open to the whole hub by default, or invite-only?** *Recommend open by default*, like Slack public
   channels: any member sees and joins any open project. Private is one switch, and Navis are always private. A small
   team shares context more easily that way.
2. **Can hub admins read people's Navis?** *Recommend no, through fleetd.* Say plainly that the hub's operator can
   read the disk, and point privacy-minded people to running their Navi on their own machine.
3. **Whose GitHub and Claude accounts do a team hub's agents use?** The research recommended the machines' own
   accounts, as before teams. That was not taken: GitHub is per person through the hub's App (D187, D190), and Claude
   is each person's choice of their own subscription or the hub's API configuration (D200). See Decided, 3.
