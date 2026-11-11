// `bun scripts/vault-migration-check.ts [--hub-home <dir>] [--node-home <dir>] [--machine <id>]`: the vault's
// migration on a copy of a live hub, by hand and never in CI (design `vault-design` §7). Defaults: ~/.fleetd/hub,
// ~/.fleetd/node, and the node's own machine id (node.json).
//
// 1. Copies `hub.sqlite` (and its `-wal`) into a fresh directory under $TMPDIR, and the node's `project-env/`,
//    `order-env/`, `secret-sinks.json` and the sink files it names into a fake node home beside it. Nothing live is
//    written; the live files are only read.
// 2. Opens the copy directly: no hub starts, nothing links, listens or acts on the outside world. Fingerprints every
//    table (each column's values' SHA-256), runs this build's migrations with `HubDb`, then fingerprints again: every
//    table that was there must read the same, but for a table or column a later migration dropped, and the vault's must
//    be there, empty.
// 3. Takes stock of what the migrate job is to take in, each against the node's copied files: every `project_env` row
//    (a secret's fingerprint against the node's value), every order variable a person gave (fleetd's own `GH_TOKEN`
//    rows, request id `github`, are skipped and counted), and every stored `env:`/`file:` sink of this machine.
// 4. With `src/hub/vault/migrate_check.ts` present (the Bun hub's vault, part 3), runs its `check(ctx)` too: the migrate
//    job against a fake node serving `vault_adopt` from the copied files, with a throwaway root key. Its problems join
//    these.
//
// Prints counts only, never a value or a name, and deletes every copy in a `finally`. Exits 1 on a problem.
import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HubDb } from "../src/hub/store/db.ts";
import { fingerprintOf } from "../src/node/secrets/files.ts";
import { readSecret } from "../src/node/secrets/index.ts";

/** What part 3's `migrate_check.ts` gets: the migrated copy, the fake node home and its machine. */
export type CheckContext = { db: HubDb; nodeHome: string; machineId: string; count: (what: string, n: number) => void };
export type Check = (ctx: CheckContext) => Promise<string[]>;

/** fleetd's own order variables (hub/github_app/sessions.ts): the hub delivers them itself and keeps them there. */
export const SYSTEM_REQUEST_ID = "github";

const arg = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};

/** Each column of every table, its values hashed in rowid order (or every column's when it has none), by table name. */
function fingerprints(conn: Database): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const tables = conn
    .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  for (const { name, sql } of tables) {
    const order = /WITHOUT ROWID/i.test(sql) ? "1" : "rowid";
    const columns = (conn.query("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).map((c) => c.name);
    const byColumn = new Map<string, string>();
    for (const column of columns) {
      const hash = new Bun.CryptoHasher("sha256");
      for (const row of conn.query(`SELECT "${column}" FROM "${name}" ORDER BY ${order}`).values()) {
        hash.update(JSON.stringify(row, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v)));
        hash.update("\n");
      }
      byColumn.set(column, hash.digest("hex"));
    }
    out.set(name, byColumn);
  }
  return out;
}

type ProjectFile = { vars: Record<string, { value: string; secret?: boolean }> };
type OrderFile = { vars: Record<string, string> };
type SinkRecord = { kind: "env" | "file"; path: string; envName?: string };

const readJson = <T>(path: string, empty: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty);

/** Copies the node's variable files and sinks into `to`, the index pointing at the copies; how many sinks it copied. */
function copyNode(from: string, to: string): number {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const dir of ["project-env", "order-env"]) {
    if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true });
  }
  const index = readJson<Record<string, SinkRecord>>(join(from, "secret-sinks.json"), {});
  const copied: Record<string, SinkRecord> = {};
  mkdirSync(join(to, "sinks"), { mode: 0o700 });
  Object.entries(index).forEach(([key, record], n) => {
    if (!existsSync(record.path)) return;
    const path = join(to, "sinks", String(n));
    copyFileSync(record.path, path);
    copied[key] = { ...record, path };
  });
  writeFileSync(join(to, "secret-sinks.json"), JSON.stringify(copied), { mode: 0o600 });
  return Object.keys(copied).length;
}

/** The check; its copies go in a fresh directory under `scratchRoot` (default $TMPDIR), removed when it ends. */
export async function run(opts: {
  hubHome: string;
  nodeHome: string;
  machineId: string;
  scratchRoot?: string;
}): Promise<{ counts: Map<string, number>; problems: string[] }> {
  const counts = new Map<string, number>();
  const count = (what: string, n = 1) => counts.set(what, (counts.get(what) ?? 0) + n);
  const problems: string[] = [];
  const scratch = mkdtempSync(join(opts.scratchRoot ?? tmpdir(), "fleetd-vault-check-"));
  try {
    const hubCopy = join(scratch, "hub");
    mkdirSync(hubCopy, { mode: 0o700 });
    for (const suffix of ["", "-wal"]) {
      const file = join(opts.hubHome, `hub.sqlite${suffix}`);
      if (existsSync(file)) copyFileSync(file, join(hubCopy, `hub.sqlite${suffix}`));
    }
    if (!existsSync(join(hubCopy, "hub.sqlite"))) throw new Error(`no hub.sqlite in ${opts.hubHome}`);
    const nodeCopy = join(scratch, "node");
    count("sink files copied", copyNode(opts.nodeHome, nodeCopy));

    // 2. The migration on the copy, opened directly.
    const raw = new Database(join(hubCopy, "hub.sqlite"), { strict: true });
    const before = fingerprints(raw);
    raw.close();
    const db = HubDb.open(hubCopy);
    try {
      if (db.drift.length) problems.push(`${db.drift.length} applied migration(s) read as drift`);
      const after = fingerprints(db.conn);
      for (const [table, columns] of before) {
        if (table === "migrations_applied") continue;
        // A table or column a later migration dropped on purpose is no change to the rows that stay.
        const now = after.get(table);
        if (now === undefined) {
          count("tables a later migration dropped");
          continue;
        }
        let changed = false;
        for (const [column, hash] of columns) {
          if (!now.has(column)) count("columns a later migration dropped");
          else if (now.get(column) !== hash) changed = true;
        }
        if (changed) problems.push(`table ${table} changed in the migration`);
      }
      count("tables kept", [...before.keys()].filter((t) => t !== "migrations_applied").length);
      for (const table of ["vault_keys", "vault_items", "vault_shares", "vault_deliveries", "vault_audit", "vault_imports", "vault_settings"]) {
        if (!after.has(table)) problems.push(`table ${table} is missing`);
        else if (db.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n !== 0) problems.push(`table ${table} isn't empty`);
      }

      // 3. What the migrate job is to take in, against the node's files.
      const machine = opts.machineId;
      for (const row of db.all<{ machine_id: string; project_id: string; name: string; kind: string; fingerprint: string | null }>(
        "SELECT machine_id, project_id, name, kind, fingerprint FROM project_env",
      )) {
        if (row.kind === "plain") {
          count("plain project variables (taken from the hub's rows)");
          continue;
        }
        count("secret project variables");
        if (row.machine_id !== machine) {
          count("secret project variables on other machines (adopted from their nodes)");
          continue;
        }
        const held = readJson<ProjectFile>(join(nodeCopy, "project-env", `${row.project_id}.json`), { vars: {} }).vars[row.name];
        if (!held) problems.push("a secret project variable is missing from its node's file");
        else if (fingerprintOf(held.value) !== row.fingerprint) {
          count("secret project variables whose node value is newer (the node's wins)");
        } else count("secret project variables matching their node's value");
      }
      for (const row of db.all<{ machine_id: string; project_id: string; workstream_id: string; name: string; fingerprint: string; request_id: string }>(
        "SELECT machine_id, project_id, workstream_id, name, fingerprint, request_id FROM order_env",
      )) {
        if (row.request_id === SYSTEM_REQUEST_ID) {
          count("system order variables (GH_TOKEN), skipped");
          continue;
        }
        count("order variables a person gave");
        if (row.machine_id !== machine) continue;
        const held = readJson<OrderFile>(join(nodeCopy, "order-env", row.project_id, `${row.workstream_id}.json`), { vars: {} }).vars[row.name];
        if (held === undefined) problems.push("an order variable is missing from its node's file");
        else if (fingerprintOf(held) !== row.fingerprint) problems.push("an order variable differs from its node's file");
        else count("order variables matching their node's value");
      }
      for (const { data } of db.all<{ data: string }>("SELECT data FROM requests WHERE kind = 'secret' AND state = 'stored'")) {
        const secret = (JSON.parse(data) as { secret?: { key: string; sink: string; fingerprint?: string } }).secret;
        if (secret?.sink.startsWith("order:")) count("stored order: sinks (in order_env while their order is open)");
        const sink = /^(env|file):([a-z0-9-]{1,32}):/.exec(secret?.sink ?? "");
        if (!secret || !sink) continue;
        count("stored env:/file: sinks");
        if (sink[2] !== machine) {
          count("stored sinks on other machines (adopted from their nodes)");
          continue;
        }
        let value: string;
        try {
          value = readSecret(secret.key, { machineId: machine, roots: [nodeCopy], home: nodeCopy });
        } catch {
          problems.push("a stored sink can't be read on its node");
          continue;
        }
        if (secret.fingerprint && fingerprintOf(value) !== secret.fingerprint) count("stored sinks whose value changed since (the node's wins)");
        else count("stored sinks matching their node's value");
      }
      // 4. The migrate job itself, once the hub's vault is there.
      const hook = join(import.meta.dir, "../src/hub/vault/migrate_check.ts");
      if (existsSync(hook)) {
        const { check } = (await import(hook)) as { check: Check };
        problems.push(...(await check({ db, nodeHome: nodeCopy, machineId: machine, count })));
      } else count("migrate job not checked (src/hub/vault/migrate_check.ts isn't there yet)");
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { counts, problems };
}

if (import.meta.main) {
  const hubHome = arg("--hub-home") ?? join(homedir(), ".fleetd/hub");
  const nodeHome = arg("--node-home") ?? join(homedir(), ".fleetd/node");
  const machineId = arg("--machine") ?? (readJson<{ machineId?: string }>(join(nodeHome, "node.json"), {}).machineId ?? "");
  if (!machineId) {
    console.error("usage: bun scripts/vault-migration-check.ts [--hub-home <dir>] [--node-home <dir>] [--machine <id>]");
    process.exit(2);
  }
  const { counts, problems } = await run({ hubHome, nodeHome, machineId });
  for (const [what, n] of counts) console.log(`${n}\t${what}`);
  for (const p of problems) console.log(`PROBLEM\t${p}`);
  console.log(problems.length ? `vault-migration-check: ${problems.length} problem(s)` : "vault-migration-check: ok");
  process.exit(problems.length ? 1 : 0);
}
