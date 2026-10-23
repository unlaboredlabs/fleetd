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
    // The latest run per thread and the phase it was last seen in, so a run that ended while the hub was
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
    // Files a person attached to an order or a note: the bytes live under <home>/attachments/<sha256>.
    // `workstream_id` is set once delivered; rows still without one after 24 h are deleted.
    r#"
  CREATE TABLE attachments (
    n INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    bytes INTEGER NOT NULL, by TEXT NOT NULL, created_ms INTEGER NOT NULL, workstream_id TEXT
  );
  "#,
    // Prompts: every text a prompt ever had here (shipped defaults, overrides, instructions) by `<id>@<sha>`, and
    // what each session was told at its start: the exact first message and the ref of every prompt it may receive.
    r#"
  CREATE TABLE prompt_versions (ref TEXT PRIMARY KEY, text TEXT NOT NULL);
  CREATE TABLE session_prompts (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT, started_at TEXT NOT NULL, refs TEXT NOT NULL,
    text_sha TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (machine_id, thread_id)
  );
  "#,
    // The agent time inspector: spans (one interval of one lane) from the nodes and the hub, their labels deduped,
    // per-day roll-ups, finished orders' critical paths, cursors for the node outboxes and the event-log projector,
    // and the retention setting. `time_orders`, `time_wakes` and `time_lead_runs` let the projector bound an order's
    // wall time and split a lead's turns across the orders its wake served: one row per run and order, `n` the
    // orders that run served ('' with n 0 for a run that served none).
    r#"
  CREATE TABLE time_labels (id INTEGER PRIMARY KEY, hash BLOB NOT NULL UNIQUE, family TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE time_spans (
    id INTEGER PRIMARY KEY, src TEXT NOT NULL, src_key TEXT NOT NULL,
    kind INTEGER NOT NULL, cat INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER, excl_ms INTEGER,
    machine_id TEXT, project_id TEXT, workstream_id TEXT, task_id TEXT, thread_id TEXT, run_id TEXT, role TEXT,
    lane TEXT NOT NULL, parent_id INTEGER, label_id INTEGER, exit_code INTEGER, out_bytes INTEGER,
    status INTEGER NOT NULL, extra TEXT,
    UNIQUE (src, src_key)
  );
  CREATE INDEX time_spans_by_order ON time_spans (workstream_id, start_ms) WHERE workstream_id IS NOT NULL;
  CREATE INDEX time_spans_by_thread ON time_spans (machine_id, thread_id, start_ms);
  CREATE INDEX time_spans_by_start ON time_spans (start_ms);
  CREATE INDEX time_spans_by_label ON time_spans (label_id, start_ms) WHERE label_id IS NOT NULL;
  CREATE INDEX time_spans_by_task ON time_spans (task_id, start_ms) WHERE task_id IS NOT NULL;
  CREATE INDEX time_spans_open ON time_spans (task_id, kind) WHERE end_ms IS NULL;
  CREATE TABLE time_rollups (
    day INTEGER NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL, cat INTEGER NOT NULL, kind INTEGER NOT NULL,
    ms INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, scope, scope_id, cat, kind)
  ) WITHOUT ROWID;
  CREATE TABLE time_paths (workstream_id TEXT PRIMARY KEY, computed_ms INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE time_cursors (source TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE time_settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE time_orders (
    workstream_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, start_ms INTEGER NOT NULL,
    end_ms INTEGER
  );
  CREATE TABLE time_wakes (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, at_ms INTEGER NOT NULL, workstreams TEXT NOT NULL,
    PRIMARY KEY (machine_id, thread_id, at_ms)
  );
  CREATE TABLE time_lead_runs (
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
    n INTEGER NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (machine_id, thread_id, run_id, workstream_id)
  );
  CREATE INDEX time_lead_runs_by_order ON time_lead_runs (workstream_id);
  CREATE INDEX time_spans_by_run ON time_spans (run_id) WHERE run_id IS NOT NULL;
  "#,
    // The status view: each project's plan (milestones, items, and the markers of every scope change), what each
    // person last looked at, each scope's first ETA, the latest generated headline per scope, and the repo hooks
    // made by opt-in GitHub webhooks. An order with no plan items counts as one placeholder item from when it starts
    // running until it gets a plan, stops, or a day after it is done. `events_by_type` counts "since you looked".
    r#"
  CREATE TABLE plan_milestones (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, title TEXT NOT NULL,
    position INTEGER NOT NULL, created_ms INTEGER NOT NULL, first_item_ms INTEGER, done_ms INTEGER);
  CREATE TABLE plan_items (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, milestone INTEGER NOT NULL,
    workstream_id TEXT, state TEXT NOT NULL, weight TEXT NOT NULL, size INTEGER NOT NULL, position INTEGER NOT NULL,
    started_ms INTEGER, done_ms INTEGER, data TEXT NOT NULL);
  CREATE INDEX plan_items_by_project ON plan_items (project_ref, state);
  CREATE INDEX plan_items_by_workstream ON plan_items (workstream_id) WHERE workstream_id IS NOT NULL;
  CREATE INDEX plan_items_done ON plan_items (project_ref, done_ms) WHERE done_ms IS NOT NULL;
  CREATE TABLE plan_changes (n INTEGER PRIMARY KEY AUTOINCREMENT, project_ref TEXT NOT NULL, milestone INTEGER NOT NULL,
    workstream_id TEXT, at_ms INTEGER NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, delta_items INTEGER NOT NULL,
    delta_size INTEGER NOT NULL, pct_before INTEGER, pct_after INTEGER, note TEXT NOT NULL);
  CREATE INDEX plan_changes_by_project ON plan_changes (project_ref, n DESC);
  CREATE TABLE status_seen (key_id TEXT NOT NULL, scope TEXT NOT NULL, seq INTEGER NOT NULL, at_ms INTEGER NOT NULL,
    PRIMARY KEY (key_id, scope)) WITHOUT ROWID;
  CREATE TABLE status_eta (scope TEXT PRIMARY KEY, original_ms INTEGER NOT NULL, set_ms INTEGER NOT NULL,
    basis TEXT NOT NULL);
  CREATE TABLE status_headlines (scope TEXT PRIMARY KEY, facts_hash BLOB NOT NULL, text TEXT NOT NULL, run TEXT NOT NULL,
    at_ms INTEGER NOT NULL);
  CREATE TABLE plan_placeholders (workstream_id TEXT PRIMARY KEY, project_ref TEXT NOT NULL, size INTEGER NOT NULL,
    title TEXT NOT NULL, state TEXT NOT NULL, entered_ms INTEGER NOT NULL, done_ms INTEGER, left_ms INTEGER);
  CREATE INDEX plan_placeholders_live ON plan_placeholders (state, done_ms) WHERE state != 'left';
  CREATE INDEX changes_by_task ON changes (CASE WHEN json_valid(data) THEN json_extract(data, '$.taskId') END);
  CREATE TABLE github_hooks (repo TEXT PRIMARY KEY, hook_id INTEGER NOT NULL, url TEXT NOT NULL);
  CREATE INDEX events_by_type ON events (type, seq);
  "#,
    // Steers: a person's (or a lead's) words to a running agent and their receipt. `n` is the S<n> id; `data` the
    // Steer; `held` marks a steer to a task that is not running, sent with the task's next run (`message`, the text
    // it added to the task's pending message), and `rides_with` the steer whose run carried it. A queued write
    // remembers its send mode and steer, so one sent while the machine was away goes out as it was given (null
    // mode = a plain send). A plan change made with `--steer` names its steer.
    r#"
  CREATE TABLE steers (n INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, task_id TEXT,
    machine_id TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, by TEXT NOT NULL, mode TEXT NOT NULL,
    stage TEXT NOT NULL, queued_ms INTEGER NOT NULL, delivered_ms INTEGER, acked_ms INTEGER,
    held INTEGER NOT NULL DEFAULT 0, rides_with INTEGER, message TEXT, data TEXT NOT NULL);
  CREATE INDEX steers_by_workstream ON steers (workstream_id, n);
  CREATE INDEX steers_by_run ON steers (run_id);
  ALTER TABLE queued_writes ADD COLUMN mode TEXT;
  ALTER TABLE queued_writes ADD COLUMN steer_id TEXT;
  ALTER TABLE plan_changes ADD COLUMN steer_id TEXT;
  "#,
    // A steer's request (`steer:<sender>:<clientRequestId>`), so a resent request finds its steer at any stage, also
    // after its run id changed when it was bound to a task's next run.
    r#"
  ALTER TABLE steers ADD COLUMN request TEXT;
  CREATE UNIQUE INDEX steers_by_request ON steers (request) WHERE request IS NOT NULL;
  "#,
    // The progress model: each viewed scope's estimate over time (the last 96 points; `drop` is the JSON reason a
    // point fell), each order's planning share once its plan exists (fixed from then on), and lookups of an order's
    // tasks and Changes for its stages.
    r#"
  CREATE TABLE status_series (scope TEXT NOT NULL, at_ms INTEGER NOT NULL, pct INTEGER NOT NULL,
    verified INTEGER NOT NULL, drop_reason TEXT, PRIMARY KEY (scope, at_ms)) WITHOUT ROWID;
  CREATE TABLE status_planning (workstream_id TEXT PRIMARY KEY, share REAL NOT NULL, ended_ms INTEGER NOT NULL);
  CREATE INDEX tasks_by_workstream ON tasks (workstream_id);
  CREATE INDEX changes_by_workstream ON changes (CASE WHEN json_valid(data) THEN json_extract(data, '$.workstreamId') END);
  "#,
    // The progress model's calibration: one row, the stage weights and durations measured nightly (see
    // `hub/status/calib.rs`).
    r#"
  CREATE TABLE progress_calibration (id INTEGER PRIMARY KEY CHECK (id = 1), computed_ms INTEGER NOT NULL,
    data TEXT NOT NULL);
  "#,
    // The lead chat (`hub/chat`): each project's messages in order (`seq` 1..n per project, `n` the m<n> id; `data`
    // the ChatMessage), deduped by a human's request and by the record a message was read from (`source`: a lead
    // message, or the history read from orders, steers and asks). `held`: a human message waiting for the project's
    // lead to start. `chat_projects` marks a project whose history was
    // read, and when. An attachment remembers the project it was given to, so the chat can show it.
    r#"
  CREATE TABLE chat_messages (n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL,
    project_id TEXT NOT NULL, seq INTEGER NOT NULL, created_ms INTEGER NOT NULL, request TEXT, source TEXT,
    held INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, UNIQUE (machine_id, project_id, seq));
  CREATE UNIQUE INDEX chat_by_request ON chat_messages (machine_id, project_id, request) WHERE request IS NOT NULL;
  CREATE UNIQUE INDEX chat_by_source ON chat_messages (machine_id, project_id, source) WHERE source IS NOT NULL;
  CREATE TABLE chat_projects (machine_id TEXT NOT NULL, project_id TEXT NOT NULL, history_ms INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)) WITHOUT ROWID;
  ALTER TABLE attachments ADD COLUMN project TEXT;
  "#,
    // The questions tool went: a lead asks in chat. What a chat can't carry safely stays a request (Q<n>): a secret, or
    // an approval of a command or a tool prompt. Open secret and approve asks carry on as open requests under the same
    // number; every ask is kept as it was in `legacy_asks`, which the chat's history renders; batches, their items and
    // ask incident markers go, and so do the ask events no reader decodes any more.
    r#"
  CREATE TABLE requests (n INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, created_ms INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX requests_by_project ON requests (project_key, n);
  CREATE INDEX requests_unsettled ON requests (state) WHERE state IN ('open', 'approved');
  INSERT INTO requests (n, project_key, kind, state, created_ms, data)
    SELECT n, project_key,
      CASE json_extract(data, '$.kind') WHEN 'secret' THEN 'secret' ELSE 'approval' END, 'open', created_ms,
      json_object(
        'requestId', 'Q' || n,
        'projectRef', json(json_extract(data, '$.projectRef')),
        'workstreamId', json_extract(data, '$.workstreamId'),
        'kind', CASE json_extract(data, '$.kind') WHEN 'secret' THEN 'secret' ELSE 'approval' END,
        'text', json_extract(data, '$.text'),
        'state', 'open',
        'secret', CASE json_extract(data, '$.kind') WHEN 'secret' THEN json_object(
          'key', json_extract(data, '$.key'), 'sink', json_extract(data, '$.sink'),
          'envName', json_extract(data, '$.envName')) END,
        'gated', json(json_extract(data, '$.gated')),
        'permission', json(json_extract(data, '$.permission')),
        'evidence', CASE WHEN state = 'open' THEN json_extract(data, '$.evidence')
          ELSE 'not run: the hub was updated before it ran; approve again to run it' END,
        'createdAt', json_extract(data, '$.createdAt'))
    FROM asks
    WHERE json_valid(data) AND json_extract(data, '$.projectRef') IS NOT NULL AND (
      (state = 'open' AND json_extract(data, '$.kind') IN ('secret', 'approve'))
      -- approved, but its command never ran (or its result never came back): back to the human, never run late
      OR (state = 'answered' AND json_extract(data, '$.kind') = 'approve' AND json_extract(data, '$.gated') IS NOT NULL
        AND json_extract(data, '$.answer.value') = 'go'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'exit *'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'killed after *'
        AND coalesce(json_extract(data, '$.evidence'), '') NOT GLOB 'not run on *'));
  ALTER TABLE asks RENAME TO legacy_asks;
  DROP INDEX IF EXISTS asks_open_by_key;
  DROP INDEX IF EXISTS asks_by_batch;
  DROP TABLE batch_items;
  DROP TABLE batches;
  DROP TABLE ask_incidents;
  DELETE FROM events WHERE type IN ('ask.created', 'ask.auto', 'ask.closed', 'ask.answered', 'ask.undone',
    'ask.delivered', 'batch.ready', 'ask.secret_saved', 'gated.ran');
  CREATE TABLE intake_routes_new (client_request_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  INSERT INTO intake_routes_new SELECT client_request_id, data FROM intake_routes;
  DROP TABLE intake_routes;
  ALTER TABLE intake_routes_new RENAME TO intake_routes;
  -- A gate change that was asked is pending again, settled by its playbook.* decision.
  UPDATE retro_proposals SET state = 'pending',
    data = CASE WHEN json_valid(data) THEN json_remove(json_set(data, '$.state', 'pending'), '$.askId') ELSE data END
    WHERE state = 'asked';
  UPDATE retro_proposals SET data = json_remove(data, '$.askId') WHERE json_valid(data);
  ALTER TABLE retro_proposals DROP COLUMN ask_id;
  -- The ask batching and info spans: nothing records them any more, and their kinds no longer exist.
  DELETE FROM time_spans WHERE kind IN (42, 43);
  "#,
    // Outbound webhooks went: external clients long-poll events_wait.
    r#"
  DROP TABLE subscriptions;
  DELETE FROM events WHERE type = 'webhook.failing';
  "#,
    // In-stage progress counts only while work is in flight. A figure stored under the old rule, which credited every
    // minute in a stage, can only fall with an observed cause, so it would stay held at the old height: every scope's
    // series restarts at its next render.
    r#"
  DELETE FROM status_series;
  "#,
    // A point marks a figure holding on paused work (`paused`, the plain words).
    r#"
  ALTER TABLE status_series ADD COLUMN paused TEXT;
  "#,
    // Two task profiles, both claude-opus-5-5: high and medium. The lead always runs high, so its saved model and
    // effort go; a project keeps whether its tasks may run medium. A stored task on opus-5-5 at medium is medium and
    // every other one high. A task's or a lead's spans carry its profile, so time and usage split by it.
    r#"
  DROP TABLE lead_settings;
  CREATE TABLE project_settings (
    machine_id TEXT NOT NULL, project_id TEXT NOT NULL, medium_allowed INTEGER NOT NULL,
    PRIMARY KEY (machine_id, project_id)
  );
  UPDATE tasks SET data = json_set(json_remove(data, '$.model', '$.effort'), '$.profile',
    CASE WHEN json_extract(data, '$.model') = 'claude-opus-5-5' AND json_extract(data, '$.effort') = 'medium'
      THEN 'medium' ELSE 'high' END)
    WHERE json_valid(data);
  ALTER TABLE time_spans ADD COLUMN profile TEXT;
  UPDATE time_spans SET profile = 'high' WHERE role IS NOT NULL OR task_id IS NOT NULL;
  UPDATE time_spans SET profile = 'medium'
    WHERE task_id IN (SELECT 'T' || n FROM tasks WHERE json_extract(data, '$.profile') = 'medium');
  "#,
    // The order router went: nothing emits intake.routed, and a stored one would no longer decode.
    r#"
  DELETE FROM events WHERE type = 'intake.routed';
  "#,
    // The retro went: its runs and proposals, its events and its incident class. A playbook change still waiting on a
    // person is denied, since nothing would apply it.
    r#"
  DROP TABLE retro_runs;
  DROP TABLE retro_proposals;
  DELETE FROM events WHERE type IN ('retro.ran', 'playbook.changed', 'playbook.reverted', 'playbook.kept');
  DELETE FROM incidents WHERE class = 'playbook_reverted';
  UPDATE requests SET state = 'denied', data = json_set(data, '$.state', 'denied')
    WHERE state = 'open' AND json_valid(data) AND json_extract(data, '$.playbook') IS NOT NULL;
  "#,
    // The router's retry memo, the ETA anchor and the generated headlines: nothing reads or writes them, and nothing
    // emits these two event types any more.
    r#"
  DROP TABLE intake_routes;
  DROP TABLE status_eta;
  DROP TABLE status_headlines;
  DELETE FROM events WHERE type IN ('intake.routed', 'workstream.note');
  "#,
    // A brief is a plain record: no freeze hash, no amends.
    r#"
  ALTER TABLE workstreams DROP COLUMN amends;
  UPDATE workstreams SET data = json_remove(data, '$.briefHash') WHERE json_valid(data);
  "#,
    // No value bar: tasks and changes no longer say what they serve.
    r#"
  UPDATE tasks SET data = json_remove(data, '$.serves') WHERE json_valid(data);
  UPDATE changes SET data = json_remove(data, '$.serves') WHERE json_valid(data);
  "#,
    // fleetd makes no time estimates: the estimate samples go, and so do the retired estimate_miss incidents, whose
    // class no longer exists.
    r#"
  DROP TABLE estimates;
  DELETE FROM incidents WHERE class = 'estimate_miss';
  "#,
    // A stall is one thread.failed{reason:"stalled"} now; the event that announced a nudge went with the nudge.
    r#"
  DELETE FROM events WHERE type = 'thread.stalled';
  "#,
    // The human digest went; leads get theirs with every wake.
    r#"
  DELETE FROM events WHERE type = 'digest.ready';
  "#,
    // The slots' saturation spans went with the serial-wait findings that read them.
    r#"
  DELETE FROM time_spans WHERE kind = 37;
  DELETE FROM time_rollups WHERE kind = 37;
  "#,
    // Area leases went: writers share a repo. Their events go too, as no reader decodes them.
    r#"
  DROP TABLE IF EXISTS leases;
  DELETE FROM events WHERE type IN ('lease.stale', 'task.out_of_area');
  "#,
    // Train freeze, drift and opt-in GitHub webhooks went. A merge outside the train is reported once by moving the
    // train's watch past it, so the watch starts now: merges already reported stay reported.
    r#"
  DROP TABLE train_bypasses;
  DROP TABLE github_hooks;
  ALTER TABLE trains DROP COLUMN frozen;
  UPDATE trains SET watch_since_ms = max(watch_since_ms, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  DELETE FROM events WHERE type IN ('train.frozen', 'train.resumed', 'github.drift');
  "#,
    // A lead holds no slot: it is not an agent.
    r#"
  DELETE FROM slot_claims WHERE priority = 'lead';
  "#,
];
