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
        "The hub's fleetd version, protocol and release channel, and busy: everything a restart would interrupt now (a lead's turn, running agents, a merge or rebase the hub is doing, an approved command still running, a clone; a change waiting on CI is not), one plain line each. machineId keeps only what runs on that machine (before restarting its node). Empty busy: a restart interrupts nothing.",
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
        "Stop the project's claude processes and forget it. Its files, branches and worktrees stay on the machine; project_add brings it back.",
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
        "Start the project's lead: one thread that turns intents into briefs, asks the human in chat only about product, money, credential and irreversible calls, and never writes code. Returns the existing lead if there is one; with fresh, starts a new lead thread from the current digest instead (sessionGeneration goes up), for a lead that is stuck or whose context is full, and the old thread stays on the node. A project's first order starts its lead by itself; call this to start it earlier. The lead always runs on the high profile (Opus 5.5, effort high).",
    ),
    (
        "project_set",
        "Turn a project's medium profile on or off (mediumAllowed, on by default). On: its lead may run mechanical tasks on medium (Opus 5.5, effort medium). Off: every new task runs high. The lead, reviewers and helper calls always run high.",
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
        "tasks_list",
        "Tasks (the agents leads start with spawn_agent), newest first, optionally for one projectRef and state (queued, running, idle, done, failed, cancelled). Queued tasks say why; ended ones carry their result.",
    ),
    (
        "task_get",
        "One task: its profile (high or medium), branch, thread, queued reason or result (status, last 2000 characters of its final message, branch, PR).",
    ),
    (
        "cap_set",
        "Set the fleet cap on running agents (1-1000, admin key) and/or one project's max agents (1 up to the fleet cap). Applies at once; queued agents start as soon as they fit. Returns the slot board.",
    ),
    (
        "usage_status",
        "Per machine: the fleetd Claude login kind (subscription, api_key, custom_base_url; from the node's runner, never credentials), the usage breaker (open/closed, until when, its plain message), parked lead and task counts, and the latest limit events.",
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
        "The doctor: every setup check with status (ok, warn, fail, unknown), a plain message and its fix. Hub: reachable, gh logged in, claude login, HTTPS. Each machine: online/degraded/offline, claude in the supported version range, claude logged in, the runner's conformance, commit identity, at least 5 GB free, usage breaker. Results are from the last run (every 15 min); rerun: true runs them now.",
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
        "attachment_put",
        "Upload one file (png, jpeg, webp, gif, text or PDF; at most 5 MiB, base64) for a later chat_send. Unused uploads are deleted after 24 h.",
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
        "Without projectRef: one row per project you can read, by title (rows): a state word (working, waiting_on_you, blocked with a one-line reason, idle), the two-tone progress (verified and in flight, no ETA), agents running now and the last merge, marked stale when its machine, GitHub or its merge train went quiet. With projectRef: that project's row and the series behind its bar, oldest first: each point's verified and in-flight figure, why it fell (a scope change, a failed review or CI, work that stopped, a reopened item) and when it held on paused work. Never an ETA.",
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
        "A project's PRs: open ones on its repos and those closed or merged since closedSince (default 7 days), with title, state, checks, review state, merge-queue state and the agent that wrote it. GitHub data is cached for a minute; githubError says when only fleetd's records could be read. Read-only.",
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
        "What is in flight on a repo's base branch (repo, any host, or projectRef): fleetd's agents, PRs on the merge train, and claims by people's sessions (expired ones last), with their files and keys. Read-only.",
    ),
    (
        "work_done",
        "End your claim: outcome landed when the work reached the base (landing: its commit), dropped when you stop or leave it to someone else.",
    ),
];
