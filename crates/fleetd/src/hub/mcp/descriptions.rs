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
        "Updates fleetd to the newest build of a channel (the hub's own unless one is given): the hub first, checked against the release's SHA256SUMS, then every connected node. It doesn't wait for work: a restart cuts off what runs, and that carries on by itself afterwards. A new build that doesn't come up healthy is put back. Answers at once with the run; follow it with hub_update_status. A person's key with Admin on every machine only.",
    ),
    (
        "hub_update_status",
        "The hub's update going now, or the last one: the build it updates to, and each part (the hub, then each machine's node) with its state (waiting, downloading, restarting, done, current, failed, rolled_back, skipped), where it failed, and one plain sentence.",
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
        "Add a project. path: a git checkout on the machine, added at once with its inspect. url: a GitHub repo cloned onto the machine (machineId defaults to the best worker, dest to <cloneRoot>/<name>); answers with addId, then events project.clone_progress and project.added (or project.add_failed with a fix) carry data.addId. When the destination already holds the same repo, pass useExisting. The same directory again returns its project; title renames it. dryRun adds nothing: it answers the inspect (default branch, CI with active workflows and required checks, merge rules with protection, rulesets, squash allowed and required reviews, and leadNeeds: one line on what the lead and merge train will need) and, for a url, clone: where it would go and whether that directory already holds the repo.",
    ),
    (
        "project_remove",
        "Stop the project's agent processes and forget it. Its files, branches and worktrees stay on the machine; project_add brings it back. removeWorktrees also force-removes the fleetd worktrees its agents worked in (uncommitted changes in them are lost), once its agents have stopped; its checkout and every branch stay as they are.",
    ),
    (
        "project_settings_get",
        "One project's settings: its title and checkout, keepWorktrees, its environment variables (a plain one's value, a secret's fingerprint only), its setup commands, its merge train's checks (train), and from its node, while online, where its worktrees live, the branch new ones start from and the worktrees there now, each marked when it has uncommitted changes.",
    ),
    (
        "project_settings_set",
        "Rename a project (title; its folder keeps its name), turn keepWorktrees on or off, replace its setup commands, or set which of its repo's checks the merge train waits for (train). keepWorktrees off (the default): a reader's worktree goes when its task finishes and a writer's once its PR merges; on: finished tasks' worktrees stay on the machine. setup: commands run in order with sh -c in each new worktree, with the project's variables, before its agent starts (install dependencies, generate code), each within timeoutSec; a failure fails the start unless runAnyway; a worktree set up before is not set up again while the commands and the inputs files are unchanged. No commands turns setup off. train: the train waits only for the checks the base branch requires plus fastChecks, never for any other; a check outside them that has already failed stops the merge unless it is in afterMerge. Each list is replaced whole; none empties it.",
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
        "Human keys only. Add or replace an MCP server, global (operate on every machine) or a project's (operate on its machine). env (stdio) or headers (http, sse) is the whole list: a plain value carries value; a secret carries sealed, its value sealed on the client with crypto_box_seal to each machine's boxPubKey (a project server's: its machine; a global one's: every machine its agents run on); keep keeps a saved secret as it is. The hub relays each box to its node and keeps the fingerprint, never the value; missingOn names machines that were offline, whose agents go without the server until it is saved again. fleetd is fleetd's own server's name and can't be taken. Agents started from then on get it; a running one at its next start.",
    ),
    (
        "mcp_server_remove",
        "Human keys only. Remove an MCP server; each online node holding its secrets forgets them. Agents started from then on go without it.",
    ),
    (
        "mcp_settings_set",
        "Human keys only, operate on every machine. userServers: whether agents also get the person's own MCP servers from their claude setup (~/.claude.json, a repo's .mcp.json). Off: claude runs with --strict-mcp-config, fleetd's servers only; fleetd's own tools are always there.",
    ),
    (
        "mcp_server_test",
        "Test connection: the node starts the server (stdio, in the project's checkout with its variables, or the home directory for a global one) or connects to it (http, sse) with its secrets resolved there, initializes it and lists its tools within 30 s. result has the server's name and tools, or error: what went wrong, a command's stderr tail with its secrets masked. A global server is tested on machineId, by default the first machine online.",
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
        "Start the project's lead: one thread that turns intents into briefs, asks the human in chat only about product, money, credential and irreversible calls, and never writes code. Returns the existing lead if there is one; with fresh, starts a new lead thread from the current digest instead (sessionGeneration goes up), for a lead that is stuck or whose context is full, and the old thread stays on the node. A project's first order starts its lead by itself; call this to start it earlier. The lead always runs on the high profile.",
    ),
    (
        "project_set",
        "Turn a project's medium profile on or off (mediumAllowed, on by default). On: its lead may run mechanical tasks on medium. Off: every new task runs high. The lead, reviewers and helper calls always run high. profiles_set picks the model and effort behind each profile.",
    ),
    (
        "profiles_get",
        "The model and effort behind each task profile (high, medium): the fleet's settings, a project's override with projectRef, what new agents of each profile run on (runs) and the runner's own (defaults: claude-opus-5-5 at high and at medium). A setting whose model claude refused has refused, saying where and when; agents run as if it were unset.",
    ),
    (
        "profiles_set",
        "Set the model and effort behind a task profile: fleet-wide (an admin key on every machine), or a project's override with projectRef. high or medium replaces that profile's setting at that scope: model (a name or alias claude takes, e.g. claude-sonnet-5-5 or sonnet), effort (low, medium, high or max), either left out to follow the fleet's, then the runner's own; {} unsets it. New agents follow it from their next start; running ones keep theirs. The lead, every review and claude's helper calls run high. If claude refuses the model, agents run on the profile's own model and the setting is flagged until it is set again.",
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
        "One task: its profile (high or medium), branch, thread, queued reason or result (status, last 2000 characters of its final message, branch, PR).",
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
        "Save a prompt override, hub-wide (scope global) or for one project (scope project, with projectRef); id instructions holds the custom instructions appended to every lead and task. Warns (never refuses) when the text drops a placeholder or a safety rule; dryRun returns the warnings only (with reset, the ref that would be in effect) and never writes. reset true (without text) removes the override at that scope, so the next one down (project, global, shipped default) is in effect again, or deletes an edit to a retired prompt; a call with neither text nor reset is refused. New sessions get it at once; running ones keep the text they started with. Admin keys, or a person's device.",
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
        "A project's automations (a stored prompt with a cron schedule in an IANA tz, a webhook, Run now), each with its next run, paused state and last run.",
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
];
