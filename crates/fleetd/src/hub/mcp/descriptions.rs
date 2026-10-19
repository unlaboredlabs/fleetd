/// Tool descriptions in tools/list, word for word as older hubs listed them.
pub const DESCRIPTIONS: &[(&str, &str)] = &[
    (
        "fleetd_status",
        "Every machine (online/offline), the 50 most recently active projects, the latest failed/waiting/usage-limited events and PRs the merge train sent back (needs_rebase, ci_failed), the slot board (cap, used, queued, per-project shares) and the events cursor. Start here.",
    ),
    (
        "projects_list",
        "Projects across machines, optionally filtered by machineId or a title/path query.",
    ),
    (
        "project_get",
        "One project's outcome in one call: its summary, up to 20 threads (newest activity first) with status, headline and latest message, its lead and open workstreams, task counts with the 20 newest tasks (task threads are not in the thread list), and the merge trains of its repos. Marked stale when the machine is offline.",
    ),
    (
        "project_discover",
        "Repos to add as projects: git checkouts on each machine (under ~/src, ~/code, ~/projects, ~/dev and similar, two levels down; already-added ones carry projectId), each machine's clone root, and `gh repo list` for the user and their orgs (ghOn says where gh ran: the hub, else a worker). best is the machine a clone goes to by default.",
    ),
    (
        "project_inspect",
        "A repo's default branch, CI (active workflows, required checks) and merge rules (protection, rulesets, squash allowed, required reviews), with leadNeeds: one line on what the lead and merge train will need. Give url (a GitHub repo, before cloning; also returns where the clone would go and whether that directory already holds it) or machineId and path (a checkout).",
    ),
    (
        "project_add",
        "Add a project. path: a git checkout on the machine, added at once with its inspect. url: a GitHub repo cloned onto the machine (machineId defaults to the best worker, dest to <cloneRoot>/<name>); answers with addId, then events project.clone_progress and project.added (or project.add_failed with a fix) carry data.addId. When the destination already holds the same repo, pass useExisting. The same directory again returns its project; title renames it.",
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
        "thread_launch",
        "Start a new thread in a project with an explicit model and effort. runtimeMode defaults to full-access. Refused with machine_offline when the machine is offline.",
    ),
    (
        "thread_send",
        "Send a message to a thread, waking it if idle. When the machine is offline the hub queues it (queued: true, queuedUntil; default 24 h) and delivers it in order when the machine is back: watch for write.delivered or write.expired.",
    ),
    (
        "thread_interrupt",
        "Interrupt a thread's running turn. Refused with machine_offline when the machine is offline.",
    ),
    (
        "subscription_set",
        "Push hub events to an http(s) URL as signed Standard Webhooks POSTs (body: the HubEvent JSON), in seq order, retried until a 2xx. Filter by types and machines (default all). Returns the signing secret once.",
    ),
    (
        "subscription_list",
        "This key's webhook subscriptions (all of them for an admin key) with their delivery cursor and failing state. Secrets are never returned.",
    ),
    (
        "subscription_delete",
        "Delete a webhook subscription; delivery stops at once.",
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
        "Start the project's lead: one thread that turns intents into briefs, asks only product/money/credential/irreversible questions, and never writes code. Returns the existing lead if there is one. A project's first order starts its lead by itself; call this to start it earlier or with another model. model and effort, when given, are saved for the project (default claude-opus-5-5, high).",
    ),
    (
        "lead_restart",
        "Start a fresh lead thread for the project from the current digest (sessionGeneration goes up); use it when a lead is stuck or its context is full. The old thread stays on the node. Takes model and effort like lead_start.",
    ),
    (
        "intake_submit",
        "Give one intent in plain words (e.g. \"fix: the README has a typo\"). Without machineId and projectId, a leading @<project> (title or folder name) picks the project, else a one-shot claude router does; when it cannot, you get an askId for the human to pick the project. Prefixes bug:/fix:, research: and finish: set the template. Creates a draft workstream and wakes the lead, starting it if the project has none; echoes where it went and why. leadWaiting, when present, says why no lead could take it yet and what to do. Idempotent per clientRequestId.",
    ),
    (
        "workstream_list",
        "Workstreams newest first, filtered by machineId, projectId and state (limit defaults to 50).",
    ),
    (
        "workstream_get",
        "One workstream with its frozen brief and headline (the lead's own words), its open asks, the decisions scoped to it, and its last 20 claims with each check's result. Only a claim whose checks all passed makes it done.",
    ),
    (
        "workstream_spawn",
        "Start one child workstream of the project's open finish-all workstream, for exactly one item with a value source: serves is issue:#<n> (or issue:<url>) for an open issue, defect:<one line> for a failing check or error you saw, or done:<n> for the finish-all's done-when check n. Use a serves value from inventory; never invent work. Refused when the project has no open finish-all workstream, when an open child already serves it, or past the policy's finishAll.maxChildren open children. template (bugfix, feature, research) defaults to bugfix for defect: and feature otherwise. The child starts as a draft and its lead writes the brief.",
    ),
    (
        "inventory",
        "A project's open work, ranked as plain text: failing done-when checks first, then open GitHub issues (oldest first), then open asks and TODO/FIXME counts, which never become children. Each item with a value source shows its serves value and the child already working on it, if any. spawnable counts the unserved ones. When the finish-all workstream has no open child and nothing left to start, it goes idle (idle: true) and this says so.",
    ),
    (
        "asks_list",
        "The questions waiting for the human, grouped in numbered batches (state defaults to open; batchId picks one batch). Item numbers are fixed per batch: answer them with inbox_reply.",
    ),
    (
        "inbox_reply",
        "Answer a batch tersely: \"1 go 2 nvm 3 b\", \"1-3 go\", \"recs fine\" (accept every recommendation), \"2: free text\", \"3 skip\" (skip for now: the lead keeps its recommendation, no decision), \"4 later\", \"pref: <standing preference>\", \"forget D12\". Binds to the latest open batch unless it starts with \"#B<n>\". Letters pick the options in the order listed. A decide answer can be taken back with inbox_undo for 10 s; then it becomes a Decision and wakes its lead. Other answers become a Decision at once. Unparseable text changes nothing and returns a hint. Approve asks take only \"<n> go\" (the node runs the stored command) or \"<n> no\"; secret, approve and do asks take answers from human keys only.",
    ),
    (
        "inbox_undo",
        "Take back a decide answer within 10 s of inbox_reply (its applied item's undoUntil): the ask is open again and its lead never hears of the answer. Refused once the window passed; record a new decision instead.",
    ),
    (
        "secret_submit",
        "Human keys only. Enter a secret ask's value sealed on the client (the desktop app) with libsodium's crypto_box_seal to the sink machine's boxPubKey (fleetd_status machines). The hub relays it to that node, which writes the sink (0600) and returns the sha256 fingerprint prefix; the ask closes with it. Refused with machine_offline when the node is down: nothing is queued.",
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
        "digest_get",
        "The human digest now, as plain text: what needs you (numbered asks), what is running and done, and what leads decided without you. Limited to this key's machines. The hub emits digest.ready at 09:00 and 18:00 in policy.tz as the cue to call this; the event itself carries no project content.",
    ),
    (
        "tasks_list",
        "Tasks (the agents leads start with spawn_agent), newest first, optionally for one projectRef and state (queued, running, idle, done, failed, cancelled). Queued tasks say why; ended ones carry their result.",
    ),
    (
        "task_get",
        "One task: its model and effort, areas, branch, thread, queued reason or result (status, last 2000 characters of its final message, branch, PR).",
    ),
    (
        "cap_set",
        "Admin: set the global cap on running turns (1-1000) and/or one project's share of it (0-1000). Applies at once; queued tasks start as soon as they fit. Returns the slot board.",
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
        "claims_list",
        "Claims (a lead's `claim_done`), newest first: each done-when check fleetd ran itself, with pass/fail/error, evidence and exit codes. Filter by workstreamId, projectRef or outcome.",
    ),
    (
        "incidents_list",
        "Incidents the hub detected (false_claim, polish_loop, misfiled_ask, out_of_area, stall, policy_bypass, re_ask, override, playbook_reverted), newest first, with evidence lines, plus per-class counts over the last windowDays (default 7). Filter by projectRef, workstreamId or class.",
    ),
    (
        "retro_proposals",
        "The retro's playbook change proposals, newest first, with their diff, the incidents each fixes, its metric and state (suggested, pending, asked, measuring, kept, reverted, applied, rejected, stale). apply says whether policy.retro.apply lets them apply; until then they are only suggested.",
    ),
    (
        "retro_run",
        "Admin on every machine: run the retro now. One claude -p turn reads the incidents of the last windowDays (default 14) and the current playbooks and proposes changes; the hub drops invalid ones and classifies each as wording or gate by the fields it touches. advise: true only suggests. At most 2 runs a day.",
    ),
    (
        "changes_list",
        "PRs on the merge train (Changes), newest first: state (queued, reviewing, ready, rebasing, ci, merging, merged, needs_rebase, ci_failed, refused, abandoned), tier, reviews bound to the patch id, queue position and why it is parked. Filter by projectRef, repo or state.",
    ),
    (
        "train_get",
        "One repo's merge train: frozen or not, the Change it is rebasing, checking or merging now, and the queue in order. Only the train merges.",
    ),
    (
        "train_freeze",
        "Hold (frozen true) or resume (frozen false) a repo's merge train by recording or retiring its policy.freeze.<owner>.<name> decision. The train finishes nothing new while frozen; it emits train.frozen or train.resumed on its next pass.",
    ),
    (
        "doctor_list",
        "The doctor: every setup check with status (ok, warn, fail, unknown), a plain message and its fix. Hub: reachable, gh logged in, claude login, HTTPS. Each machine: online/degraded/offline, claude in the supported version range, claude logged in, the runner's conformance, commit identity, at least 5 GB free, usage breaker. Results are from the last run (every 15 min); rerun: true runs them now.",
    ),
    (
        "attention_policy",
        "When to interrupt the human: events carry attention \"loud\" or \"urgent\" when only a person can unblock them. Returns the notification coalescing window (coalesceSec) and the quiet windows under way and next (absolute times from policy.quiet_hours in policy.tz), inside which only urgent events notify.",
    ),
    (
        "doctor_fix",
        "Run a check's automatic fix, then the check again. Manual fixes are refused with the exact command to run. Admin keys, or a person's device (a human key).",
    ),
    (
        "orders_board",
        "Open orders (workstreams) joined with their agents: each card has its phase (needs you, working, reviewing, merging, ...), active lanes (role, model, status, branch, PR), PRs with review counts, open asks and the lead's headline; plus the merge trains of their repos. Filter by projectRef; includeDoneSince adds orders done since then.",
    ),
    (
        "order_get",
        "One order as orders_board shows it, plus its project's lead, its finished agents with their receipts, its open asks and its claims.",
    ),
    (
        "order_note",
        "Add to an order for its lead, with optional references (files, orders, PRs) and attachments from attachment_put. It reaches the lead as a steer (steerId): at its next tool boundary, or, when urgent, now, stopping its current step. A person's device (a human key) only.",
    ),
    (
        "steer_send",
        "Steer an order's lead (target {workstreamId}) or one task (target {taskId}) mid-run. mode queue (default) lands at the agent's next tool boundary as its own turn; now stops its current step and delivers at once. Returns the steer S<n> with its receipt stage; steer.delivered and steer.acknowledged (the agent's reply names S<n>) or steer.unacknowledged follow as events. A person's device (a human key) only.",
    ),
    (
        "steer_withdraw",
        "Withdraw a steer that is still queued. Refused once it was delivered: the next steer says what changed. The sender's key only.",
    ),
    (
        "steers_list",
        "Steers with their receipts (queued, delivered and how, acknowledged with the reply's first words, unacknowledged, withdrawn, failed), newest first. Filter by workstreamId or taskId; afterN pages.",
    ),
    (
        "order_stop",
        "Stop an order: cancels its queued and running tasks, withdraws its asks, sets it stopped and tells its lead. Merged PRs stay. Idempotent. A person's device (a human key) only.",
    ),
    (
        "intake_preview",
        "Where intake_submit would send this text (an @project prefix, else the router), without creating anything. Cached for 10 minutes.",
    ),
    (
        "attachment_put",
        "Upload one file (png, jpeg, webp, gif, text or PDF; at most 5 MiB, base64) for a later intake_submit or order_note. Unused uploads are deleted after 24 h.",
    ),
    (
        "project_files",
        "A project's files (tracked and untracked, not ignored) best matching a fuzzy query, for @-mentions. limit defaults to 20, max 50.",
    ),
    (
        "prompts_list",
        "Every prompt and message fleetd sends a model (lead, tasks, reviewers, judges, wakes, router, retro, playbooks, custom instructions): id, kind, when it is sent, which text is in effect (default, global or project override) and whether a release changed the default of one you edited. projectRef: the texts in effect for that project.",
    ),
    (
        "prompt_get",
        "One prompt: its shipped default, the global and project overrides with their refs, the text in effect, its placeholders, its safety rules (and whether the text still says each), warnings, and, when fleetd changed the default you edited, the old default, the new one, yours and a 3-way merge.",
    ),
    (
        "prompt_set",
        "Save a prompt override, hub-wide (scope global) or for one project (scope project, with projectRef); id instructions holds the custom instructions appended to every lead and task. Warns (never refuses) when the text drops a placeholder or a safety rule; dryRun returns the warnings only. New sessions get it at once; running ones keep the text they started with. Admin keys, or a person's device.",
    ),
    (
        "prompt_reset",
        "Remove a prompt override at one scope; the next one down (project, global, shipped default) is in effect again. Admin keys, or a person's device.",
    ),
    (
        "session_prompt_get",
        "Exactly what one session fleetd started (a lead, task, reviewer or judge) was told: its first message byte for byte, its SHA, the ref and scope of every prompt it is pinned to, and the tools it never gets.",
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
        "time_insights",
        "Deterministic findings over a scope's time since a time (no model): repeated full test suites, failing repeats, slow commands, CI checks on the critical path, full slots, waits on your answers, approval prompts a rule would answer, usage parks, retries, review share, train line, rebase loops, slow first tokens and starts, offline waits, missing data, and serial waits behind free capacity (queue waits, shared-resource contention, idle leads with ready plan items, ready items left side by side), each with its fix. Each carries its numbers and span ids; compare gives both periods.",
    ),
    (
        "time_retention_set",
        "How many days the hub keeps time spans (1 to 365, default 30). Pruned hourly; daily roll-ups and critical paths stay 400 days. Admin.",
    ),
    (
        "thread_window",
        "The items and messages around one item of a thread (before and after default 10, max 25), oldest first, from the node's own log: opens a time span's transcript by its itemId.",
    ),
    (
        "github_webhook_set",
        "Turn opt-in GitHub webhooks on (url: a public URL GitHub can reach that forwards to this hub's /github; fleetd never creates one) or off (no url). Makes a secret and a repo hook on every train repo for check_suite, pull_request and push. Deliveries only make the train sync sooner; without them it reconciles every pass. Admin keys on every machine.",
    ),
];
