# One setup for the hub admin

Status: approved (D197), being built (§7). Revised for D189 (Google, native), D190 (one GitHub App per hub), D195
(Gmail in real time) and the answers to its open questions (§6). The prototype of the app's screens is `#/setup` in
`app/desktop/src/renderer/screens/setup`, against `fixtures/setup`.

A new hub needs a lot of configuring: where it listens, its machines, Claude, a GitHub App, and optionally people,
Google, Notion and 1Password. Today these live in five places with five vocabularies. This design makes each
one a **step**: a check with a status, why it matters, the exact values to paste, a link to the provider's page,
fields for what comes back, and a Test button. `fleetd init`, the app's first run and the admin's Administration ›
Setup all render the same steps. Only three are required. The rest wait until something needs them.

## 1. Today

### Where setup lives

| Place | What it covers | How it reads |
|---|---|---|
| `fleetd init` (`cli/setup/wizard.rs`) | 6 sections: this machine, logins (claude, gh, commit author), hub, workers, project, app and doctor | A ✓/✗ checklist, one fix command per ✗, a box of "N step(s) need you" at the end |
| `fleetd doctor` (`cli/setup/doctor.rs`, `hub/doctor/checks.rs`) | Hub checks (reachable, gh, https) and per-machine ones (online, claude login, version, disk, …) | Failing checks only, then "3 of 4 checks pass" |
| The app's welcome (`screens/onboarding`) | Connect, add a project, say hi | A 3-step checklist; "Set up fleetd on this computer" opens a terminal running `fleetd init` |
| Machines › Setup checks (`screens/projects/SetupChecks.tsx`) | The doctor's results | Each fix is a command to copy; Re-run, no Test, no fields |
| Settings › MCP servers, a project's secrets, the docs | Integrations, 1Password (`OP_SERVICE_ACCOUNT_TOKEN` as a project secret) | Spread over install, quick-start, machines, mcp-servers and browser-sessions pages |

Nothing covers a Claude API key or endpoint, a GitHub App, a Google client, or inviting people: these are new
(D186, D187, D189, D190, teams step 1).

### A first run, as a new admin sees it

`fleetd init --yes --no-service` on a fresh machine (HOME in a temp directory, no claude or gh login), and `fleetd
doctor` against that hub once started:

```console
Logins  2/6
✗  claude 2.1.310, not logged in. Fix: claude auth login
✗  gh not logged in; the merge train and PR checks need it. Fix: gh auth login
✗  commit author none set; agents need one to commit. Fix: fleetd init --git-identity "Name <id+user@users.noreply.github.com>"
Hub  3/6
–  hub not started (--no-service)
Workers  4/6
–  workers need the hub running
…
4 step(s) need you:
  claude: claude auth login
  …
  start the hub, then run fleetd init again: fleetd hub start --home ~/.fleetd/hub --listen 127.0.0.1:4797

$ fleetd doctor
✗  doctor hub gh is not logged in on the hub; the merge train and PR checks need it. Fix: gh auth login
✓  doctor 3 of 4 checks pass
```

### Pain points

1. **No one list.** init has 6 sections, the app 3 steps, the doctor a flat list of checks, Machines a fourth view.
   None of them knows about the others' items, and none covers the accounts a team hub needs.
2. **Unclear order.** init asks for claude and gh logins before the hub exists, then skips workers and the project
   when the hub isn't up. The closing box lists fixes in the order they were met, not the order to do them.
3. **Required and optional look the same.** A missing commit author is a ✗ like a missing Claude login. Nothing says
   which steps stop agents and which only matter for PRs.
4. **Values to hunt for.** A callback URL, the hub's tailnet name, a worker's join code: today the admin works them
   out or runs another command. HTTPS is a three-part fix ("serve it, stop the hub, run init again with --url").
5. **Commands, never fields.** Every fix is a command to run somewhere. There is no place to paste a key, so there is
   none for an API key or an OAuth client.
6. **No Test.** Re-run re-checks everything. Nothing proves that one thing works right after it is set up.
7. **The doctor is blind on a new hub.** With no machines it reports "3 of 4 checks pass" and says nothing about
   missing machines or Claude, since Claude is checked per machine.
8. **The app hands off to a terminal.** The welcome's "Set up fleetd on this computer" opens `fleetd init` in a
   terminal and waits; the app can't show what is left.
9. **A code that expires.** init mints a 15-minute pairing code even when the hub isn't running yet.

## 2. Every step

In order. **Need** says when it must be done; nothing blocks using fleetd before then (§3.3).

| Step | Need | What the admin pastes or picks | Values fleetd computes | Link | Result fields | Test | Exists |
|---|---|---|---|---|---|---|---|
| Where the hub listens | Required | Tailnet, this machine only, or LAN; HTTPS through Tailscale Serve is optional | Each option's URL; `tailscale serve` command | Tailscale admin | none | Reach `/healthz` from this device | init, `hub/reachable`, `hub/https` |
| Machines | Required | The machines to add | `fleetd machine add <host>`, or a join command with a code | none | none | The checks: online, runner | init, `machine add`, `*/online` |
| Claude | Required | A hub API key and an optional endpoint, **or** nothing: then the hub owner connects their own subscription. Either way, each person later picks their own subscription or the hub's configuration in their own settings, and a switch here turns the hub's option off for members (D200) | Key name `fleetd on devbox`; for a subscription, the command `claude setup-token` | Claude Console › API keys | API key (sealed), endpoint; or the subscription's long-lived token (sealed) | One tiny `claude -p` call made with the key (and endpoint) or the token, on a machine holding it (`claude_account_test`; fleetd never calls the API itself). Done by either way: the key, or the owner's subscription (§3.1) | Built (teams step 8): `claude_hub_api_set`, `claude_subscription_set`, `claude_account_test`; the app's Settings › Claude and Administration › Claude; the `hub/claude_key` and `hub/claude_owner` checks |
| GitHub App | Before the first PR | Nothing to paste: confirm the App GitHub shows, pick the repositories to install it on, connect your own account | The manifest: name, homepage, callback `<hub>/oauth/github/callback`, repository permissions, webhook | "Create on my account" or "in an organization", then GitHub's install page | none: GitHub hands the App's keys to the hub | Mint an installation token and list the repositories it reaches; the admin's own sign-in proves the callback | D190; today `gh auth` on the hub (`hub/gh_auth`) |
| Invite people | Optional | A name, admin or not | The invite link | none | Name | The link opens | teams step 1, in flight |
| Google | Optional | A Cloud project, the three APIs, the sign-in screen published In production, a Desktop app OAuth client; optionally Gmail in real time (a Pub/Sub topic, a pull subscription, and a service account to read it) | Project and app name, the Gmail, Calendar and Drive scopes; on an HTTPS hub, also a web redirect `<hub>/oauth/google/callback` | Cloud Console: new project, enable APIs, Auth Platform › Branding, › Clients | Client ID, client secret (sealed to the hub); optionally the Gmail subscription and the reader's JSON key (sealed to one machine) | Exchange a dummy code: `invalid_grant` means Google knows the client; with a key, pull once from the subscription; then each person connects from their Navi | D189; Navi integrations, in flight (#635) |
| Notion | Optional | An internal integration | Integration name | Notion › Integrations | Secret (sealed) | `mcp_server_test` (search) | Navi integrations, in flight |
| 1Password | Optional | A service account for one vault | Account name | 1Password › Service accounts | Token (sealed) | List the vault's item titles | per project today (`OP_SERVICE_ACCOUNT_TOKEN`) |

Custom MCP servers stay in Settings › MCP servers. They aren't hub setup, and each one is different.

## 3. The step model

### 3.1 A step is checks plus a guide

The doctor already has the right half: each check is a status, a plain message and one fix (`DoctorCheck`). A step
adds the guide around a few checks:

```rust
pub struct SetupStep {
    pub id: String,                // "github"
    pub group: SetupGroup,         // Hub | Accounts | People | Integrations
    pub title: String,
    pub why: String,               // one line
    pub need: SetupNeed,           // Required | Before { what: "the first PR" } | Optional
    pub status: SetupStatus,       // Done | Todo | Look | Skipped
    pub said: Option<String>,      // the deciding check's message
    pub way: Option<String>,       // the way in use, when a step has several: "the hub's API key"
    pub fix: Option<DoctorFix>,    // as today, for what a command fixes
    pub parts: Vec<SetupPart>,     // numbered: { title, optional, note?, links, values: [PasteValue] }
    pub fields: Vec<SetupField>,   // { name, label, secret, optional, multiline, placeholder, sink, note? }
    pub fields_note: Option<String>, // what happens after the paste
    pub test: Option<String>,      // what Test does, in a few words
    pub ways: Vec<SetupWay>,       // { label?, checks: ["hub/claude_key"] }; one is enough
}
// PasteValue: { label, value, note?, plain? (words to follow), filled? (fleetd fills it in; shown, never copied) }
```

- **Status comes from the checks**, never from wizard progress. Each **way** to complete a step has its checks, and
  a way's status is the worst of them: no check yet, or the worst `unknown`, is Todo; the worst `fail` or `warn` is
  Look; all `ok` is Done. The **step takes its best way**: one way Done is enough, else one that wants a look, else
  Todo.
  - Most steps have one way.
  - **Claude has two:**
    - the hub's API configuration (`hub/claude_key`): the key and optional endpoint, with which machines need no
      login of their own;
    - the hub owner's own subscription (`hub/claude_owner`): a long-lived token from `claude setup-token`, pasted
      in the app and sealed to the hub's machines. One tiny `claude -p` call made with that token proves it works.
      With neither set up, machines run on their own login (`*/claude_login`), as before step 8.

    With a key set and tested, logged-out machines don't hold the step back. Without a key, it is Done once the
    owner's subscription is connected (with neither, once every machine is logged in; a machine that isn't makes it
    Look with that machine's message). The step shows which way is in use ("Done with the hub's API key"). Projects'
    leads and work nobody started run on the step's way: the key if there is one, else the owner's subscription.

    The hub step only makes sure something can run. **Each person chooses their own way** in their own settings
    (D200): their own subscription, connected the same way, or the hub's API configuration, switched at any time.
    An order's writers, readers and reviewers use its starter's choice, and a Navi, its lead included, its owner's.
    The step has a switch, "Members may use the hub's API key", on by default; off, each member connects a
    subscription. It never affects leads or work nobody started. Someone with neither is asked to connect before
    their first order, never handed someone else's subscription.
- The only state the hub stores is **Skipped**, per step, for the admin. So the flow resumes anywhere: in init, in
  the app, on another device or a week later.
- The steps are defined in one place in the hub (`hub/setup/steps.rs`): each step's static text, its values computed
  from the hub's URL, and its ways. The prototype's `screens/setup/steps.ts` is this catalog in TypeScript, in
  the same shape. It moves into the hub with the build.
- Setup steps are **doctor checks too**. `fleetd doctor` prints the steps first, then the checks no step owns (disk,
  stale sessions, fork behind).

### 3.2 Tools

All admin-only (admin on every machine today; the hub admin role after teams step 1):

- `setup_list {}` returns the steps.
- `setup_save {step, values}`: values as in `mcp_server_set` (plain, sealed, keep). A save re-runs the step's checks
  and returns the step.
- `setup_test {step}` re-runs only that step's checks, now, and returns the step with what they said.
- `setup_skip {step, skipped}`.
- `setup.changed` event when any step's status changes, so every open screen updates.

### 3.3 Required, before and optional, and never blocking

- **Required:** agents can't run without it: the address, a machine, Claude. Until these are done, the admin's app
  opens on setup.
- **Before X:** needed only before a feature's first use. Until then nothing asks. At first use, the feature asks:
  - The person sees "Connect your GitHub to open this PR" (D187).
  - A person with no Claude way of their own (no subscription, and the hub's API option off for members) sees
    "Connect your Claude to start this order" (D200).
  - If the hub has no GitHub App, a non-admin sees "Ask an admin to set up GitHub for this hub". The admin gets one
    attention item that opens Administration › Setup › GitHub App.
  - The same for Google: a person's Navi offers "Connect Google" only once the hub has a client.
- **Optional:** shown once on the welcome and listed in Administration › Setup. Never a badge.
- **Skip** is offered on every step that isn't required. A skipped step reads "Later" and keeps its place in the list.

### 3.4 Secrets

Secret fields use the existing sealed flow (`app/desktop/src/main/secret.ts`): the value is sealed with
`crypto_box_seal` on the admin's device, the hub relays ciphertext and keeps a fingerprint, and the screen says
"Sealed on this device; the hub keeps only its fingerprint". Each field names its **sink**:

- **Machines** (the Claude API key, people's Claude subscription tokens, the Notion and 1Password tokens) are sealed
  to every machine's box key, like a global MCP server's secret today (`McpValueSet::Secret`), and to the hub's own
  key.
  - **A machine added later** gets them when an admin approves it once: "Give buildbox the hub's saved secrets
    (Claude key, Notion, 1Password)?" Then the hub opens its copies and re-seals them to the new machine's key.
  - Nothing is copied to a machine without that approval. Until then, the step reads "sealed on 2 of 3 machines".
- **One machine** is for a credential exactly one machine uses. The Gmail reader's JSON key is sealed to the machine
  that reads the subscription (by default the hub's own, devbox), and to no other.
- **Hub** is new. It holds what the hub process uses itself:
  - the GitHub App's private key, client secret and webhook secret, which GitHub sends straight to the hub when the
    App is created (the manifest conversion), so no person ever sees them;
  - the Google client secret;
  - each person's GitHub and Google tokens, which the hub refreshes.

  The hub gets a box key of its own in its home. The admin's app seals the Google client secret (and each machine
  secret's hub copy) to it, and the hub opens these in its own process only.

In the terminal, `fleetd init` reads a secret with hidden input and seals it the same way before it leaves the CLI.

### 3.5 Values computed for this hub

Values come from the hub's URL as devices reach it (`--url`, else the listen address), so a callback is right the
first time: `http://devbox.your-tailnet.ts.net:4790/oauth/github/callback`. Names default to `fleetd on <host>`, so an
admin with several hubs can tell their apps apart at each provider.

A plain-HTTP tailnet hub is enough for every step. HTTPS (Tailscale Serve) is optional and adds two things:
- GitHub's webhooks, in the App's manifest;
- a web redirect for Google, besides the Desktop app client.

### 3.6 The GitHub App (D190)

One GitHub App per hub. It does the hub's own work, and it signs each person in. There is no separate OAuth app and
no `gh auth` on the hub.

1. **Create.** "Create on my account" or "Create in an organization" opens `<hub>/setup/github/new`. That page posts
   GitHub's app manifest to `github.com/settings/apps/new` (or `/organizations/<org>/settings/apps/new`) with a
   one-time `state`. The manifest fills in:
   - the name (`fleetd on devbox`; App names are global, so the admin may edit it on GitHub's form);
   - the homepage, and `callback_urls: [<hub>/oauth/github/callback]`;
   - `redirect_url: <hub>/setup/github/created` and `setup_url: <hub>/setup/github/installed`;
   - `public: false`;
   - the permissions: contents, pull requests and workflows write; checks, actions and statuses read;
   - a webhook at `<hub>/webhooks/github` only when the hub's address is HTTPS; otherwise webhooks are off.

   The admin checks the name and presses Create. GitHub redirects to the hub with a code. The hub converts it
   (`POST /app-manifests/{code}/conversions`, within the hour) into the App's id, slug, client ID, client secret,
   webhook secret and private key, straight into the hub sink. Nobody copies a key.
2. **Install** on the repositories fleetd works on (`github.com/apps/<slug>/installations/new`). The slug is the
   one the conversion returns, since the admin may have renamed the App on GitHub's form. The hub fills the link
   in from it, never from the name it proposed. GitHub returns to `setup_url` with the installation.
3. **Connect your own GitHub.** The admin signs in through the App (`/oauth/github/start` → GitHub →
   `/oauth/github/callback`). The hub keeps the user-to-server token and refreshes it.
   - In the terminal, `fleetd init` opens the same link in a browser and waits for the hub to say it's done.

**Who acts as whom.**
- The App's installation token (minted by the hub from its private key, an hour at a time) does the hub's work: the
  train's merges, CI and check reads, webhooks, and commits nobody asked for, as `fleetd-on-devbox[bot]`.
- A person's own token opens their PRs, so each PR opens as the person who asked (D187).
- A person who hasn't connected is asked to, before their first PR, and never falls back to someone else's token.

**Webhooks.** The hub polls GitHub by default, as the train already does. Webhooks are optional, for hubs reachable
over HTTPS, and the manifest leaves them off unless the hub's address is HTTPS.

**Test** mints an installation token, lists the repositories it reaches (`GET /installation/repositories`), and
checks the admin's own token (`GET /user`). The status line says: "The App "fleetd on devbox" is installed on acme with
12 repositories, its token works, and you're connected as dev."

### 3.7 Google (D189)

Native: the hub talks to Google itself, and xaq isn't involved. The admin brings a Google OAuth client once. Each
person then connects their own Google account from their Navi.

- **The admin's parts:**
  1. A Cloud project.
  2. Gmail, Calendar and Drive turned on (one `flows/enableapi` link for all three).
  3. The sign-in screen (Google Auth Platform › Branding), with its audience and these scopes:
     - `gmail.modify`: read, label and draft; a send still asks the person first;
     - `calendar.events`;
     - `drive.readonly`;
     - plus `openid` and `email`, to name the account.

     The audience is Internal if everyone is in one Google Workspace (no warning, no review). Otherwise it is
     External, and the step tells the admin to press **Publish app**, so the status is **In production**. People
     then see Google's "unverified app" warning once and click past it. In Testing, their sign-ins would lapse after
     7 days.
  4. A **Desktop app** client, the default. It needs no redirect URI: the fleetd app catches Google's answer on its
     own computer (`http://127.0.0.1:<port>`), so a plain-HTTP tailnet hub works. On an HTTPS hub, a Web
     application client with `<hub>/oauth/google/callback` also works from a browser. The client ID and secret are
     pasted into the step, and the secret is sealed to the hub.

  5. **Gmail in real time** (optional, D195). Without it, Navis poll Gmail about every minute. With it, Gmail
     publishes a notice to a Pub/Sub topic on each new message, and one machine **pulls** from a subscription and
     passes the notices to the hub, so no public address is needed. It takes two optional parts, each with deep
     links.

     *Gmail in real time:*
     - turn on Pub/Sub (`flows/enableapi?apiid=pubsub.googleapis.com`);
     - create topic `fleetd-gmail`, without a default subscription;
     - on the topic, grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role
       (`roles/pubsub.publisher`), the account Gmail publishes as;
     - create subscription `fleetd-gmail-hub` on that topic, delivery type **Pull**.

     *A key to read it* (the credential T805 settled):
     - create service account `fleetd-gmail-reader`, with no project roles;
     - on subscription `fleetd-gmail-hub`, grant `fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com` the
       **Pub/Sub Subscriber** role (`roles/pubsub.subscriber`), and nothing else;
     - create a JSON key for it (Keys › Add key › JSON), paste it, and delete the downloaded file.

     The machine signs in as that account with the `https://www.googleapis.com/auth/pubsub` scope. Both parts are
     also one copyable Cloud Shell block, in project `fleetd-devbox`: the services, topic, publisher, subscription,
     account, subscriber binding and key commands, ending in `cat … && rm …`. That prints the key once, to paste.

     The client, the subscription (`projects/fleetd-devbox/subscriptions/fleetd-gmail-hub`) and the JSON key are
     saved on Administration › Google (#746, #749), which the step links to (`place: google`); the step itself has no
     fields of its own to save. The key is sealed there to the one machine that reads (§3.4), and the page shows only
     its machine and fingerprint, never the key.
- **Test** exchanges a dummy code at Google's token endpoint. `invalid_grant` means Google knows the client and its
  secret; `invalid_client` means it doesn't. With a key saved, the reading machine also pulls from the subscription
  once as the service account: an empty answer is fine, and a refused one names the missing Subscriber role or a
  wrong subscription name.
- **Each person** connects from their Navi:
  - The app opens Google's sign-in and catches the loopback redirect. The hub exchanges the code (`access_type=offline`)
    and keeps that person's refresh token in the hub sink.
  - When a token lapses or is revoked at Google, the Navi offers a one-click **Reconnect**.
  - With real time on, the hub asks Gmail to watch that person's inbox (`users.watch` against the topic). It renews
    the watch before Gmail's 7-day expiry, and reads what changed (`users.history.list`) on each notice. A missed
    or lapsed watch falls back to polling, so mail is never lost.
  - Navi's Google tools use only the token of the person whose Navi it is.
  - Disconnecting, or the person being removed, revokes the token.

## 4. Three renderings of the same steps

**`fleetd init`** keeps its local bootstrap: where to listen, the service, this machine as a worker, pairing the
app. These can't wait for a hub. Each one is printed as its step, with the same title. Once the hub answers, init
asks it for `setup_list` and walks what is left:

1. The required steps first, each with its why, values, link (with "open it? y/n" where there is a desktop), fields
   (hidden for secrets) and its Test.
2. Then one multi-select: "Set up any of these now?". Unpicked steps stay Todo, not Skipped. A later run asks again.
3. `fleetd init --step github` opens one step. A second run resumes where the first stopped.

The pairing code is minted after the hub answers, never before. Logins move after the hub, under Accounts.

**The app's first run.** After an admin pairs, the app opens the welcome while a required step is left: what setup
is, the three required steps with their why, the rest as one line each with when they're needed, and **Start setup**.
The step screen is a list of steps on the left, grouped and quiet, each with its need or status in words. The open
step is on the right, in numbered parts (open the provider, fill it in with these, paste what you get back),
separated by hairlines. Test sits below them; Skip for now and Continue sit at the foot. The end says what is ready
and what waits for later. If a required step is still left (the admin pressed Continue past it), the end says so
and leads back to it. A member's app never shows any of it: the build gates `#/setup` to admins, as Administration
is; the prototype's route isn't gated.

**Administration › Setup** is the same step screen, always there for admins, on the separate Administration page
(teams step 1). The sidebar's Administration entry shows a count only while a required step is left.

The look follows the app's rules (`ui/DESIGN.md`): hairlines between parts, no card per step, status said in words
(Done, Needs a look, Later), no dots or pulses. The bar is xaq's setup wizard: numbered parts, a value table with
copy buttons, live checks after the paste, "progress is saved".

## 5. What each in-flight writer exposes

- **Teams step 1 (T758, `docs/design/teams.md`)**
  - The Administration page and a slot in it for Setup.
  - `invite_create {name, role}` (its contract landed in #640), returning the code and link the People step shows
    once.
  - A `hub/people` check: Done once anyone else has joined.
  - The person's own account state (GitHub connected, Claude subscription connected), for "Connect your …" at
    first use.
- **GitHub App (D190)**
  - The hub's endpoints:
    - `/setup/github/new`, which posts the manifest;
    - `/setup/github/created`, which converts the code;
    - `/setup/github/installed`;
    - `/oauth/github/start` and `/oauth/github/callback`;
    - `/webhooks/github`.
  - The manifest's permissions as one constant the step shows.
  - The hub sink for the App's keys and people's tokens, with refresh.
  - A `hub/github_app` check: the App exists, it is installed, a token mints, and the asking admin is connected.
  - It takes over from `gh auth` on the hub, and `hub/gh_auth` goes.
- **Claude accounts (hub key, endpoint, subscriptions)**
  - A `hub/claude_key` check (the key's last Test, `claude_account_test`, made with one tiny `claude -p` call), as
    the step's first way. Built: none is to do, a failed Test fails, a machine without the key warns, untested waits
    for Test.
  - A `hub/claude_owner` check for the owner's subscription (its last Test, the same way), as its second way. Built,
    read the same way.
  - A per-machine `claude_account_override` check, once any account is set up: the machine's claude user settings
    set a credential or gateway in their `env` (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, …), which claude applies
    over the account fleetd gives a session. The node reads the names only, never the values, and never writes it.
  - Built in teams step 8: the sealing, the tools and the Test; the two checks read what they record.
  - Where the key and the subscription tokens are sealed (machines).
  - Each person's choice and whether their subscription is connected, for "Connect your Claude" before a first order
    (D200).
  - The agent profiles' model settings (#626) stay in Settings › Agents, not setup.
- **Google (D189) and the Navi integrations (T745, #635)**
  - The Desktop app client with the loopback redirect the app catches (T805); `/oauth/google/callback` only on HTTPS
    hubs; the scopes as one constant.
  - Reconnect in the Navi when a token lapses.
  - Gmail in real time (D195):
    - one machine pulling from the saved subscription as the service account in the sealed JSON key (scope
      `https://www.googleapis.com/auth/pubsub`), and passing the notices to the hub;
    - a one-machine sink for that key, chosen in the step (the hub's machine by default);
    - each person's `users.watch`, renewed before its 7-day expiry;
    - polling every minute when the step's real-time part isn't set up;
    - the `hub/google` check pulling once.
  - A `hub/google` check (the dummy code exchange), and each person's connection state for their Navi.
  - The client secret and people's refresh tokens in the hub sink.
  - Navi's Google tools on the hub's own Google client, replacing the xaq adapter (`google.rs`).
  - Notion: a `hub/notion` check from `mcp_server_test`; the fields as `McpValueSet` names; for BYO OAuth, a callback
    at `/oauth/notion/callback`.
- **1Password (exists, per project)**
  - A fleet-wide token as well as the project one.
  - A `hub/onepassword` check where the node lists the vault's item titles with the token.
- **The doctor (exists)**
  - `unknown` means "not set up" for the new checks.
  - `checks.rs` stays the one place a status is decided.

## 6. Decided

None are open. Each answer below is already in the sections above.

1. **GitHub** is one GitHub App per hub, created through the manifest flow (D190).
2. **Google** is native, with the admin's own client (D189):
   - a Desktop app client with a loopback redirect by default, so no HTTPS is needed;
   - published In production, so sign-ins don't lapse after 7 days; people click past Google's unverified-app
     warning once;
   - a one-click Reconnect when a token lapses anyway.
3. **A machine added later** gets the saved secrets once an admin approves it. The hub re-seals them to the machine's
   key; nothing is copied silently.
4. **GitHub webhooks** are off by default, and the hub polls, as the train does. They are on only for hubs whose address
   is HTTPS.
5. **Gmail in real time** is optional in the Google step (D195), and it takes two parts:
   - a Pub/Sub topic, with the Publisher role for Gmail's push account, and a pull subscription;
   - a service account with only the Subscriber role on that subscription. Its JSON key is sealed to the one machine
     that reads it (T805).

   Without it, Navis poll Gmail about every minute.

## 7. Build order, after approval

1. Built: `hub/setup` (the steps, `setup_list`, `setup_test`, `setup_skip`, skips) on today's checks, with
   `fleetd doctor` printing steps first. New hub checks read from the hub's own state, there only once their step is
   set up: `hub/people` (someone invited has paired a device), `hub/google` (the client saved, and on which machines)
   and `hub/notion` (a Navi has it).
2. Built: `fleetd init` lists the hub's steps after its bootstrap and offers the ones left; `--step <id>` opens one
   (its guide, Test, Later, and for People an invite).
3. Built: the app's first run (an admin's empty home is the welcome while a required step is left), the step screen
   (`#/setup`) and Administration › Setup on `setup_list`, `setup_test` and `setup_skip`, with the prototype's
   catalog gone. Each step's `place` opens where its result is saved; the sidebar's Administration entry counts the
   required steps left. The app's fixtures are the hub's own answers, written from the catalog
   (`hub/setup/fixtures.rs` → `app/desktop/fixtures/setup/steps.json`), so the app keeps no second catalog. Setup
   reads `setup_list` again when a setup view opens, when the doctor's checks change (`doctor.changed`) or people do,
   and after a save on a step's place (Claude, Google, a Navi's integrations), so a result saved elsewhere, or with
   `fleetd init`, shows at once. Today the GitHub step is "Log gh in on the hub", with no `place`: there is nothing
   to save in the app. When the GitHub App replaces it, its parts, check and `place` come from the hub, and the app
   needs only to learn the new place's page.
4. Each in-flight piece adds its step as it lands (§5).

What the build does differently from the sections above, for now:

- **Result fields live on the place's page, not in the step.** A step has no fields of its own (`fields` stays empty,
  and there is no `setup_save`): it names the page that saves its result (`place`), and its last part, "Save it in
  fleetd", opens it. The Claude key and endpoint are on Administration › Claude, a subscription token on Settings ›
  Claude, Google's client and the Pub/Sub key on Administration › Google, invites on Administration › Invites. Each
  of those pages seals its secrets on the device as before. The terminal never takes a secret: the CLI's key isn't a
  person's, and the sealed paths are the app's.
- **GitHub** is `gh auth login` on the hub (`hub/gh_auth`) until the GitHub App (D190) is built; its manifest flow,
  endpoints and `hub/github_app` replace this step's part and way then. Before the hub has a project of code, no PR
  can open, so gh logged out there reads "to do", not failing (`before_first_use`).
- **A step that wants a look** fails `fleetd init` and `fleetd doctor` only when its check fails; a warning (a
  degraded machine, a LAN address) stays a warning and leaves nothing required (`failing`).
- **Claude** reads `hub/claude_key` and `hub/claude_owner` (#756) as its first two ways, then every machine's own
  login. Its parts send the key to Administration › Claude and the owner's subscription token to Settings › Claude,
  where the app seals them.
- **Notion** is each person's own integration on their Navi (#643), so the hub has nothing to save: the step says
  how, and is done once any Navi has it.
- **1Password** stays a project secret for now, and isn't a step.
- No `setup.changed` event yet: a screen re-reads `setup_list` after its own calls and on `doctor.changed`.
