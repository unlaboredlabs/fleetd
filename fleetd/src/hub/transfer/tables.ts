// What a hub's export (`fleetd export`, format.ts) does with each table of the hub's database: carried as it is,
// rebuilt on import, or left out with the reason. Every table is in exactly one list; test/transfer-tables.test.ts
// holds the three to the migrated schema, so a migration's new table fails there until it is given a place.
//
// The rule: what a hub keeps across its own restart is carried, so the hub the file loads into goes on as the old one
// would have. What signs someone or something in (keys, codes, push tokens) and what only describes processes of the
// old hub's machines at that moment is left out: people sign in again and machines join again under their ids.

/** The tables whose rows travel as they are, in the hub's own shape. */
export const CARRIED = [
  "agent_message_to",
  "agent_messages",
  "approval_checks",
  "artifact_versions",
  "attachments",
  "automation_runs",
  "automations",
  "browser_sessions",
  "browser_settings",
  "changes",
  "chat_messages",
  "chat_pins",
  "chat_projects",
  "chat_sections",
  "checklists",
  "ci_waits",
  "claude_accounts",
  "claude_choices",
  "claude_settings",
  "decisions",
  "events",
  "github_accounts",
  "github_app",
  "github_order_tokens",
  "hub_links",
  "landing_watch",
  "landings",
  "lead_mcp",
  "leads",
  "legacy_asks",
  "machine_roles",
  "machine_roles_settings",
  // Each machine as machineRow leaves it: its id and name, offline, without its box key.
  "machines",
  "mcp_oauth",
  "mcp_secret_forgets",
  "mcp_servers",
  "mcp_settings",
  "memory_imports",
  "memory_refresh_lines",
  "memory_refreshes",
  "memory_settings",
  "metric_changes",
  "metric_identities",
  "metric_merges",
  "metric_project_repos",
  "metric_repos",
  "metric_touches",
  "navi_approvals",
  "navi_ask_orders",
  "navi_asks",
  "navi_auto_approved",
  "navi_erases",
  "navi_sites",
  "onepassword_tokens",
  "order_env",
  "people",
  "person_avatars",
  "profiles",
  "project_avatars",
  "project_env",
  "project_icons",
  "project_profiles",
  "project_settings",
  "project_setup_changes",
  "project_setup_clones",
  "projects",
  "prompt_versions",
  "push_relay",
  "queued_writes",
  "repos",
  "requests",
  "review_bindings",
  "review_patch_ids",
  "review_people",
  "review_people_sent",
  "review_posts",
  "review_rebases",
  "review_stalls",
  "review_tasks",
  "review_verdicts",
  "session_prompts",
  "shell_cursors",
  "sidebar_orders",
  "skill_uses",
  "skill_versions",
  "slot_machine_caps",
  "slot_settings",
  "slot_shares",
  "steers",
  "task_threads",
  "tasks",
  "thread_accounts",
  "threads",
  "time_cursors",
  "time_digests",
  "time_hours",
  "time_labels",
  "time_lead_runs",
  "time_order_ci",
  "time_orders",
  "time_paths",
  "time_rollups",
  "time_settings",
  "time_spans",
  "time_wakes",
  "train_fix_orders",
  "train_waits",
  "train_watch_checks",
  "train_watches",
  "trains",
  "vault_audit",
  "vault_deliveries",
  "vault_imports",
  "vault_items",
  "vault_settings",
  "vault_shares",
  "wakes",
  "work_claims",
  "work_projects",
  "workstreams",
] as const;

/** The tables import fills by itself, each with how. */
export const REBUILT: Record<string, string> = {
  decisions_fts: "the decisions' search index, filled again from the decisions",
  decisions_fts_config: "part of the decisions' search index",
  decisions_fts_content: "part of the decisions' search index",
  decisions_fts_data: "part of the decisions' search index",
  decisions_fts_docsize: "part of the decisions' search index",
  decisions_fts_idx: "part of the decisions' search index",
  migrations_applied: "the manifest names the migrations the rows are at (`schema`); import runs the ones after them",
};

/** The tables that stay behind, each with why. */
export const LEFT_OUT: Record<string, string> = {
  agent_keys: "keys and device sign-ins: people sign in again, agents get new keys",
  attachment_uploads: "uploads that hadn't finished; their pieces stay behind too",
  enroll_tokens: "open join codes for machines",
  hub_links_issued: "keys this hub gave other hubs: they link again",
  node_keys: "the machines' keys: each machine joins again",
  pair_codes: "open pairing and invite codes",
  push_devices: "the phones' push tokens, which belong to their sign-ins",
  screen_waits: "a wait for a screen on one of the old hub's machines, minutes long",
  session_places: "which machine's process hosts each screen session",
  slot_claims: "the agent slots held on the old hub's machines; agents claim again",
  vault_keys: "the old hub's root key ids; the new hub records its own",
};

/** Rows of a carried table that stay behind: the SQL that picks them, and why. */
export const ROWS_LEFT_OUT: Record<string, { where: string; why: string }> = {
  vault_settings: {
    where: "key = 'recovery_saved_ms'",
    why: "that the vault's recovery code was saved: the new hub's root key has a new code",
  },
};

/**
 * The tables a row in which means a hub has been used, with what the person calls those rows. Import loads into a
 * fresh hub only: it refuses one with a row in any of these, or with more people than the owner a hub makes itself.
 */
export const MARKS_USE: Record<string, string> = {
  projects: "projects",
  chat_messages: "chat messages",
  workstreams: "orders",
  tasks: "tasks",
  threads: "agent sessions",
  decisions: "decisions",
  checklists: "checklists",
  artifact_versions: "artifacts",
  attachments: "attachments",
  automations: "automations",
  vault_items: "vault items",
  skill_versions: "skills",
};

export type Fate = { fate: "carried" } | { fate: "rebuilt"; how: string } | { fate: "left_out"; why: string };

const carried = new Set<string>(CARRIED);

/** What an export does with `table`; undefined for a table no list names. */
export function fateOf(table: string): Fate | undefined {
  if (carried.has(table)) return { fate: "carried" };
  const how = REBUILT[table];
  if (how !== undefined) return { fate: "rebuilt", how };
  const why = LEFT_OUT[table];
  return why === undefined ? undefined : { fate: "left_out", why };
}

/**
 * Where a carried table holds a value sealed to the hub's own box key (`<home>/node-box-key.pem`). The file never
 * holds such a value as it is, or in the clear: export opens it and seals it under the export's key (seal.ts), and
 * import seals it to the new hub's box key. `key` names the row for the seal's binding (its primary key);
 * `blob` columns are the box itself, `base64` columns its standard base64, and `json` names base64 boxes inside a
 * JSON column by their path.
 */
export type SealedColumns = {
  key: string[];
  blob?: string[];
  base64?: string[];
  json?: { column: string; paths: string[][] }[];
};

export const SEALED: Record<string, SealedColumns> = {
  github_accounts: { key: ["person_id"], blob: ["sealed_access", "sealed_refresh"] },
  github_app: { key: ["id"], blob: ["sealed_key", "sealed_client_secret", "sealed_webhook_secret"] },
  hub_links: { key: ["link_id"], blob: ["sealed"] },
  mcp_oauth: {
    key: ["machine_id", "project_id", "name"],
    blob: ["sealed_access", "sealed_refresh"],
    json: [
      {
        column: "data",
        paths: [
          ["client", "sealedSecret"],
          ["pending", "client", "sealedSecret"],
        ],
      },
    ],
  },
  push_relay: { key: ["id"], base64: ["key_sealed"] },
};

/** The vault's items: each one's data key is wrapped again under the export's key, its own ciphertext untouched. */
export const VAULT_ITEMS = "vault_items";

/**
 * The tables an export without secrets (`--no-secrets`) leaves out whole, and an import without the passphrase
 * skips: the ones with a sealed value, and the vault's rows about its items.
 */
export const SECRET_TABLES: readonly string[] = [...Object.keys(SEALED), VAULT_ITEMS, "vault_deliveries", "vault_imports", "vault_shares"];

/**
 * A machine as the file carries it: its id and name as an offline machine, without its box key. The projects, orders
 * and chats keyed by its id keep their place, and it joins the new hub again under that id.
 */
export function machineRow(data: string): string {
  const m = JSON.parse(data) as Record<string, unknown>;
  delete m.boxPubKey;
  delete m.degradedReason;
  return JSON.stringify({ ...m, status: "offline" });
}

/** The folders of the hub's home whose files travel, by the name the manifest gives each. */
export const AREAS = {
  attachments: "attachments",
  recordings: "browser",
  memory: "memory",
  skills: "skills",
  prompts: "prompts",
} as const;

/** What stays behind in the hub's home, each with why (the docs' list). */
export const FILES_LEFT_OUT: Record<string, string> = {
  "attachments/uploads": "the pieces of uploads that hadn't finished",
  "browser/<session> of a session not recorded": "a recording still being made or uploaded, lost or expired",
  builds: "the builds of pull requests, made again when asked for",
  "cli.key": "the key of the fleetd CLI on the hub machine: the new hub's CLI has its own",
  "hub.log": "the hub's log",
  "node-box-key.pem": "the hub's own box key: it never leaves, and the new hub has its own",
  "setup.json": "this install's listen address, URL and SSH hosts",
  update: "the updater's downloads",
  "vault/root.key": "the vault's root key: it never leaves, and the new hub has its own",
};
