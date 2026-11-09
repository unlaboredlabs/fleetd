// `bun scripts/db-check.ts <hub.sqlite> [<sessions.sqlite>]`: whether this build's hub and node open these databases in
// place. Point it at copies of a live hub's and node's files (`sqlite3 <live> ".backup <copy>"`), never the live ones,
// and never start a hub on a copy: it would act on the outside world.
//
// The hub's: the migrations it records (`migrations_applied`) against the ones this build ships (src/gen/migrations.ts),
// by name and SHA-256, so none would run again or read as drift; then the schema it has once this build's migration
// runner has run on a scratch copy of it, against a fresh database's. The node's: its schema against a fresh node
// store's. The files given are opened read-only; the scratch copy is deleted after.
//
// Prints each difference and exits 1 when there is one; `same` lines and exit 0 otherwise.
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate, userVersion } from "../src/hub/store/migrations.ts";
import { NodeStore } from "../src/node/sessions/store.ts";

const [hubPath, nodePath] = process.argv.slice(2);
if (!hubPath) {
  console.error("usage: bun scripts/db-check.ts <hub.sqlite copy> [<sessions.sqlite copy>]");
  process.exit(2);
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
let differences = 0;
const differ = (what: string) => {
  differences++;
  console.log(`DIFFERS ${what}`);
};

/** Every table, index, view and trigger, as `<type> <name>: <sql>`, whitespace folded; SQLite's own left out. */
function schema(db: Database): Map<string, string> {
  const rows = db
    .query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string; sql: string | null }[];
  return new Map(rows.map((r) => [`${r.type} ${r.name}`, (r.sql ?? "").replace(/\s+/g, " ").trim()]));
}

function compare(what: string, have: Map<string, string>, want: Map<string, string>) {
  const before = differences;
  for (const [key, sql] of want) {
    if (!have.has(key)) differ(`${what}: ${key} is missing`);
    else if (have.get(key) !== sql) differ(`${what}: ${key} is\n    ${have.get(key)}\n  where a fresh one is\n    ${sql}`);
  }
  for (const key of have.keys()) if (!want.has(key)) differ(`${what}: ${key} is extra`);
  if (differences === before) console.log(`same ${what}: ${want.size} tables, indexes and triggers`);
}

const readOnly = (path: string) => new Database(path, { readonly: true });

// The hub: its recorded migrations.
const hub = readOnly(hubPath);
const integrity = (hub.query("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
if (integrity !== "ok") differ(`hub: quick_check says ${integrity}`);
const tracked = hub.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations_applied'").get();
const applied = new Map(
  tracked ? (hub.query("SELECT name, sha256 FROM migrations_applied").all() as { name: string; sha256: string }[]).map((r) => [r.name, r.sha256]) : [],
);
const shipped = new Map(MIGRATIONS.map((m) => [m.name, sha256(m.sql)]));
const pending = MIGRATIONS.filter((m) => !applied.has(m.name)).map((m) => m.name);
for (const [name, sum] of applied) {
  if (!shipped.has(name)) differ(`hub: migration ${name} ran there, and this build has no such file (a newer fleetd's?)`);
  else if (shipped.get(name) !== sum) differ(`hub: migration ${name} changed since it ran there`);
}
if (userVersion(hub) !== applied.size) differ(`hub: user_version is ${userVersion(hub)}, ${applied.size} migrations recorded`);
console.log(
  `hub: ${applied.size} migrations recorded, ${shipped.size} shipped; ${pending.length === 0 ? "none to run" : `would run ${pending.join(", ")}`}`,
);
const live = schema(hub);
hub.close();

// The hub's schema once this build has migrated it: on a scratch copy, as the Bun hub would on open.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "db-check-"));
try {
  let migrated = live;
  if (pending.length > 0) {
    const copy = join(scratch, "hub.sqlite");
    const src = readOnly(hubPath);
    src.run(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    src.close();
    const db = new Database(copy, { strict: true });
    migrate(db, MIGRATIONS);
    migrated = schema(db);
    db.close();
  }
  const fresh = HubDb.memory();
  compare("hub schema", migrated, schema(fresh.conn));
  fresh.conn.close();

  // The node's.
  if (nodePath) {
    if (!existsSync(nodePath)) differ(`node: no ${nodePath}`);
    else {
      const node = readOnly(nodePath);
      const store = new NodeStore(join(scratch, "sessions.sqlite"));
      compare("node schema", schema(node), schema(store.db));
      const [have, want] = [userVersion(node), userVersion(store.db)];
      if (have !== want) differ(`node: user_version is ${have}, a fresh store's ${want}`);
      store.close();
      node.close();
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(differences === 0 ? "db-check: the Bun build opens these in place" : `db-check: ${differences} difference(s)`);
process.exit(differences === 0 ? 0 : 1);
