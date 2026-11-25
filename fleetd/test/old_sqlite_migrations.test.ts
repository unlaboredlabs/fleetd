// W775: two shipped migrations needed a newer SQLite than macOS's own, which is Bun's on a Mac, and were rewritten to
// run on OLDEST_SQLITE (scripts/old-sqlite-check.ts runs them there). A hub that ran them as they shipped reads no
// drift and runs nothing again; one whose migration failed half-way runs it whole at its next start; and what the
// rewrites leave is what the originals left.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { failure, migrate, MigrationFailed, OLDEST_SQLITE, olderThan, REWRITTEN, userVersion } from "../src/hub/store/migrations.ts";

const at = (name: string) => MIGRATIONS.findIndex((m) => m.name === name);
const OWN = "202611071205_navis_are_projects";
const VAULT = "202611121235_one_team_vault";
const columns = (conn: Database, table: string) =>
  (conn.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

test("a workspace that ran the rewritten migrations as they shipped reads no drift, and nothing runs again", () => {
  expect(Object.keys(REWRITTEN).sort()).toEqual([OWN, VAULT]);
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS);
  for (const [name, sha] of Object.entries(REWRITTEN)) {
    conn.query("UPDATE migrations_applied SET sha256 = ? WHERE name = ?").run(sha, name);
  }
  const version = userVersion(conn);
  expect(migrate(conn, MIGRATIONS)).toEqual([]);
  expect(userVersion(conn)).toBe(version);
  // Any other change after it ran still reads as one.
  conn.query("UPDATE migrations_applied SET sha256 = 'other' WHERE name = ?").run(OWN);
  expect(migrate(conn, MIGRATIONS)).toEqual([{ kind: "changed", name: OWN }]);
});

test("a migration that failed half-way left nothing, and the next start runs it whole", () => {
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, at(OWN)));
  // As on an old SQLite: the first statements run, a later one is refused.
  const old = { name: OWN, sql: "ALTER TABLE project_settings ADD COLUMN only_me INTEGER;\nSELECT json_group_array(1 ORDER;" };
  let error: unknown;
  try {
    migrate(conn, [...MIGRATIONS.slice(0, at(OWN)), old]);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(MigrationFailed);
  const found = (conn.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  expect((error as Error).message).toStartWith(`the workspace's database can't update: migration ${OWN} failed on SQLite ${found}`);
  expect(columns(conn, "project_settings")).not.toContain("only_me");
  expect(conn.query("SELECT 1 FROM migrations_applied WHERE name = ?").get(OWN)).toBeNull();

  expect(migrate(conn, MIGRATIONS)).toEqual([]);
  expect(columns(conn, "project_settings")).toContain("only_me");
  expect(userVersion(conn)).toBe(MIGRATIONS.length);
});

test("an SQLite older than the oldest supported is named with the one needed", () => {
  expect(olderThan("3.36.0", OLDEST_SQLITE)).toBe(true);
  expect(olderThan("3.37.2", OLDEST_SQLITE)).toBe(false);
  expect(olderThan("3.43.2", "3.44")).toBe(true);
  expect(olderThan("3.100.0", "3.44.0")).toBe(false);
  expect(failure(OWN, "3.36.0", 'near "ORDER": syntax error')).toBe(
    `the workspace's database can't update: migration ${OWN} needs SQLite ${OLDEST_SQLITE} or newer, and this machine's is ` +
      `3.36.0 (near "ORDER": syntax error)`,
  );
});

test("a person's own projects come first in their owner's sidebar order: named ones in its order, then the rest oldest first", () => {
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, at(OWN)));
  conn.run(`INSERT INTO assistants VALUES ('m','n1',300,'k','K',NULL,'p1',NULL), ('m','n2',100,'k','K',NULL,'p1',NULL),
    ('m','n3',200,'k','K',NULL,'p1',NULL), ('m','n4',50,'k','K',NULL,'p2',NULL)`);
  const ref = (projectId: string) => ({ machineId: "m", projectId });
  conn.query("INSERT INTO sidebar_orders VALUES ('p1', ?)").run(JSON.stringify(["x1", "n3", "x2", "n1"].map(ref)));
  migrate(conn, MIGRATIONS.slice(0, at(OWN) + 1));
  const order = (person: string) =>
    JSON.parse((conn.query("SELECT refs FROM sidebar_orders WHERE person_id = ?").get(person) as { refs: string }).refs);
  expect(order("p1")).toEqual(["n3", "n1", "n2", "x1", "x2"].map(ref));
  expect(order("p2")).toEqual([ref("n4")]);
});

test("the team vault keeps a list of copies only when there are some", () => {
  const copies = (people: string) => {
    const conn = new Database(":memory:", { strict: true });
    migrate(conn, MIGRATIONS.slice(0, at(VAULT)));
    conn.run(people);
    conn.run(`INSERT INTO projects VALUES ('m','a','','','{}'), ('m','b','','','{}'), ('m','c','','','{}')`);
    conn.run(`INSERT INTO vault_items (item_id, kind, scope, person_id, env_name, label, meta, sealed, key_id, version,
        created_ms, created_by, updated_ms, updated_by) VALUES ('i1','env','person','p1','FOO','FOO','{}',x'00','k',1,1,'p1',1,'p1')`);
    migrate(conn, MIGRATIONS.slice(0, at(VAULT) + 1));
    const row = conn.query("SELECT value FROM vault_settings WHERE key = 'team_vault_copies'").get() as { value: string } | null;
    return row && JSON.parse(row.value);
  };
  expect(copies("INSERT INTO people VALUES ('p1','A','owner',1,NULL,NULL)")).toEqual([
    { itemId: "i1", machineId: "m", projectId: "b" },
    { itemId: "i1", machineId: "m", projectId: "c" },
  ]);
  expect(copies("INSERT INTO people VALUES ('p1','A','owner',1,NULL,NULL), ('p2','B','member',1,NULL,NULL)")).toBeNull();
});
