-- W549: the vault (fleetd-contracts vault.rs). Tables only: no data moves here; the hub's migrate job takes in
-- `project_env`, the nodes' variables and sinks (`vault_adopt`) and a picked `op://` card, and those rows and files stay
-- as the delivery target and the Rust mirror.
-- `vault_keys` is each root key's id with a check blob (16 zero bytes sealed under it, so a wrong key reads apart from
-- a damaged item); the key itself is never here (~/.fleetd/vault/root.key).
-- `vault_items` is one item, `sealed` its envelope (a data key per version wrapped by the root key `key_id`, then
-- the secret fields' JSON, each bound to the row by its additional data), `meta` its readable JSON (`VaultMeta`).
-- Scope: `person` (its owner), `project` (machine + project), `order` (variables only, + workstream), `hub` (never a
-- variable). `deleted_ms`: in the trash, purged 30 days later.
-- `vault_shares`: a person item that a project's work may use too. `vault_deliveries`: which version (and fingerprint)
-- each machine holds for each target (`project:<p>`, `order:<p>/<W>`, `sink:<key>`), for catch-up after being offline.
-- `vault_audit`: every use, never a value (`data` is `VaultAuditData`; `item_id` "" for a row of no single item). `vault_imports`: a lead's import proposals.
-- `vault_settings`: the hub's own vault state (migration progress, recovery code saved, refusal-line throttle).
-- A project's vault card stays in `project_settings.card_ref`, as `vault:V…` (an `op://` one until it's imported).
CREATE TABLE vault_keys (key_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, retired_ms INTEGER,
    check_blob BLOB NOT NULL);
CREATE TABLE vault_items (
    item_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('login', 'card', 'address', 'env')),
    scope TEXT NOT NULL CHECK (scope IN ('person', 'project', 'order', 'hub')),
    person_id TEXT,
    machine_id TEXT, project_id TEXT, workstream_id TEXT,
    env_name TEXT,
    label TEXT NOT NULL, meta TEXT NOT NULL,
    sealed BLOB NOT NULL, key_id TEXT NOT NULL, version INTEGER NOT NULL,
    created_ms INTEGER NOT NULL, created_by TEXT NOT NULL, updated_ms INTEGER NOT NULL, updated_by TEXT NOT NULL,
    deleted_ms INTEGER,
    CHECK ((scope = 'person' AND person_id IS NOT NULL AND machine_id IS NULL)
        OR (scope = 'project' AND machine_id IS NOT NULL AND project_id IS NOT NULL AND workstream_id IS NULL)
        OR (scope = 'order' AND kind = 'env' AND machine_id IS NOT NULL AND project_id IS NOT NULL
            AND workstream_id IS NOT NULL)
        OR (scope = 'hub' AND kind <> 'env' AND machine_id IS NULL)),
    CHECK ((kind = 'env') = (env_name IS NOT NULL))
);
  CREATE UNIQUE INDEX vault_env_names ON vault_items (scope, ifnull(person_id, ''), ifnull(machine_id, ''),
      ifnull(project_id, ''), ifnull(workstream_id, ''), env_name) WHERE kind = 'env' AND deleted_ms IS NULL;
  CREATE INDEX vault_items_project ON vault_items (machine_id, project_id) WHERE deleted_ms IS NULL;
  CREATE INDEX vault_items_person ON vault_items (person_id) WHERE deleted_ms IS NULL;
CREATE TABLE vault_shares (item_id TEXT NOT NULL, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    by_person TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (item_id, machine_id, project_id));
  CREATE INDEX vault_shares_project ON vault_shares (machine_id, project_id);
CREATE TABLE vault_deliveries (item_id TEXT NOT NULL, machine_id TEXT NOT NULL, target TEXT NOT NULL,
    version INTEGER NOT NULL, fingerprint TEXT, at_ms INTEGER NOT NULL, error TEXT,
    PRIMARY KEY (item_id, machine_id, target));
CREATE TABLE vault_audit (n INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, item_id TEXT NOT NULL,
    action TEXT NOT NULL, outcome TEXT NOT NULL, person_id TEXT, device_id TEXT, machine_id TEXT, project_id TEXT,
    thread_id TEXT, task_id TEXT, workstream_id TEXT, data TEXT NOT NULL);
  CREATE INDEX vault_audit_item ON vault_audit (item_id, n);
  CREATE INDEX vault_audit_project ON vault_audit (machine_id, project_id, n);
  CREATE INDEX vault_audit_at ON vault_audit (at_ms);
CREATE TABLE vault_imports (proposal_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
    person_id TEXT NOT NULL, thread_id TEXT, state TEXT NOT NULL, data TEXT NOT NULL, created_ms INTEGER NOT NULL,
    answered_ms INTEGER);
CREATE TABLE vault_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
