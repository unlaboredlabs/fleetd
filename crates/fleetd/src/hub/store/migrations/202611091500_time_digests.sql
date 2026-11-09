-- Hourly digests of the time spans, so a Time breakdown over weeks reads a few thousand digests instead of every span
-- (experimental/bun/src/hub/time/hours.ts). `time_hours` is one row per UTC hour: `version` counts the span writes
-- into it and `reset` the changes to spans already digested; a build records the version it saw, the newest span id
-- then (`upto`, later ones are read live), the spans it left out (`live`: open, or ending before they start) and the
-- first and last start it holds. `time_digests` holds one digest per hour and (machine, project, role), role `*` for
-- every role. `time_order_ci` keeps the `change.ci` segments of orders' critical paths, so a breakdown needn't decode
-- whole paths: a done order's are its stored path's, a running order's the newest the hub worked out.
CREATE TABLE time_hours (
    hour INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, reset INTEGER NOT NULL DEFAULT 0,
    built_version INTEGER, built_ms INTEGER, upto INTEGER, live TEXT, min_start INTEGER, max_start INTEGER
  );
  CREATE TABLE time_digests (
    hour INTEGER NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (hour, machine_id, project_id, role)
  ) WITHOUT ROWID;
  CREATE TABLE time_order_ci (
    workstream_id TEXT PRIMARY KEY, done INTEGER NOT NULL, computed_ms INTEGER NOT NULL, ci TEXT NOT NULL
  );
  -- An order's intake start, and the gaps a breakdown lists, without walking every span of the order or the period.
  CREATE INDEX time_spans_intake ON time_spans (workstream_id, start_ms) WHERE kind = 58;
  CREATE INDEX time_spans_gaps ON time_spans (start_ms) WHERE kind = 61;
