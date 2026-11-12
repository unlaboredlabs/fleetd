// The vault's migration (src/hub/store/migrations/<ts>_vault.sql) on a fresh database and on one that
// already holds variables: tables only, its checks hold each scope to its ids, and the rows before it stay.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";

const VAULT = MIGRATIONS.findIndex((m) => m.name.endsWith("_vault"));
const ID = (n: number) => `V${n.toString(16).padStart(32, "0")}`;

function item(db: HubDb, fields: Record<string, unknown>): void {
  const row = {
    item_id: ID(1),
    kind: "login",
    scope: "person",
    person_id: "p_abcdefgh",
    machine_id: null,
    project_id: null,
    workstream_id: null,
    env_name: null,
    label: "Example",
    meta: '{"source":{"kind":"typed"}}',
    sealed: new Uint8Array([1]),
    key_id: "k1",
    version: 1,
    created_ms: 1,
    created_by: "human:test",
    updated_ms: 1,
    updated_by: "human:test",
    deleted_ms: null,
    ...fields,
  };
  const names = Object.keys(row);
  db.conn
    .query(`INSERT INTO vault_items (${names.join(", ")}) VALUES (${names.map((n) => `$${n}`).join(", ")})`)
    .run(Object.fromEntries(names.map((n) => [n, row[n as keyof typeof row]])) as never);
}

test("the vault's migration sorts last and adds its tables to a fresh database", () => {
  expect(VAULT).toBeGreaterThan(0);
  expect(MIGRATIONS.slice(VAULT + 1).every((m) => m.name > MIGRATIONS[VAULT]!.name)).toBe(true);
  const db = HubDb.memory();
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vault_%' ORDER BY name")
    .map((t) => t.name);
  expect(tables).toEqual([
    "vault_audit",
    "vault_deliveries",
    "vault_imports",
    "vault_items",
    "vault_keys",
    "vault_settings",
  ]);
  expect(db.all("SELECT * FROM vault_items")).toEqual([]);
  db.close();
});

test("each scope takes only its own ids, and a variable only its own name", () => {
  const db = HubDb.memory();
  const ok: Record<string, unknown>[] = [
    {},
    { item_id: ID(2), kind: "card", scope: "hub", person_id: "p_abcdefgh" },
    { item_id: ID(3), kind: "env", scope: "project", machine_id: "devbox", project_id: "p1", env_name: "API_URL" },
    {
      item_id: ID(4),
      kind: "env",
      scope: "order",
      machine_id: "devbox",
      project_id: "p1",
      workstream_id: "W7",
      env_name: "API_URL",
    },
  ];
  for (const fields of ok) item(db, fields);
  const refused: Record<string, unknown>[] = [
    { item_id: ID(10), kind: "secret" },
    { item_id: ID(11), person_id: null },
    { item_id: ID(12), machine_id: "devbox" },
    { item_id: ID(13), kind: "env", scope: "hub", env_name: "API_URL" },
    { item_id: ID(14), kind: "login", scope: "order", machine_id: "devbox", project_id: "p1", workstream_id: "W7" },
    { item_id: ID(15), kind: "env", scope: "order", machine_id: "devbox", project_id: "p1", env_name: "X" },
    { item_id: ID(16), kind: "env", scope: "project", machine_id: "devbox", project_id: "p1" },
    { item_id: ID(17), kind: "login", env_name: "X" },
    { item_id: ID(18), scope: "project", machine_id: "devbox", project_id: "p1", workstream_id: "W7" },
  ];
  for (const fields of refused) expect(() => item(db, fields), JSON.stringify(fields)).toThrow();
  db.close();
});

test("a variable's name is unique in its scope until it's in the trash", () => {
  const db = HubDb.memory();
  const env = { kind: "env", scope: "project", machine_id: "devbox", project_id: "p1", env_name: "API_URL" };
  item(db, { ...env, item_id: ID(1) });
  expect(() => item(db, { ...env, item_id: ID(2) })).toThrow();
  item(db, { ...env, item_id: ID(3), project_id: "p2" });
  db.conn.run("UPDATE vault_items SET deleted_ms = 5 WHERE item_id = ?", [ID(1)]);
  item(db, { ...env, item_id: ID(4) });
  db.close();
});

test("the rows before it stay as they were", () => {
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, VAULT));
  conn.run(
    "INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["devbox", "p1", "API_URL", "plain", "https://api.example.test", null, 24, "2026-11-09T00:00:00Z"],
  );
  const before = conn.query("SELECT * FROM project_env").all();
  migrate(conn, MIGRATIONS);
  expect(conn.query("SELECT * FROM project_env").all()).toEqual(before);
  expect(conn.query("SELECT count(*) AS n FROM vault_items").get()).toEqual({ n: 0 });
  conn.close();
});
