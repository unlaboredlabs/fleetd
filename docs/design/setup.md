# One setup for the hub admin

Status: proposed (W100), revised for D189 (Google, native) and D190 (one GitHub App per hub). This is the design,
with a prototype of the app's screens: `#/setup` in `app/desktop/src/renderer/screens/setup`, against
`fixtures/setup`. The build waits for approval and for teams step 1 and the Navi integrations to land.

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
| Where the hub listens | Required | Tailnet, this machine only, or LAN; HTTPS through Tailscale Serve | Each option's URL; `tailscale serve` command | Tailscale admin | none | Reach `/healthz` from this device | init, `hub/reachable`, `hub/https` |
| Machines | Required | The machines to add | `fleetd machine add <host>`, or a join command with a code | none | none | The checks: online, runner | init, `machine add`, `*/online` |
| Claude | Required | A hub API key and an optional endpoint, **or** nothing: each person connects their own subscription | Key name `fleetd on devbox` | Claude Console › API keys | API key (sealed), endpoint | `GET /v1/models` at the endpoint | per-machine `claude login` only; key and subscriptions are D186 |
| GitHub App | Before the first PR | Nothing to paste: confirm the App GitHub shows, pick the repositories to install it on, connect your own account | The manifest: name, homepage, callback `<hub>/oauth/github/callback`, repository permissions, webhook | "Create on my account" or "in an organization", then GitHub's install page | none: GitHub hands the App's keys to the hub | Mint an installation token and list the repositories it reaches; the admin's own sign-in proves the callback | D190; today `gh auth` on the hub (`hub/gh_auth`) |
| Invite people | Optional | A name, admin or not | The invite link | none | Name | The link opens | teams step 1, in flight |
| Google | Optional | A Cloud project, the three APIs, the sign-in screen, a Web OAuth client | Project and app name, the Gmail, Calendar and Drive scopes, redirect `<hub>/oauth/google/callback` (HTTPS only) | Cloud Console: new project, enable APIs, Auth Platform › Branding, › Clients | Client ID, client secret (sealed to the hub) | Exchange a dummy code: `invalid_grant` means Google knows the client; then each person connects from their Navi | D189; Navi integrations, in flight (#635) |
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
    pub said: Option<String>,      // the worst check's message
    pub fix: Option<DoctorFix>,    // as today, for what a command fixes
    pub link: Option<SetupLink>,   // { site, label, url }
    pub values: Vec<PasteValue>,   // { label, value, note?, plain? }, computed for this hub
    pub fields: Vec<SetupField>,   // { name, label, secret, optional, placeholder, sink }
    pub test: Option<String>,      // what Test does, in a few words
    pub checks: Vec<String>,       // "hub/github_app", "*/claude_login"
}
```

- **Status comes from the checks**, never from wizard progress. No check yet, or the worst one `unknown`, is Todo.
  The worst `fail` or `warn` is Look. All `ok` is Done.
- The only state the hub stores is **Skipped**, per step, for the admin. So the flow resumes anywhere: in init, in
  the app, on another device or a week later.
- The steps are defined in one place in the hub (`hub/setup/steps.rs`): each step's static text, its values computed
  from the hub's URL, and its check ids. The prototype's `screens/setup/steps.ts` is this catalog in TypeScript. It
  moves into the hub with the build.
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
  - If the hub has no GitHub App, a non-admin sees "Ask an admin to set up GitHub for this hub". The admin gets one
    attention item that opens Administration › Setup › GitHub App.
  - The same for Google: a person's Navi offers "Connect Google" only once the hub has a client.
- **Optional:** shown once on the welcome and listed in Administration › Setup. Never a badge.
- **Skip** is offered on every step that isn't required. A skipped step reads "Later" and keeps its place in the list.

### 3.4 Secrets

Secret fields use the existing sealed flow (`app/desktop/src/main/secret.ts`): the value is sealed with
`crypto_box_seal` on the admin's device, the hub relays ciphertext and keeps a fingerprint, and the screen says
"Sealed on this device; the hub keeps only its fingerprint". Each field names its **sink**:

- **Machines** (the Claude API key, the Notion and 1Password tokens) are sealed to every machine's box key, like a
  global MCP server's secret today (`McpValueSet::Secret`).
- **Hub** is new. It holds what the hub process uses itself:
  - the GitHub App's private key, client secret and webhook secret, which GitHub sends straight to the hub when the
    App is created (the manifest conversion), so no person ever sees them;
  - the Google client secret;
  - each person's GitHub and Google tokens, which the hub refreshes.

  The hub gets a box key of its own in its home. The admin's app seals the Google client secret to it, and the hub
  opens these in its own process only.

In the terminal, `fleetd init` reads a secret with hidden input and seals it the same way before it leaves the CLI.

### 3.5 Values computed for this hub

Values come from the hub's URL as devices reach it (`--url`, else the listen address), so a callback is right the
first time: `http://devbox.your-tailnet.ts.net:4790/oauth/github/callback`. Names default to `fleetd on <host>`, so an
admin with several hubs can tell their apps apart at each provider. Google takes only HTTPS
redirects, so the address step recommends the tailnet with HTTPS from Tailscale Serve. On a plain-HTTP hub the Google
step shows no redirect URI, only "give the hub an HTTPS address first (step 1)".

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
   - a webhook at `<hub>/webhooks/github`, active only when GitHub can reach the hub.

   The admin checks the name and presses Create. GitHub redirects to the hub with a code. The hub converts it
   (`POST /app-manifests/{code}/conversions`, within the hour) into the App's id, slug, client ID, client secret,
   webhook secret and private key, straight into the hub sink. Nobody copies a key.
2. **Install** on the repositories fleetd works on (`github.com/apps/<slug>/installations/new`). GitHub returns to
   `setup_url` with the installation.
3. **Connect your own GitHub.** The admin signs in through the App (`/oauth/github/start` → GitHub →
   `/oauth/github/callback`). The hub keeps the user-to-server token and refreshes it.
   - In the terminal, `fleetd init` opens the same link in a browser and waits for the hub to say it's done.

**Who acts as whom.**
- The App's installation token (minted by the hub from its private key, an hour at a time) does the hub's work: the
  train's merges, CI and check reads, webhooks, and commits nobody asked for, as `fleetd-on-devbox[bot]`.
- A person's own token opens their PRs, so each PR opens as the person who asked (D187).
- A person who hasn't connected is asked to, before their first PR, and never falls back to someone else's token.

**Webhooks.** A tailnet hub can't be reached by GitHub, so the hook stays off and the hub asks GitHub, as today. It
turns on once the hub has an address GitHub can reach (Tailscale Funnel, a public HTTPS name).

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
  4. A Web application client whose only redirect URI is `<hub>/oauth/google/callback`. The client ID and secret
     are pasted into the step, and the secret is sealed to the hub.
- **Test** exchanges a dummy code at Google's token endpoint. `invalid_grant` means Google knows the client and its
  secret; `invalid_client` means it doesn't.
- **Each person** connects from their Navi:
  - The hub runs the code flow with `access_type=offline` and keeps that person's refresh token in the hub sink.
  - Navi's Google tools use only the token of the person whose Navi it is.
  - Disconnecting, or the person being removed, revokes the token.
- **HTTPS.** Google accepts only HTTPS redirect URIs, which is why the address step recommends Tailscale Serve.

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
and what waits for later. A member's app never shows any of it.

**Administration › Setup** is the same step screen, always there for admins, on the separate Administration page
(teams step 1). The sidebar's Administration entry shows a count only while a required step is left.

The look follows the app's rules (`ui/DESIGN.md`): hairlines between parts, no card per step, status said in words
(Done, Needs a look, Later), no dots or pulses. The bar is xaq's setup wizard (wynn-dev/xaq): numbered parts, a value
table with copy buttons, live checks after the paste, "progress is saved".

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
  - A `hub/claude_key` check (`GET /v1/models` at the endpoint, saying which key by its last 4 characters).
  - Where the key is sealed (machines).
  - What "each person's subscription" checks per person.
  - The agent profiles' model settings (#626) stay in Settings › Agents, not setup.
- **Google (D189) and the Navi integrations (T745, #635)**
  - `/oauth/google/callback`, and the scopes as one constant.
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

## 6. Open questions

Settled since the first draft: GitHub is one GitHub App through the manifest flow (D190), and Google is native with
the admin's own client (D189). An HTTPS address is what the address step recommends, since Google needs it.

1. **Machines added after a secret was saved.** A machine secret is sealed to the machines the app knew of at the
   time. A new machine has no copy until an admin's app seals one for it. Either the admin's app re-seals on its own
   when it sees a new machine, or the hub keeps these in its own sink and re-seals to new nodes (the hub then sees
   plaintext). Recommendation: the app re-seals; the step shows "sealed on 2 of 3 machines" until it has.
2. **Google for people outside one Workspace.** An Internal client needs no review but takes only that Workspace's
   accounts. An External one in Testing takes up to 100 listed test users, but their sign-ins lapse after 7 days.
   Publishing it with `gmail.modify` shows "unverified app" until Google verifies it. Recommendation:
   - Internal when everyone is in one Workspace.
   - Otherwise External in Testing, with each person added as a test user. Their Navi asks them to reconnect when a
     sign-in lapses.
3. **GitHub webhooks on a tailnet hub.** GitHub can't reach the hub, so the hub keeps asking GitHub, as today.
   Recommendation: off by default. Offer Tailscale Funnel for the webhook alone later, if polling is too slow.

## 7. Build order, after approval

1. `hub/setup` (steps, tools, skips, the hub sink) on today's checks, with `fleetd doctor` printing steps.
2. The app's welcome, step screen and Administration › Setup on `setup_list`, replacing the prototype's catalog.
3. `fleetd init` walking the hub's steps after its bootstrap; `--step`.
4. Each in-flight piece adds its step as it lands (§5).
