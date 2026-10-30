/// Tool descriptions in tools/list, word for word as older hubs listed them.
pub const DESCRIPTIONS: &[(&str, &str)] = &[
    (
        "chat_send",
        "Write to a project's lead in its chat. A human key writes as the human; any other key as an agent, by its name: input for the lead, never the human's answer or approval. It goes in at once: a new turn when the lead is idle, joined to its turn when it works, held while it starts (leadWaiting says why and what to do). now (a human key only) stops a working lead's running step and delivers at once, as steer_send's now does. attachments from attachment_put. The lead's replies arrive as chat.message events. Idempotent per clientRequestId.",
    ),
    (
        "chat_history",
        "A page of a project's chat, oldest first: the newest limit messages, or before/after a seq. Past orders, steers and questions read in as history. state carries needsYou (the lead waits on your reply) and leadWorking.",
    ),
    (
        "project_stop",
        "Stop everything in a project: the lead's turn is interrupted, every open order stops, its agents are cancelled and what waits on you is withdrawn, one line in the chat says what stopped and what still runs, and the lead hears it. The lead and the chat stay. A person's device (a human key) only.",
    ),
    (
        "chat_stop",
        "The chat's Stop, the same stop as project_stop: the lead's turn and the project's agents stop, and one line in the chat says what stopped. stopped is false when nothing was running. Idempotent per clientRequestId. A person's device (a human key) only.",
    ),
    (
        "hub_info",
        "The hub's fleetd version, protocol and release channel, and busy: everything a restart would interrupt now (a lead's turn, running agents, a merge or rebase the hub is doing, an approved command still running, a clone; a change waiting on CI is not), one plain line each. machineId keeps only what runs on that machine (before restarting its node). Empty busy: a restart interrupts nothing. admin: whether this key may change the fleet and machine caps.",
    ),
    (
        "hub_update",
        "Updates fleetd to the newest build of a channel (the hub's own unless one is given): the hub first, checked against the release's SHA256SUMS, then every connected node. The hub restarts at once; each node first holds its agents' tool calls that haven't started and waits for those running to finish, at most 10 minutes (the hub's update settings), then restarts whatever runs (that carries on by itself afterwards). now: true skips the wait, also for a run going on. A new build that doesn't come up healthy is put back. Answers at once with the run; follow it with hub_update_status. startOver ends a run going on (once the hub has its result) and starts a new one. A person's key with Admin on every machine only.",
    ),
    (
        "hub_update_settings",
        "Changes how the hub updates; a field left out stays as it is. auto: updates install by themselves, at most once an hour (the channel's newest build an hour after the last update started, whatever came out in between), each node once its agents finish their step, as hub_update does; off by default. drainMinutes (0-240, default 10): how long a node waits for its agents. Answers as hub_update_status does, with settings and autoAt. A person's key with Admin on every machine only.",
    ),
    (
        "hub_update_status",
        "The hub's update going now, or the last one: the build it updates to, and each part (the hub, then each machine's node) with its state (waiting, downloading, restarting, done, current, failed, rolled_back, skipped), where it failed, and one plain sentence; leftOver when nothing in the hub drives an unfinished run any more.",
    ),
    (
        "attachment_get",
        "One file of a project's chat or orders, base64, at most 5 MiB: to show an image a message carries. Read on the project's machine.",
    ),
    (
        "fleetd_status",
        "Every machine (online/offline), the 50 most recently active projects, the latest failed/waiting/usage-limited events and PRs the merge train sent back (needs_rebase, ci_failed), the slot board (cap, used, queued, per-project shares), the events cursor, and when to interrupt the human (notify: events carry attention \"loud\" or \"urgent\" when only a person can unblock them; coalesceSec is the notification window, and inside the quiet windows under way and next, from policy.quiet_hours in policy.tz, only urgent events notify). Start here.",
    ),
    (
        "project_get",
        "Without projectId: the projects across machines (projects), optionally filtered by machineId or a title/path query. With machineId and projectId, one project's outcome in one call: its summary, up to 20 threads (newest activity first) with status, headline and latest message, its lead and open workstreams, task counts with the 20 newest tasks (task threads are not in the thread list), and the merge trains of its repos. Marked stale when the machine is offline.",
    ),
    (
        "project_discover",
        "Repos to add as projects: git checkouts on each machine (under ~/src, ~/code, ~/projects, ~/dev and similar, two levels down; already-added ones carry projectId), each machine's clone root, and `gh repo list` for the user and their orgs (ghOn says where gh ran: the hub, else a worker). best is the machine a clone goes to by default.",
    ),
    (
        "project_add",
        "Add a project. path: a directory on the machine, added at once with its inspect: a git checkout, or a plain folder with no git (its lead chats, remembers and uses screens there; agents that change code need a repo). url: a GitHub repo cloned onto the machine (machineId defaults to the best worker, dest to <cloneRoot>/<name>); answers with addId, then events project.clone_progress and project.added (or project.add_failed with a fix) carry data.addId. When the destination already holds the same repo, pass useExisting. create starts a new, empty project with no repo: the machine makes its folder (path, else <projectsRoot>/<name from title>, projectsRoot being ~/fleetd/projects as project_discover says), takes an empty folder that is already there, refuses one that holds anything, and runs git init in it only with gitInit; a repo can be added later with project_repo_add. The same directory again returns its project; title renames it. dryRun adds nothing: it answers the inspect (default branch, CI with active workflows and required checks, merge rules with protection, rulesets, squash allowed and required reviews, and leadNeeds: one line on what the lead and merge train will need) and, for a url, clone: where it would go and whether that directory already holds the repo.",
    ),
    (
        "project_remove",
        "Stop the project's agent processes and forget it, with the checkouts of its repos that no other project holds. Its files, branches and worktrees stay on the machine; project_add brings it back. removeWorktrees also force-removes the fleetd worktrees its agents worked in (uncommitted changes in them are lost), once its agents have stopped; its checkout and every branch stay as they are.",
    ),
    (
        "project_repo_add",
        "Add a repo to a project, which then holds it beside its own directory. path: a git checkout on the project's machine, added at once. url: a GitHub repo cloned onto that machine (dest defaults to <cloneRoot>/<name>); answers with addId, then events project.clone_progress and project.added (or project.add_failed with a fix) carry data.addId. When the destination already holds the same repo, pass useExisting. name defaults to the remote's or folder's last part. A directory that is already a project of its own is archived read-only (its chat and history stay, its lead no longer runs; refused while its agents run) and stops showing as a project while any project holds it. A repo may be in several projects. The project's environment variables, MCP servers and skills go to every one of its checkouts.",
    ),
    (
        "project_repo_list",
        "A project's repos, its own first: each with its name, the checkout holding its files (path on its machine), and the remote and base branch its work lands on. A plain folder has none.",
    ),
    (
        "project_repo_remove",
        "Remove a repo from a project by name: the repo's live tasks are cancelled, the project's other tasks go on. Nothing is deleted on disk: the checkout stays on its machine, and once no project holds it, it shows as a project of its own again (project_remove forgets it). A project's own repo can't be removed: project_remove removes the project.",
    ),
    (
        "navi_create",
        "Make a Navi: a personal assistant with its own chat, memory, nightly memory refresh, automations, screens, checklist and approvals. It is a project of kind assistant in a new plain folder under its machine's fleetd home (navi/<name>); machineId defaults to the best worker. Its lead starts with the first chat message, in the assistant role: it reads and writes only inside its own folder, searches the web unasked, fetches or opens a site unasked once a person allowed that site at its first visit (navi_sites), and asks a person in the chat before anything else (a command, a send). Make as many as you like; the key that made it is recorded as createdBy.",
    ),
    (
        "navi_list",
        "The Navis, oldest first, each a project summary with kind assistant, createdBy and, once archived, archivedAt. archived: true includes the archived ones.",
    ),
    (
        "navi_rename",
        "Rename a Navi. Its folder keeps the name it was made with.",
    ),
    (
        "navi_sites",
        "The sites a Navi fetches and opens in its browser without asking, each with when and by whom it was allowed. A Navi's first fetch or visit to a site asks the person in its chat; approving it allows the site from then on.",
    ),
    (
        "navi_site_revoke",
        "Take back a site a Navi may fetch and open without asking: its next fetch or visit there asks the person again. Answers the sites it still may.",
    ),
    (
        "navi_signins_forget",
        "Forget a Navi's sign-ins: its browser keeps the sites it signed into (cookies and site storage, in a browser profile of its own on its machine) between sessions; this ends its open browser session, if any, and deletes that profile, so its next visit to each site starts signed out. Deleting the Navi deletes it too.",
    ),
    (
        "navi_archive",
        "Archive a Navi: its lead stops and doesn't start again, and navi_list leaves it out; its chat, memory and folder stay. archived: false brings it back.",
    ),
    (
        "project_avatar_set",
        "Give a project or Navi the picture its chat shows in place of its letters: attachmentId is the picture as picked (png, jpeg or webp, from attachment_put), crop the square to keep in its pixels as it shows (absent: the largest one in its middle). The hub keeps only that square, at most 512 px a side, re-encoded as JPEG without the original's metadata (EXIF, location), and forgets the upload. No attachmentId removes the picture. Every open app sees it at once (project.settings). Anyone who may change the project's settings; a Navi's, its owner.",
    ),
    (
        "project_avatar_get",
        "A project's or Navi's picture, base64 JPEG, with its id: the one its summary names in avatar. NotFound when it has none (its letters show).",
    ),
    (
        "project_icon_set",
        "Give a project or Navi the built-in icon its chat shows: icon is a face (a glass being: mo, wee, peep, nap, cy, wink, joy, huh, wow) and the color of its round field. It takes the place of its picture, if it had one. One never picked is derived from its id; every summary's icon says which it wears. Every open app sees it at once (project.settings). Anyone who may change the project's settings; a Navi's, its owner.",
    ),
    (
        "project_settings_get",
        "One project's settings: its title and checkout, keepWorktrees, memoryRefresh, its environment variables (a plain one's value, a secret's fingerprint only), its setup commands, its merge train's checks (train), and from its node, while online, where its worktrees live, the branch new ones start from and the worktrees there now, each marked when it has uncommitted changes.",
    ),
    (
        "project_settings_set",
        "Rename a project (title; its folder keeps its name), turn keepWorktrees or memoryRefresh on or off, replace its setup commands, or set which of its repo's checks the merge train waits for (train). keepWorktrees off (the default): a reader's worktree goes when its task finishes and a writer's once its PR merges; on: finished tasks' worktrees stay on the machine. memoryRefresh on (the default): each night with chat or order activity, the lead tidies the project's memory in a session of its own and posts one line of its changes with Undo; off: it doesn't. setup: commands run in order with sh -c in each new worktree, with the project's variables, before its agent starts (install dependencies, generate code), each within timeoutSec; a failure fails the start unless runAnyway; a worktree set up before is not set up again while the commands and the inputs files are unchanged. No commands turns setup off. train: the train waits only for the checks the base branch requires plus fastChecks and the repo's own .fleetd/train.json lists, never for any other; a check outside them that has already failed stops the merge unless it is in afterMerge. Each list is replaced whole; none empties it.",
    ),
    (
        "project_env_set",
        "Human keys only. Add, replace (set) and remove environment variables of a project's agents. A plain variable carries its value; a secret carries sealed: its value sealed on the client (the desktop app) with libsodium's crypto_box_seal to the project machine's boxPubKey. The project's node keeps them and adds them to every claude it starts for the project from then on, and masks a secret printed by an agent as ***NAME*** before its output leaves the machine; the hub keeps a plain value and a secret's fingerprint, never a secret's value. ANTHROPIC_*, CLAUDE* and FLEETD_* names are refused. A value is up to 64 KiB, any number of lines, no NUL; a project's values together up to 512 KiB. All or nothing; refused with machine_offline when the node is down.",
    ),
    (
        "mcp_servers_get",
        "The MCP servers fleetd gives its agents: the global ones (every project), with project also that project's own (each replaces a global one of the same name there, even while off), and userServers: whether agents also get the person's own MCP servers from their claude setup (on by default). Each server: enabled, roles (lead, writers for write tasks, reviewers for review and read tasks), transport (stdio command and args, or an http or sse url) and its env or headers: a plain value, or for a secret only the machines whose node holds it (sealedOn), never its value.",
    ),
    (
        "mcp_server_set",
        "Human keys only. Add or replace an MCP server, global (admin on every machine: the hub's owners and admins) or a project's (operate on its machine). env (stdio) or headers (http, sse) is the whole list: a plain value carries value; a secret carries sealed, its value sealed on the client with crypto_box_seal to each machine's boxPubKey (a project server's: its machine; a global one's: every machine its agents run on); keep keeps a saved secret as it is. The hub relays each box to its node and keeps the fingerprint, never the value; missingOn names machines that were offline, whose agents go without the server until it is saved again. fleetd is fleetd's own server's name and can't be taken. Agents started from then on get it; a running one at its next start.",
    ),
    (
        "mcp_server_remove",
        "Human keys only. Remove an MCP server; each online node holding its secrets forgets them. Agents started from then on go without it.",
    ),
    (
        "mcp_settings_set",
        "Human keys only, admin on every machine. userServers: whether agents also get the person's own MCP servers from their claude setup (~/.claude.json, a repo's .mcp.json). Off: claude runs with --strict-mcp-config, fleetd's servers only; fleetd's own tools are always there.",
    ),
    (
        "mcp_server_test",
        "Test connection: the node starts the server (stdio, in the project's checkout with its variables, or the home directory for a global one) or connects to it (http, sse) with its secrets resolved there, initializes it and lists its tools within 30 s. result has the server's name and tools, or error: what went wrong, a command's stderr tail with its secrets masked. A global server is tested on machineId, by default the first machine online.",
    ),
    (
        "claude_accounts_get",
        "Which Claude account each person's work runs on (teams step 8). hubApi: the hub's API configuration (endpoint, the machines holding the key with each node's fingerprint, the last Test), never the key. settings.membersUseHubApi: members may run on it (on by default; owners and admins always may). leadsRunOn: what projects' leads and work nobody started (automations, train fixes) run on: the hub's API, else the hub owner's subscription, else each machine's own login (machine_login) when nothing is set up. me: the caller's own choice, subscription (machines and fingerprints, never the token) and runsOn, what the orders they start and their Navi run on, or refused with the fix. people: everyone's, for an owner's or admin's device.",
    ),
    (
        "github_app_get",
        "The hub's own GitHub App, once an admin created it (id, slug, name, owner, its page, where it is installed and its last Test), and permissions, what it asks for on each repository. Never a key or secret.",
    ),
    (
        "github_app_manifest",
        "Owners' and admins' devices only. The manifest for a new GitHub App named name, which sends the admin back to redirect (a loopback page) with a code: postTo is GitHub's page to post it to as the form field manifest, for the admin's account or organization. Webhooks are off; the hub polls.",
    ),
    (
        "github_app_create",
        "Owners' and admins' devices only. Trade code, from GitHub's redirect after the manifest was posted, for the App: GitHub hands its private key and secrets to the hub, which seals them to its own box key and never returns them. Replaces any App the hub had. Then install it on repositories (github.com/apps/<slug>/installations/new) and call github_app_test.",
    ),
    (
        "github_app_test",
        "Owners' and admins' devices only. Ask GitHub whether it takes the App's key, read where it is installed and mint a token for each installation; app.lastTest says it in a line. The hub's gh then works as the App on those repositories.",
    ),
    (
        "github_connect",
        "Human keys only. Connect the caller's own GitHub account through the hub's App: code from GitHub's sign-in (opened with the App's clientId at authorizeUrl, a PKCE challenge and a loopback redirectUri), codeVerifier and redirectUri as sent. The hub keeps the user-to-server token sealed and refreshes it; the PRs agents open for the caller's orders open as them. Never returns a token.",
    ),
    (
        "github_disconnect",
        "Human keys only. Disconnect the caller's own GitHub account: the hub revokes the grant at GitHub (revoked says whether GitHub confirmed) and forgets the tokens. Writers for their orders are then refused until they connect again.",
    ),
    (
        "github_app_remove",
        "Owners' and admins' devices only. Forget the hub's GitHub App and its keys; the hub's gh goes back to the machine's own login. settingsUrl is its settings on GitHub, where it is deleted.",
    ),
    (
        "claude_hub_api_set",
        "Owners' and admins' devices only. Set the hub's Claude API configuration: sealed, the API key sealed on the client with crypto_box_seal to each machine's boxPubKey (every machine agents run on), or empty to keep the saved key; endpoint, a custom ANTHROPIC_BASE_URL, absent for Anthropic's own. The hub relays each box to its node and keeps the fingerprint, never the key; missingOn names machines that don't hold it, where nothing runs on it until it is saved again while they are online. Projects' leads and work nobody started run on it, and so do people who choose it.",
    ),
    (
        "claude_hub_api_remove",
        "Owners' and admins' devices only. Remove the hub's Claude API configuration; each online node holding the key forgets it.",
    ),
    (
        "claude_settings_set",
        "Owners' and admins' devices only. membersUseHubApi: whether members may run their work on the hub's API configuration (on by default). Off, each member connects their own subscription; owners and admins, projects' leads and work nobody started are never affected.",
    ),
    (
        "claude_subscription_set",
        "A person's own device only. Connect the caller's Claude subscription: sealed, the long-lived token `claude setup-token` prints, sealed on the client with crypto_box_seal to each machine's boxPubKey. The hub relays each box to its node and keeps the fingerprint, never the token. The orders the caller starts and their Navi run on it (unless they chose the hub's API), and nobody else's work ever does. Replaces a subscription connected before; missingOn names machines that don't hold it.",
    ),
    (
        "claude_subscription_remove",
        "A person's own device only. Disconnect the caller's subscription; each online node holding the token forgets it.",
    ),
    (
        "claude_choice_set",
        "A person's own device only. choice: subscription (their own, always) or hub_api (the hub's API configuration, if they may use it); absent: their subscription once connected, else the hub's API. Agents started from then on run this way; a running one keeps its account.",
    ),
    (
        "onepassword_get",
        "A person's own device only. The caller's 1Password service account token as the hub keeps it: the machines holding it (by fingerprint, never the token) and its last Test; absent until they save one.",
    ),
    (
        "onepassword_set",
        "A person's own device only. Save the caller's 1Password service account token: sealed, the token sealed on the client with crypto_box_seal to each machine's boxPubKey. The hub relays each box to its node and keeps the fingerprint, never the token; no agent, setup command or MCP server gets it. fill_credential in the orders the caller starts and in their Navi uses it when the project or order has no OP_SERVICE_ACCOUNT_TOKEN of its own, which wins. Replaces a token saved before; missingOn names machines that don't hold it.",
    ),
    (
        "onepassword_remove",
        "A person's own device only. Remove the caller's 1Password token; each online node holding it forgets it.",
    ),
    (
        "onepassword_test",
        "A person's own device only. List the vaults the caller's 1Password token reads, with the 1Password SDK on a machine holding it (machineId, default the first online; its first Test there installs the SDK). test.vaults, else test.error in plain words with the token masked; recorded as the token's lastTest.",
    ),
    (
        "sidebar_order_get",
        "The caller's own order of the projects and Navis in their sidebar, by ref; empty until they move one, and for a key with no person. A project or Navi it doesn't name goes after the ones it does.",
    ),
    (
        "sidebar_order_set",
        "A person's own device only. order: the caller's projects and Navis in their new order, replacing the one before. Their other devices follow (sidebar.order, which only they see); nobody else's sidebar changes.",
    ),
    (
        "claude_account_test",
        "Try an account with one tiny claude -p call on a machine holding it (machineId, default the first online): account hub_api (owners' and admins' devices) or mine (the caller's subscription). test.ok, else test.error in claude's words with the secret masked; recorded as the account's lastTest.",
    ),
    (
        "thread_tail",
        "A thread's newest messages and actions, newest first (n defaults to 10, max 50; kinds filters to message or action), plus its summary.",
    ),
    (
        "actions_list",
        "A thread's commands, file changes and tool calls, newest first (limit defaults to 50); failedOnly keeps failures.",
    ),
    (
        "events_wait",
        "Wait for hub events after cursor instead of polling. Returns at once if any exist, otherwise long-polls up to timeoutSec (default and max 50). No cursor means from now. Filter by types and machineId.",
    ),
    (
        "events_list",
        "One project's events, newest first: the newest limit (default 50, max 100), or those before a seq, back through the log's 30 days; more says older ones remain. Filter by types; hubWide adds the hub's own events (a device paired). events_wait follows what comes next.",
    ),
    (
        "wake_set",
        "Have the hub send a message to a thread later: at an ISO time (no offset means wall-clock time in tz), every N seconds (>= 60), or on a 5-field cron in an IANA tz. once defaults to true. A run missed while the hub was down fires once, marked late, unless catchUp is skip. Offline machines get it queued. Emits wake.fired.",
    ),
    (
        "wake_list",
        "Wakes, oldest first, optionally filtered by machineId, threadId and state (active, done, cancelled).",
    ),
    (
        "wake_cancel",
        "Cancel a wake so it never fires again. Cancelling a finished wake is a no-op.",
    ),
    (
        "lead_start",
        "Start the project's lead: one thread that turns intents into briefs, asks the human in chat only about product, money, credential and irreversible calls, and never writes code. Returns the existing lead if there is one; with fresh, starts a new lead thread from the current digest instead (sessionGeneration goes up), for a lead that is stuck or whose context is full, and the old thread stays on the node. A project's first order starts its lead by itself; call this to start it earlier. The lead always runs on the hub's default profile.",
    ),
    (
        "project_set",
        "Set which task profiles a project's lead may run agents on (profiles, by name), besides the hub's default, which every project allows; [] leaves the default alone. Its lead is told each allowed profile's name and note, and spawn_agent refuses any other. Running tasks keep their profile.",
    ),
    (
        "profiles_list",
        "The hub's task profiles, the default first: each one's id, name, note (what it is for), model, effort, fast mode and, when claude refused its model, refused (its agents run on the runner's own until the model is set again). With projectRef, allowed: the ones the project allows. Also the models a profile may pick (models, from the Models API on the hub's API key, else fleetd's own list: modelsFrom), each with whether it has fast mode, and the efforts Claude Code takes.",
    ),
    (
        "profile_create",
        "Add a task profile (an owner's or admin's human key): a unique name (lowercase, as spawn_agent's profile takes it), a one-line note the lead picks by, a model profiles_list offers, an effort, fast (only on a model with fast mode), and default to make it the hub's default. Projects allow it on their own (project_set).",
    ),
    (
        "profile_update",
        "Change a task profile by id (an owner's or admin's human key): its name, note, model, effort, fast mode, or default: true to make it the default the lead, every review and helper calls run on. New agents follow it from their next start; running ones keep theirs. A model without fast mode turns fast off. Setting the model again clears a refusal. A rename moves the tasks not yet ended with it.",
    ),
    (
        "profile_delete",
        "Delete a task profile by id (an owner's or admin's human key); every project stops allowing it. Refused for the default, and while a task not yet ended runs on it.",
    ),
    (
        "workstream_list",
        "Workstreams newest first, filtered by machineId, projectId and state (limit defaults to 50).",
    ),
    (
        "secret_submit",
        "Human keys only. Enter the value of an open secret request (requestId, Q<n>) sealed on the client (the desktop app) with libsodium's crypto_box_seal to the sink machine's boxPubKey (fleetd_status machines). The hub relays it to that node, which writes the sink (0600) and returns the sha256 fingerprint prefix; the request is stored with it and its lead hears the fingerprint, never the value. Refused with machine_offline when the node is down: nothing is queued.",
    ),
    (
        "approval_answer",
        "Human keys with an operate grant only. Approve or deny an open approval request (requestId, Q<n>): a gated command the lead asked to run. approve runs the command exactly as stored on the project's node (its exit code and output tail reach the lead); deny never runs it, and message, when given, goes to the lead with the denial. Returns the request.",
    ),
    (
        "requests_list",
        "Secret and approval requests, newest first: each with its kind, text, state (open, stored, withdrawn, approved, denied, ran, failed) and, for a command, the exact argv and cwd. Filter by projectRef and state. A secret's value is never in it, only its fingerprint.",
    ),
    (
        "decisions_search",
        "Full-text search over active decisions (key, value, why), best match first; scope narrows to global, a project or a workstream.",
    ),
    (
        "decisions_record",
        "Record a decision (key = lowercase dotted slug) at global, project or workstream scope; it supersedes the active one with the same key and scope, so leads never ask it again. A project's lead is woken with it. Global decisions need an operate grant on all machines.",
    ),
    (
        "decisions_list",
        "Every project- and workstream-scoped decision in a project (projectRef), newest first, in every state: active, superseded by a newer one on its key and scope, or retired (revoked by a person, with who, when and why). orders names each workstream a decision belongs to by its title.",
    ),
    (
        "decisions_overturn",
        "A person's device (a human key) with operate only. Take back an active decision (decisionId, D<n>) with a short why: without value it is retired and its key goes unanswered again; with value a new decision on the same key and scope supersedes it, recorded as the human's. The project's lead reads the change with its next wake.",
    ),
    (
        "tasks_list",
        "Tasks (the agents leads start with spawn_agent), newest first, optionally for one projectRef and state (queued, running, idle, done, failed, cancelled). Queued tasks say why; ended ones carry their result.",
    ),
    (
        "task_get",
        "One task: its profile's name, branch, thread, queued reason or result (status, last 2000 characters of its final message, branch, PR).",
    ),
    (
        "cap_set",
        "Set the fleet cap on running agents (1-1000, admin key), one machine's max agents (1 up to the fleet cap in place of what it is measured to fit, or auto: true; admin key), and/or one project's max agents (1 up to the fleet cap, or followDefault: its machine's cap within the fleet cap). Applies at once; queued agents start as soon as they fit. Returns the slot board.",
    ),
    (
        "usage_status",
        "Per machine: the login kind of the node's runner (claude's: subscription, api_key, custom_base_url; never credentials), the usage breaker (open/closed, until when, its plain message), parked lead and task counts, and the latest limit events.",
    ),
    (
        "usage_resume",
        "Close a machine's usage breaker and send \"continue\" to every lead and task parked there (lead, then reviews, then writers); queued tasks start as slots allow. Use it after fixing your proxy or once the login has capacity.",
    ),
    (
        "changes_list",
        "PRs on the merge train (Changes), newest first: state (queued, reviewing, ready, rebasing, ci, merging, merged, needs_rebase, ci_failed, refused, abandoned), reviews bound to the patch id, queue position and why it is parked. Filter by projectRef, repo or state.",
    ),
    (
        "doctor_list",
        "The doctor: every setup check with status (ok, warn, fail, unknown), a plain message and its fix. Hub: reachable, gh logged in, the runner's login, HTTPS. Each machine: online/degraded/offline, the runner in its supported version range and logged in, the runner's conformance, commit identity, at least 5 GB free, usage breaker. Results are from the last run (every 15 min); rerun: true runs them now.",
    ),
    (
        "doctor_fix",
        "Run a check's automatic fix, then the check again. Manual fixes are refused with the exact command to run. Admin keys, or a person's device (a human key).",
    ),
    (
        "setup_list",
        "Admin on every machine. The hub admin's setup, the steps fleetd init and the app's Settings › Hub › Setup show: where the hub listens, machines, Claude (required), GitHub (before the first PR) and people (optional). Each step has its why, numbered parts with the values to paste computed for this hub and the provider's pages, the fields for what comes back and where they are saved (place), and its status read from the doctor's checks (ways: one way done is enough): done, todo, look (set up but failing; said and fix say why) or skipped. failing: with look, its check fails rather than warns. requiredLeft: required steps not set up, or failing; agents can't run until none is left.",
    ),
    (
        "setup_test",
        "Admin on every machine. Run one step's checks now and return the step: the hub's checks, and every machine's for machines and claude.",
    ),
    (
        "setup_skip",
        "Admin on every machine. Put a step that isn't required off for later (skipped: true), or back on the list. A skipped step keeps its place and reads skipped until it is set up.",
    ),
    (
        "orders_board",
        "Open orders (workstreams) joined with their agents: each card has its phase (needs you, working, reviewing, merging, ...), active lanes (role, model, status, branch, PR), PRs with review counts, open requests and the lead's headline; plus the merge trains of their repos. Filter by projectRef; includeDoneSince adds orders done since then.",
    ),
    (
        "order_get",
        "One order as orders_board shows it, plus its record (the brief and its done-when), its project's lead, its finished agents, its open requests, the decisions scoped to it, and its 20 newest steers with their receipts (queued, delivered and how, acknowledged with the reply's first words, unacknowledged, withdrawn, failed). Its lead closes it with why once it is done.",
    ),
    (
        "steer_send",
        "Steer an order's lead (target {workstreamId}) or one task (target {taskId}) mid-run. mode queue (default) lands at the agent's next tool boundary as its own turn; now stops its current step and delivers at once. Returns the steer S<n> with its receipt stage; steer.delivered and steer.acknowledged (the agent's next reply) or steer.unacknowledged follow as events. A person's device (a human key) only.",
    ),
    (
        "steer_withdraw",
        "Withdraw a steer that is still queued. Refused once it was delivered: the next steer says what changed. The sender's key only.",
    ),
    (
        "attachment_part",
        "One piece of a file too large for one call, in order: the first (no uploadId) starts an upload, each next passes the uploadId it returned and offset (the bytes sent so far). Finish with attachment_put, the last piece and the uploadId. An upload untouched for an hour is deleted.",
    ),
    (
        "attachment_put",
        "Upload one file (png, jpeg, webp, gif, text or PDF; at most 25 MiB, base64) for a later chat_send: the whole file, or with uploadId the last piece after attachment_part. Unused uploads are deleted after 24 h.",
    ),
    (
        "project_files",
        "A project's files (tracked and untracked, not ignored) best matching a fuzzy query, for @-mentions. limit defaults to 20, max 50.",
    ),
    (
        "prompt_get",
        "Without an id: every prompt and message fleetd sends a model (lead, tasks, reviewers, custom instructions): id, kind, when it is sent, which text is in effect (default, global or project override) and whether a release changed the default of one you edited, plus your edits to prompts a release retired (orphans). projectRef: the texts in effect for that project. With an id, that prompt: its shipped default, the global and project overrides with their refs, the text in effect, its placeholders, its safety rules (and whether the text still says each), warnings, and, when fleetd changed the default you edited, the old default, the new one, yours and a 3-way merge.",
    ),
    (
        "prompt_set",
        "Save a prompt override, hub-wide (scope global) or for one project (scope project, with projectRef); id instructions holds the custom instructions appended to every lead and task. Warns (never refuses) when the text drops a placeholder or a safety rule; dryRun returns the warnings only (with reset, the ref that would be in effect) and never writes. reset true (without text) removes the override at that scope, so the next one down (project, global, shipped default) is in effect again, or deletes an edit to a retired prompt; a call with neither text nor reset is refused. New sessions get it at once; running ones keep the text they started with. Global: admin on every machine (the hub's owners and admins). Project: admin on its machine, or a person's device that operates there.",
    ),
    (
        "session_prompt_get",
        "Exactly what one session fleetd started (a lead, task or reviewer) was told: its first message byte for byte, its SHA, the ref and scope of every prompt it is pinned to, and the tools it never gets.",
    ),
    (
        "time_spans",
        "Time spans of a scope (fleet, machine, project, lead, order, task or thread) since a time, oldest id first: each one interval of one lane (model message, tool call, wait, CI check, train stage) with its exclusive time, label, exit code and output size. Filter by kinds, or rule to list the spans an insight links to; page with afterId (limit defaults to 200, max 500). coverage says what is missing.",
    ),
    (
        "time_breakdown",
        "Where a scope's time went since a time: wall time, agent time (exclusive, adds up over parallel agents), totals per category and kind, slowest commands, repeated runs, CI checks, waits on a person and, for an order, its critical path. compare gives a second period; filters narrow by project, machine or role. Also the retention and stored size.",
    ),
    (
        "status_get",
        "Without projectRef: one row per project you can read, by title (rows): a state word (working, waiting_on_you, blocked with a one-line reason, idle), its work in groups (waiting_on_you, in_review, working, landing, idle, done: counts, and the newest items of each with their agent, PR and why), agents running now and the last merge, marked stale when its machine, GitHub or its merge train went quiet. With projectRef: that project's row. Never a percentage or an ETA.",
    ),
    (
        "time_insights",
        "Deterministic findings over a scope's time since a time (no model): repeated full test suites, commands rerun with nothing edited between, and the slowest commands. Each carries its numbers and span ids; compare gives both periods.",
    ),
    (
        "time_retention_set",
        "How many days the hub keeps time spans (1 to 365, default 30). Pruned hourly; daily roll-ups and critical paths stay 400 days. Admin.",
    ),
    (
        "memory_caps_set",
        "The caps every memory write is held to, in characters: user (user.md), index (each MEMORY.md), topic (each topic file), 1,000 to 100,000 each, and project (a project's files together), 1,000 to 400,000. Defaults 16,000, 16,000, 32,000 and 128,000. A write past a cap is refused; a file already over a lowered one stays as it is. memory_get returns them as caps. Admin on every machine.",
    ),
    (
        "metrics_get",
        "Factory metrics for one project's repos, or the fleet's with each repo counted once: pull requests merged per day, time from order to merged (median, p90), the person's minutes per merged PR, and the share of merged work through fleetd, by calendar day in tz. A landed change is a PR merged into the default branch (a train batch's members one each) or a direct push; each has a route: train, fleetd_by_hand, outside or direct. coverage says which repos were read, when, and what fleetd can't see.",
    ),
    (
        "metrics_retention_set",
        "How many days the hub keeps landed changes and the person's touches for the factory metrics (30 to 400, default 400). Pruned hourly. Admin.",
    ),
    (
        "thread_window",
        "The items and messages around one item of a thread (before and after default 10, max 25), oldest first, from the node's own log: opens a time span's transcript by its itemId.",
    ),
    (
        "agents_list",
        "Every agent of the projects you can read: each running, queued or idle task and each project's lead, with its project, role, title, status (and why when queued, parked or failed), model, start time, its PR and what it is doing now. endedSince adds agents that finished since then. Waiting on a person first, then working, then newest. Read-only.",
    ),
    (
        "agent_work",
        "A page of one agent's recent steps (messages, commands, edits, tool calls), oldest first within the page; before pages back. From the newest 200 messages and 200 steps the hub follows of the session. Secrets are replaced by [secret]. Read-only.",
    ),
    (
        "pr_list",
        "A page of a project's PRs (at most 60 rows; the first reads one GitHub page per list), open first, then most recently updated: all of them, or with closedSince the open ones and those closed or merged since; nextCursor, passed as cursor, reads the next page. Each with title, state, checks, review state, merge-queue state and the agent that wrote it. GitHub data is cached for a minute; githubError says when only fleetd's records could be read. Read-only.",
    ),
    (
        "pr_get",
        "One PR in detail: its description, checks, agent verdicts with their findings and people's reviews, merge-queue state and moves, the writing agent and links. Read-only.",
    ),
    (
        "pr_files",
        "A page of a PR's changed files (100 per page) with their additions, deletions and diff length. Read-only.",
    ),
    (
        "pr_diff",
        "A page of one changed file's diff as numbered lines (hunk, context, add, del; at most 400 per page). Secrets are replaced by [secret]. Read-only.",
    ),
    (
        "work_claim",
        "Call before you start a code change in a repo: one line on what it does (title), the repo's origin remote (repo, any host) and, when known, branch, paths and issue keys. It checks the work in flight on the repo's base (fleetd's agents, PRs on the merge train, other people's sessions) and claims it in one call. status claimed: go ahead, and call work_done when it lands or you drop it. taken: someone else holds the same issue, PR, branch or plan item; tell the user before going on (with a human key, anyway: true claims it regardless). possible_duplicate: likely the same as matches[0]; tell the user, and if it is different work call again with notDuplicateOf and notDuplicateWhy. yours: you are fleetd's own agent on its task's branch, which the task already holds; go on. The same branch again renews your claim (keys and paths it adds are checked like a new claim's). A claim lasts 12 h from your last work_claim on it.",
    ),
    (
        "work_list",
        "What is in flight on a repo's base branch (repo, any host, or projectRef): fleetd's agents, PRs on the merge train, and claims by people's sessions (expired ones last), with their files and keys; and recentLandings, what reached the base outside the merge train (a PR merged by hand, a direct push) in the last 24 h. Read-only.",
    ),
    (
        "work_done",
        "End your claim: outcome landed when the work reached the base (landing: its commit), dropped when you stop or leave it to someone else.",
    ),
    (
        "automation_list",
        "A project's automations (a stored prompt with a cron schedule in an IANA tz, a webhook, Run now), each with its next run, paused state and last run. memoryRefresh: the nightly memory refresh, a built-in hub job listed with them: on (project_settings_set memoryRefresh), its hour and zone (policy.memory_refresh_at in policy.tz, an admin's), next run, and the last run with what it changed (added, replaced, removed) or why it was skipped.",
    ),
    (
        "memory_refresh_run",
        "Run the nightly memory refresh of a project now: the lead tidies its memory from the chat since the last refresh, as at night, and posts one line with Undo when it changed anything. Not started (why says so) while it is off for the project, already running, with nothing new to read, the lead mid-turn, or its node out of usage, offline or too old.",
    ),
    (
        "automation_create",
        "Make an automation for a project: name, prompt, optionally a schedule {cron, tz} and webhook: true. Each run opens an order for the project's lead, which starts the work on its own; reviews, the merge train and approvals still apply. webhookUrl, when asked for, is in this result only: POST to it to run with the body (at most 16 KiB) as context. Idempotent per clientRequestId.",
    ),
    (
        "automation_update",
        "Change an automation's name, prompt or schedule (removeSchedule: true takes it off); webhook true adds a URL (in this result only), false removes it. Fields left out stay.",
    ),
    (
        "automation_pause",
        "Pause or resume an automation. Paused, its schedule and webhook start nothing (a webhook call is recorded as skipped); Run now still runs it. Resumed, the schedule goes on from now.",
    ),
    (
        "automation_rotate",
        "A new webhook URL for an automation, in this result only; the old one stops working at once.",
    ),
    (
        "automation_delete",
        "Delete an automation and its run history. Orders its runs opened stay.",
    ),
    (
        "automation_run",
        "Run an automation now: it opens its order for the lead. Skipped, and recorded, while its last run's order is open.",
    ),
    (
        "automation_runs",
        "An automation's runs, newest first: trigger, state, the order each opened, and why a run was skipped or failed.",
    ),
    (
        "browser_sessions",
        "A project's browser sessions, newest first, or one by sessionId: the agent and task that opened each, its purpose, state (live, uploading, recorded, lost, expired), who has control, and the recording's files (actions, dom, video) once recorded. Also the hub's retention. Read-only.",
    ),
    (
        "browser_recording_get",
        "One piece (at most 512 KiB) of a recorded browser session's file from offset: actions (one JSON line per tool call), dom (the page's HTML after each), or video (webm). Read on until done. Every secret the node knew was scrubbed before upload; the video can't be. Read-only.",
    ),
    (
        "browser_control",
        "Take a live browser session over from its agent (control human): its agent's commands then answer that a person has control, and your mouse and keys go to the page through the app's browser_input. control agent hands it back; the session is handing_back until the agent's next command, which sees the page as you left it. Answers once the session's machine confirms (up to 5 s); a session that has just ended there is refused, and nothing changes. A person's device with operate on the machine only.",
    ),
    (
        "screen_open",
        "Open a screen of your own for a project or Navi: kind browser (default), android, ios or linux_desktop, on machineId, a machine that can host that kind (machine_roles lists them). It opens with you in control, records as an agent's screen does, and ends with screen_end or after 30 minutes without your input. A Navi's browser runs on its own machine, on the profile it keeps, so sites you sign in to stay signed in for it; only its owner opens one. pr (repo and number, a PR of the project's) installs that PR's CI build in an ios or android screen before it is yours: the newest artifact of a CI run on its head named for ios (a zipped simulator .app) or android/apk (an .apk); a PR without one is refused at once. With a PR it answers at once with its slot taken: waiting stage starting, then installing, listed by browser_sessions under waits with the screen's threadId until it is yours (its row gone), or failed with why (screen_end with its waitId clears it); screen.wait events follow each move. A full machine refuses; with wait true the request takes its next free slot, ahead of agents' starts, for up to 30 minutes. A person's device with operate on the project's machine only.",
    ),
    (
        "screen_end",
        "End a screen you opened (sessionId): it closes on its machine and its recording goes to the hub. Or give up your wait for one (waitId). A person's device only.",
    ),
    (
        "browser_retention_set",
        "How long the hub keeps browser recordings: retentionDays (1 to 365, default 30) and maxGbPerProject (default 20; a project's oldest go first past it). Pruned hourly; an expired session keeps its row. Admin on every machine.",
    ),
    (
        "machine_roles",
        "Every machine's roles (agents, sessions or both), its session slots (live of max, and where the max comes from) and what it can host for browser and device sessions, each in plain words: Chrome, an Android emulator (SDK and KVM), an iOS simulator (Xcode on macOS), a desktop (docker or Xvfb). Read-only.",
    ),
    (
        "machine_roles_set",
        "Set what a machine is for: roles [agents, sessions] (one or both), and the most sessions it hosts at once (maxSessions 1 to 64, or autoSessions: true for what it fits). A session an agent starts runs on its own machine when it can host it, else on another that can, driven through the hub's relay. Turning agents off stops nothing: running agents finish, new ones wait. Admin on the machine.",
    ),
    (
        "navi_asks",
        "What a Navi asked other projects for with project_message, newest first: each ask's handle (N<n>), the project it went to, its words and when, and the orders that project's lead opened for it, each with its state and headline. Read on the Navi's machine. A hub that names the navi_asks feature in its ready frame has it.",
    ),
    (
        "machine_add_plan",
        "What machine_add would run to add a machine: host (an SSH host the hub reaches: a name in its ~/.ssh/config, a tailnet name or an address) or local: true (the hub's own machine), machineId defaulting to the host's first label. Reads the machine over SSH (read-only) and answers its OS and CPU, each step with its command, and notes (linger, an untested claude). joined: it is a machine already, and adding it again repairs it. Changes nothing. A person's device with Admin on every machine.",
    ),
    (
        "machine_add",
        "Add a machine: fleetd machine add, run by the hub. host or local: true as machine_add_plan. Answers at once with its run (runId, steps planned so far); the hub reads the machine, copies its own fleetd there, writes the node's user service, enrolls it with a one-time token and waits until it is online. Each step it starts or ends sends a machine_add.step event; machine_add_status reads the run, each step with its output, and a failure with its fix. Safe to run again: finished steps are skipped. A person's device with Admin on every machine.",
    ),
    (
        "machine_add_status",
        "machine_add's runs, newest first, or one by runId: each step (planned, running, done or failed) with its command and output, the notes, and a failure's message and fix. The hub forgets runs when it restarts. A person's device with Admin on every machine.",
    ),
    (
        "machine_hosts",
        "Hosts the hub could add as machines: its own machine, those it set up before, the Hosts in its ~/.ssh/config and its tailnet's online Linux and macOS peers, each with the machine id it would get and joined when it is a machine already. A person's device with Admin on every machine.",
    ),
    (
        "machine_remove",
        "Remove a machine: fleetd machine remove, run by the hub. Stops and removes the node's service on a machine the hub set up (purge: also its files and claude.env), then revokes its node key and forgets it. A machine that joined by itself only has its key revoked: stop its node there by hand. A step that fails says what to run by hand; the key is revoked anyway. A person's device with Admin on every machine.",
    ),
    (
        "machine_join",
        "A one-time code (15 minutes) for machineId to join the hub by itself, as fleetd pair --worker prints it: the hub's address, the code, its commit identity, and line, the one command that installs fleetd on that machine and joins. For a machine the hub can't reach over SSH. rejoin: true for a machine that joined before, whose line enrolls it again and so repairs it. A person's device with Admin on every machine.",
    ),
    (
        "machine_claude_login",
        "Log claude in on machineId from the app: without code, its node starts claude auth login and this answers loginUrl, where the person signs in on their own device; then call again with code, the code that page shows, and it answers loggedIn once the login ended. Claude Code keeps its token on the machine: it never comes back. The node must be online and recent enough to list claude_login. A person's device with Admin on every machine.",
    ),
];
