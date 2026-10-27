-- The agent time inspector: spans (one interval of one lane) from the nodes and the hub, their labels deduped,
-- per-day roll-ups, finished orders' critical paths, cursors for the node outboxes and the event-log projector,
-- and the retention setting. `time_orders`, `time_wakes` and `time_lead_runs` let the projector bound an order's
-- wall time and split a lead's turns across the orders its wake served: one row per run and order, `n` the
-- orders that run served ('' with n 0 for a run that served none).
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
