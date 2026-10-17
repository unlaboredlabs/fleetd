import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class HubHomeError extends Schema.TaggedError<HubHomeError>()("HubHomeError", {
  home: Schema.String,
  reason: Schema.Literals(["inside-t3-home"]),
}) {
  override get message(): string {
    return `hub home ${this.home} is inside ~/.t3, which belongs to T3; pick another --home (default ~/.fleetd/hub)`;
  }
}

/** The hub's SQLite database. HubStore, EventLog and Auth share one connection. */
export class HubDb extends Context.Service<HubDb, { readonly db: DatabaseSync }>()("fleetd/store/HubDb") {}

/**
 * Numbered migrations; index + 1 is the `user_version` after each one runs. Append only, never edit a
 * shipped entry.
 */
const MIGRATIONS: ReadonlyArray<string> = [
  `
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
  `,
  // Webhook subscriptions. `secret` is sealed with the key in <home>/webhook.key; `last_delivered_seq` is the
  // delivery cursor; `failing_reported` marks that this failing spell already emitted webhook.failing.
  `
  CREATE TABLE subscriptions (
    subscription_id TEXT PRIMARY KEY, created_by TEXT NOT NULL, client_request_id TEXT NOT NULL, url TEXT NOT NULL,
    types TEXT NOT NULL, machines TEXT NOT NULL, secret TEXT NOT NULL, state TEXT NOT NULL, created_ms INTEGER NOT NULL,
    last_delivered_seq INTEGER NOT NULL, failing_since_ms INTEGER, failing_reported INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_by, client_request_id)
  );
  `,
  // T3's latest run per thread and the phase it was last seen in, so a run that ended while the hub was
  // down is reported on its return.
  `
  ALTER TABLE threads ADD COLUMN last_run_id TEXT;
  ALTER TABLE threads ADD COLUMN last_run_status TEXT;
  `,
  // The ledger: decisions with their FTS5 index, asks, batches and incident markers.
  `
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
  `,
  // M3 leads and workstreams. AUTOINCREMENT so a workstream number is never reused.
  `
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
  `,
  // Hub-owned wakes and the offline write queue.
  `
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
  `,
  // M5 slots and leases. A slot claim is queued, held (reserved or its thread running) or idle (its thread
  // stopped; kept so a re-run is counted again). `order_n` is FIFO order within a priority.
  `
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
  `,
  // M5 tasks. AUTOINCREMENT so a task number is never reused; `pending_message` is a `task message` waiting for a
  // slot or lease.
  `
  CREATE TABLE tasks (
    n INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, ended_at TEXT, pending_message TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX tasks_by_project ON tasks (machine_id, project_id, n DESC);
  CREATE INDEX tasks_by_thread ON tasks (machine_id, thread_id) WHERE thread_id IS NOT NULL;
  CREATE INDEX tasks_queued ON tasks (n) WHERE state = 'queued';
  `,
  // Human keys (a person's device): their answers are recorded as the human's.
  `ALTER TABLE agent_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';`,
  // M6 incidents, review verdicts (newest row per PR wins; `pr_key` is null for judge tasks) and estimate samples
  // (one per workstream that started running with a raw estimate; `done_ms` set when it is done).
  `
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
  `,
  // M6 claims. A row is numbered when the claim starts; `outcome` and `data` (the Claim) are set when its checks end,
  // so a claim superseded or cut off by a restart stays NULL and is never listed.
  `
  CREATE TABLE claims (
    n INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    outcome TEXT, data TEXT
  );
  CREATE INDEX claims_by_workstream ON claims (workstream_id, n DESC);
  `,
  // M7 merge train. A Change row per enqueued PR (`train_order` is its place in its repo's train; a re-queue at the
  // front takes one below the lowest), one train per repo with the project whose machine runs its git, and the
  // merges outside the train already reported as policy_bypass incidents. Repos are stored lowercased.
  `
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
  `,
  // M7 reviews: the review tasks spawned for each Change with the patch id their round was for, each verdict bound to
  // the patch id of the head it reviewed, the patch id of each head seen, and patches the polish-loop rule waived.
  `
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
  `,
  // M9 playbooks: the text of every playbook version a workstream pinned, so its brief is checked against that version
  // after the file changes.
  `
  CREATE TABLE playbook_versions (ref TEXT PRIMARY KEY, text TEXT NOT NULL);
  `,
];

/** The `user_version` of a fully migrated database. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Runs `fn` in a write transaction, so a concurrent writer (the CLI next to a running hub) waits instead of interleaving. */
export const transaction = <A>(db: DatabaseSync, fn: () => A): A => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const migrate = (db: DatabaseSync) => {
  const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  while (version() < MIGRATIONS.length) {
    transaction(db, () => {
      // Re-read inside the lock: another process may have migrated while we waited.
      const current = version();
      const next = MIGRATIONS[current];
      if (next === undefined) return;
      db.exec(next);
      db.exec(`PRAGMA user_version = ${current + 1}`);
    });
  }
};

const open = (file: string) => {
  const db = new DatabaseSync(file);
  // Lets the CLI write keys while the hub runs; a writer waits up to 5 s for the other's lock.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
};

/** True when `child` is `parent` or below it. */
const isWithin = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** Real path of `p`, following symlinks in the part of it that exists. */
const realish = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(realish(parent), path.basename(p));
  }
};

/**
 * Resolves `--home` (default `~/.fleetd/hub`, `~` expanded) and refuses anything inside `~/.t3`, the live T3
 * home, including through symlinks.
 */
export const resolveHubHome = (
  home: string | undefined,
  userHome: string = os.homedir(),
): Effect.Effect<string, HubHomeError> =>
  Effect.suspend(() => {
    const raw = home ?? path.join(userHome, ".fleetd", "hub");
    const expanded = raw === "~" || raw.startsWith("~/") ? path.join(userHome, raw.slice(1)) : raw;
    const resolved = path.resolve(expanded);
    const t3 = path.join(userHome, ".t3");
    return isWithin(t3, resolved) || isWithin(realish(t3), realish(resolved))
      ? Effect.fail(new HubHomeError({ home: resolved, reason: "inside-t3-home" }))
      : Effect.succeed(resolved);
  });

/** Opens (creating if needed) `<home>/hub.sqlite` in WAL mode and migrates it. `home` must come from `resolveHubHome`. */
export const layer = (home: string) =>
  Layer.effect(
    HubDb,
    Effect.acquireRelease(
      Effect.sync(() => {
        fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        return HubDb.of({ db: open(path.join(home, "hub.sqlite")) });
      }),
      ({ db }) => Effect.sync(() => db.close()),
    ),
  );

/** A private in-memory database, for tests. */
export const layerMemory = Layer.effect(
  HubDb,
  Effect.acquireRelease(
    Effect.sync(() => HubDb.of({ db: open(":memory:") })),
    ({ db }) => Effect.sync(() => db.close()),
  ),
);
