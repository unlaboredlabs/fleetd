//! The hub schema: the same numbered migrations, in the same order and with the same SQL, as older hubs ran, so
//! an older hub's database opens unchanged. Index + 1 is the `user_version` after each one
//! runs. Append only, never edit a shipped entry.

pub(crate) const MIGRATIONS: &[&str] = &[
    r#"
  CREATE TABLE machines (machine_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE node_keys (machine_id TEXT PRIMARY KEY, pub_key TEXT NOT NULL);
  CREATE TABLE projects (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, search TEXT NOT NULL, last_activity_at TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE threads (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL, last_progress_at TEXT NOT NULL,
    last_sequence INTEGER, data TEXT NOT NULL, PRIMARY KEY (machine_id, thread_id)
  );
  CREATE INDEX threads_by_project ON threads (machine_id, project_id, last_progress_at DESC);
  CREATE TABLE shell_cursors (machine_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, created_ms INTEGER NOT NULL, type TEXT NOT NULL, machine_id TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX events_by_created ON events (created_ms);
  CREATE TABLE agent_keys (
    key_id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL,
    grants TEXT NOT NULL, created_ms INTEGER NOT NULL, last_used_ms INTEGER, revoked_ms INTEGER
  );
  CREATE TABLE enroll_tokens (
    hash TEXT PRIMARY KEY, machine_id TEXT NOT NULL, expires_ms INTEGER NOT NULL, used_ms INTEGER
  );
  "#,
    // Webhook subscriptions. `secret` is sealed with the key in <home>/webhook.key; `last_delivered_seq` is the
    // delivery cursor; `failing_reported` marks that this failing spell already emitted webhook.failing.
    r#"
  CREATE TABLE subscriptions (
    subscription_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, client_request_id TEXT NOT NULL, url TEXT NOT NULL,
    types TEXT NOT NULL, machines TEXT NOT NULL, secret TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL,
    last_delivered_seq INTEGER NOT NULL, failing_since_ms INTEGER, failing_reported INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_by, client_request_id)
  );
  "#,
    // T3's latest run per thread and the phase it was last seen in, so a run that ended while the hub was
    // down is reported on its return.
    r#"
  ALTER TABLE threads ADD COLUMN last_run_id TEXT;
  ALTER TABLE threads ADD COLUMN last_run_status TEXT;
  "#,
    // The ledger: decisions with their FTS5 index, asks, batches and incident markers.
    r#"
  CREATE TABLE decisions (
    n INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    project_key TEXT, state TEXT NOT NULL, source TEXT NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX decisions_active_by_key ON decisions (key, scope_kind, scope_id) WHERE state = 'active';
  CREATE INDEX decisions_by_project ON decisions (project_key, at_ms);
  CREATE VIRTUAL TABLE decisions_fts USING fts5 (key, value, why);
  CREATE TABLE asks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, workstream_id TEXT, key TEXT NOT NULL,
    state TEXT NOT NULL, filed_by TEXT NOT NULL, batch_n INTEGER, created_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX asks_open_by_key ON asks (project_key, key) WHERE state = 'open';
  CREATE INDEX asks_by_batch ON asks (batch_n);
  CREATE TABLE batches (
    n INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, created_ms INTEGER NOT NULL, last_add_ms INTEGER,
    published_ms INTEGER
  );
  CREATE TABLE batch_items (
    batch_n INTEGER NOT NULL, number INTEGER NOT NULL, ask_n INTEGER NOT NULL, PRIMARY KEY (batch_n, number)
  );
  CREATE TABLE ask_incidents (
    ask_n INTEGER NOT NULL, kind TEXT NOT NULL, project_key TEXT NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (ask_n, kind)
  );
  "#,
    // M3 leads and workstreams. AUTOINCREMENT so a workstream number is never reused.
    r#"
  CREATE TABLE leads (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, started_at TEXT NOT NULL,
    last_wake_at TEXT, session_generation INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE lead_settings (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, model TEXT, effort TEXT, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE workstreams (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    client_request_id TEXT, state TEXT NOT NULL, amends TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL,
    UNIQUE (machine_id, project_id, client_request_id)
  );
  CREATE INDEX workstreams_by_project ON workstreams (machine_id, project_id, n DESC);
  "#,
    // Hub-owned wakes and the offline write queue.
    r#"
  CREATE TABLE wakes (
    wake_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, client_request_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, state TEXT NOT NULL, next_run_ms INTEGER, fired INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL, UNIQUE (created_by, client_request_id)
  );
  CREATE INDEX wakes_due ON wakes (next_run_ms) WHERE state = 'active';
  CREATE TABLE queued_writes (
    write_id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL UNIQUE, message TEXT NOT NULL, wake_id TEXT, queued_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL
  );
  CREATE INDEX queued_writes_by_machine ON queued_writes (machine_id, write_id);
  "#,
    // M5 slots and leases. A slot claim is queued, held (reserved or its thread running) or idle (its thread
    // stopped; kept so a re-run is counted again). `order_n` is FIFO order within a priority.
    r#"
  CREATE TABLE slot_claims (
    holder TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, priority TEXT NOT NULL,
    thread_id TEXT, state TEXT NOT NULL, order_n INTEGER NOT NULL
  );
  CREATE INDEX slot_claims_by_thread ON slot_claims (machine_id, thread_id);
  CREATE TABLE slot_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE slot_shares (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, share INTEGER NOT NULL, PRIMARY KEY (machine_id, project_id)
  );
  CREATE TABLE leases (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, area TEXT NOT NULL, task_id TEXT NOT NULL, since TEXT NOT NULL,
    stale_flagged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (machine_id, project_id, area)
  );
  CREATE INDEX leases_by_task ON leases (task_id);
  "#,
    // M5 tasks. AUTOINCREMENT so a task number is never reused; `pending_message` is a `task message` waiting for a
    // slot or lease.
    r#"
  CREATE TABLE tasks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, ended_at TEXT, pending_message TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX tasks_by_project ON tasks (machine_id, project_id, n DESC);
  CREATE INDEX tasks_by_thread ON tasks (machine_id, thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX tasks_queued ON tasks (n) WHERE state = 'queued';
  "#,
    // Human keys (a person's device): their answers are recorded as the human's.
    r#"ALTER TABLE agent_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';"#,
    // M6 incidents, review verdicts (newest row per PR wins; `pr_key` is null for judge tasks) and estimate samples
    // (one per workstream that started running with a raw estimate; `done_ms` set when it is done).
    r#"
  CREATE TABLE incidents (
    n INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workstream_id TEXT, data TEXT NOT NULL
  );
  CREATE INDEX incidents_by_project ON incidents (machine_id, project_id, n DESC);
  CREATE TABLE review_verdicts (
    n INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, pr_key TEXT, sha TEXT NOT NULL,
    blocking INTEGER NOT NULL, at_ms INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX review_verdicts_by_pr ON review_verdicts (pr_key, n DESC) WHERE pr_key IS NOT NULL;
  CREATE TABLE estimates (
    workstream_id TEXT PRIMARY KEY, tier TEXT NOT NULL, raw_minutes REAL NOT NULL, ratio_at_start REAL NOT NULL,
    started_ms INTEGER NOT NULL, done_ms INTEGER, actual_minutes REAL
  );
  CREATE INDEX estimates_done_by_tier ON estimates (tier, done_ms DESC) WHERE done_ms IS NOT NULL;
  "#,
    // M6 claims. A row is numbered when the claim starts; `outcome` and `data` (the Claim) are set when its checks end,
    // so a claim superseded or cut off by a restart stays NULL and is never listed.
    r#"
  CREATE TABLE claims (
    n INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    outcome TEXT, data TEXT
  );
  CREATE INDEX claims_by_workstream ON claims (workstream_id, n DESC);
  "#,
    // M7 merge train. A Change row per enqueued PR (`train_order` is its place in its repo's train; a re-queue at the
    // front takes one below the lowest), one train per repo with the project whose machine runs its git, and the
    // merges outside the train already reported as policy_bypass incidents. Repos are stored lowercased.
    r#"
  CREATE TABLE changes (
    n INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, state TEXT NOT NULL,
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, train_order INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX changes_by_repo ON changes (repo, train_order);
  CREATE INDEX changes_by_pr ON changes (repo, pr_number, n DESC);
  CREATE TABLE trains (
    repo TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, frozen INTEGER NOT NULL DEFAULT 0,
    watch_since_ms INTEGER NOT NULL
  );
  CREATE TABLE train_bypasses (repo TEXT NOT NULL, pr_number INTEGER NOT NULL, PRIMARY KEY (repo, pr_number));
  "#,
    // M7 reviews: the review tasks spawned for each Change with the patch id their round was for, each verdict bound to
    // the patch id of the head it reviewed, the patch id of each head seen, and patches the polish-loop rule waived.
    r#"
  CREATE TABLE review_tasks (
    task_id TEXT PRIMARY KEY, change_id TEXT NOT NULL, role TEXT NOT NULL, patch_id TEXT NOT NULL
  );
  CREATE INDEX review_tasks_by_change ON review_tasks (change_id);
  CREATE TABLE review_bindings (
    task_id TEXT NOT NULL, pr_head_sha TEXT NOT NULL, patch_id TEXT NOT NULL, blocking INTEGER NOT NULL,
    non_blocking INTEGER NOT NULL, PRIMARY KEY (task_id, pr_head_sha)
  );
  CREATE TABLE review_patch_ids (
    change_id TEXT NOT NULL, head_sha TEXT NOT NULL, patch_id TEXT NOT NULL, PRIMARY KEY (change_id, head_sha)
  );
  CREATE TABLE review_waivers (
    change_id TEXT NOT NULL, patch_id TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (change_id, patch_id)
  );
  "#,
    // M9 playbooks: the text of every playbook version a workstream pinned, so its brief is checked against that version
    // after the file changes.
    r#"
  CREATE TABLE playbook_versions (ref TEXT PRIMARY KEY, text TEXT NOT NULL);
  "#,
    // M9 intake: each intent the router placed or asked about, so a retry returns the same answer and the routing
    // ask's answer finds its intent.
    r#"
  CREATE TABLE intake_routes (client_request_id TEXT PRIMARY KEY, ask_id TEXT UNIQUE, data TEXT NOT NULL);
  "#,
    // M8 devices: one-time pairing tokens from `fleetd hub device add`, and each human key's Web Push subscriptions.
    r#"
  CREATE TABLE pair_tokens (hash TEXT PRIMARY KEY, name TEXT NOT NULL, expires_ms INTEGER NOT NULL, used_ms INTEGER);
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, device_name TEXT NOT NULL, key_id TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  );
  "#,
    // M12 retro: each run (`turned` when it spent a claude turn, which the daily budget counts) and each proposal it
    // kept. A change that applied keeps the override file it replaced (`had_override` 0: none, the bundled one was in
    // use; NULL: not applied) so a revert can restore it.
    r#"
  CREATE TABLE retro_runs (
    n INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, trigger TEXT NOT NULL, threshold_class TEXT,
    turned INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL
  );
  CREATE TABLE retro_proposals (
    n INTEGER PRIMARY KEY AUTOINCREMENT, run_n INTEGER NOT NULL, playbook TEXT NOT NULL, state TEXT NOT NULL,
    ask_id TEXT, due_ms INTEGER, machines TEXT NOT NULL, had_override INTEGER, previous_override TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX retro_proposals_by_state ON retro_proposals (state, due_ms);
  "#,
    // The phone web app is gone, and with it device pairing links and Web Push. Its push.sent events go too: the
    // event type no longer exists, so they would not decode.
    r#"
  DROP TABLE pair_tokens;
  DROP TABLE push_subscriptions;
  DELETE FROM events WHERE type = 'push.sent';
  "#,
    // One-time pairing codes from `fleetd pair`, redeemed at POST /pair for a human key. `name` is `--name`, if given.
    r#"
  CREATE TABLE pair_codes (hash TEXT PRIMARY KEY, name TEXT, expires_ms INTEGER NOT NULL, used_ms INTEGER);
  "#,
];
