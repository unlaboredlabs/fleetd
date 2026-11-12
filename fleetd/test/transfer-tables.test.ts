// The export's table mapping (hub/transfer/tables.ts) against the migrated schema: every table has exactly one fate,
// and nothing sealed to the hub's own keys is carried as it is. A migration that adds a table fails here until the
// table is given a place.
import { describe, expect, test } from "bun:test";
import { HubDb } from "../src/hub/store/db.ts";
import { CARRIED, fateOf, LEFT_OUT, MARKS_USE, REBUILT, ROWS_LEFT_OUT, SEALED, SECRET_TABLES, VAULT_ITEMS } from "../src/hub/transfer/tables.ts";

function schema() {
  const db = HubDb.memory();
  const tables = db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((t) => t.name)
    .sort();
  const columns = new Map(tables.map((t) => [t, db.all<{ name: string }>(`PRAGMA table_info("${t}")`).map((c) => c.name)]));
  const other = db.all<{ type: string; name: string }>("SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')");
  db.close();
  return { tables, columns, other };
}

describe("the export's table mapping", () => {
  const { tables, columns, other } = schema();
  const lists = [...CARRIED, ...Object.keys(REBUILT), ...Object.keys(LEFT_OUT)];

  test("every table of the hub's database is carried, rebuilt or left out, in one list only", () => {
    expect(tables.filter((t) => !fateOf(t))).toEqual([]);
    expect(lists.filter((t, i) => lists.indexOf(t) !== i)).toEqual([]);
  });

  test("the lists name no table the hub doesn't have", () => {
    expect(lists.filter((t) => !tables.includes(t))).toEqual([]);
    expect([...Object.keys(ROWS_LEFT_OUT), ...Object.keys(MARKS_USE), ...SECRET_TABLES].filter((t) => !CARRIED.includes(t as never))).toEqual([]);
  });

  test("the carried tables are in order, so a diff shows what a change adds", () => {
    expect([...CARRIED]).toEqual([...CARRIED].sort());
  });

  test("every column that names a sealed value is one the export seals again", () => {
    const sealed = (table: string) => {
      const s = SEALED[table];
      return [...(s?.blob ?? []), ...(s?.base64 ?? []), ...(table === VAULT_ITEMS ? ["sealed"] : [])];
    };
    const unnamed = CARRIED.flatMap((t) => (columns.get(t) ?? []).filter((c) => /seal|secret|token|private/i.test(c) && !sealed(t).includes(c)).map((c) => `${t}.${c}`));
    // Columns whose name says secret and whose value isn't one: a hash, a name, a count or a time.
    expect(unnamed.sort()).toEqual(PLAIN);
  });

  test("the sealed columns and the keys their seals are bound to are the tables' own", () => {
    for (const [table, s] of Object.entries(SEALED)) {
      const have = columns.get(table) ?? [];
      const named = [...s.key, ...(s.blob ?? []), ...(s.base64 ?? []), ...(s.json ?? []).map((j) => j.column)];
      expect({ table, missing: named.filter((c) => !have.includes(c)) }).toEqual({ table, missing: [] });
    }
  });

  test("the schema has only tables and indexes: a trigger or a view would need a place in the import", () => {
    expect(other).toEqual([]);
  });
});

/** Carried as they are, each checked by hand: none holds a secret's value. */
const PLAIN: string[] = [
  // The scope part of a moved item's AAD (`project:<m>/<p>`, `person:<id>`): a name, not a value.
  "vault_items.sealed_scope",
];
