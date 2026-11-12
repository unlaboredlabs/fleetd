// A hub from before the D317 renames, for the tests of its upgrade in place and of an import of its export. The old
// names live only in the migration, so this reads them from it.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { join } from "node:path";
import type { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { tablePartPath } from "../src/hub/transfer/format.ts";
import { exportOf, type Place, rewritten } from "./transfer-kit.ts";

export const RENAMES_AT = MIGRATIONS.findIndex((m) => m.name.endsWith("_project_names"));
export const SQL = MIGRATIONS[RENAMES_AT]!.sql;
/** Each renamed table's old name, by its new one. */
export const oldTable = (now: string) => [...SQL.matchAll(/ALTER TABLE (\w+) RENAME TO (\w+);/g)].find((m) => m[2] === now)![1]!;
/** The old value the migration renames to `now`: the last literal of its statement's WHERE. */
const oldValue = (now: string) => new RegExp(`'${now.replace(".", "\\.")}'\\)?\\s+WHERE[^;]*'([^']+)';`).exec(SQL)![1]!;

/** The tables the migration renames, by their new names. */
export const RENAMED_TABLES = ["project_asks", "project_ask_orders", "project_sites", "project_approvals", "project_auto_approved", "project_erases"] as const;

/** A hub at the migration before the renames, with a row in each place an old name was kept. */
export function seedOld(conn: Database): void {
  migrate(conn, MIGRATIONS.slice(0, RENAMES_AT));
  const r = "'devbox', 'ada'";
  conn.run(`INSERT INTO ${oldTable("project_asks")} (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms) VALUES (${r}, 'devbox', 'shop', 'gift cards', 1)`);
  conn.run(`INSERT INTO ${oldTable("project_ask_orders")} (workstream_id, n) VALUES ('W1', 1)`);
  conn.run(`INSERT INTO ${oldTable("project_sites")} (machine_id, project_id, site, allowed_ms, allowed_by) VALUES (${r}, 'example.org', 1, 'human:desk')`);
  conn.run(`INSERT INTO ${oldTable("project_approvals")} (machine_id, project_id, mode) VALUES (${r}, 'yolo')`);
  conn.run(`INSERT INTO ${oldTable("project_auto_approved")} (machine_id, project_id, at_ms, data) VALUES (${r}, 1, '{}')`);
  conn.run(`INSERT INTO ${oldTable("project_erases")} (machine_id, project_id, asked_ms) VALUES ('devbox', 'gone', 1)`);
  conn.run(`INSERT INTO time_cursors (source, value) VALUES ('${oldValue("project.bridge")}', 42)`);
  const secret = { requestId: "R1", kind: "secret", secret: { key: oldValue("browser.secure_input"), sink: "fill:devbox:s1" } };
  conn.run(`INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES ('devbox/ada', 'secret', 'open', 1, '${JSON.stringify(secret)}')`);
  const summary = { machineId: "devbox", projectId: "ada", title: "Ada", workspaceRoot: "/home/me/ada", kind: "assistant", lastActivityAt: "2026-11-01T00:00:00Z" };
  conn.run(`INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (${r}, 'ada', '2026-11-01T00:00:00Z', '${JSON.stringify(summary)}')`);
}

/** What the seeded rows are once the migration ran: each where its new name says, nothing lost. */
export function expectRenamed(db: HubDb): void {
  const count = (table: string) => db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;
  for (const table of RENAMED_TABLES) {
    expect([table, count(table)]).toEqual([table, 1]);
    expect(db.all("SELECT name FROM sqlite_master WHERE name = ?", [oldTable(table)])).toEqual([]);
  }
  expect(db.all("SELECT source, value FROM time_cursors WHERE value = 42")).toEqual([{ source: "project.bridge", value: 42 }]);
  expect(JSON.parse(db.all<{ data: string }>("SELECT data FROM requests WHERE kind = 'secret'")[0]!.data).secret).toEqual({ key: "browser.secure_input", sink: "fill:devbox:s1" });
  expect(JSON.parse(db.all<{ data: string }>("SELECT data FROM projects WHERE project_id = 'ada'")[0]!.data)).not.toHaveProperty("kind");
}


/**
 * The export a fleetd from before the renames would have written of the hub on `from` (its database at an older
 * migration): this fleetd writes only tables it knows, so the renamed ones go out under their new names and the file
 * is given the old names back. Its path.
 */
export async function olderExportOf(from: Place): Promise<string> {
  const conn = new Database(join(from.home, "hub.sqlite"), { strict: true });
  const there = (name: string) => conn.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  const renamed: string[] = RENAMED_TABLES.filter((now) => there(oldTable(now)));
  for (const now of renamed) conn.run(`ALTER TABLE ${oldTable(now)} RENAME TO ${now}`);
  conn.close();
  const file = join(from.dir, "older-export.tar");
  await exportOf(from, { secrets: false, file: join(from.dir, "older-export.new.tar") });
  await rewritten(join(from.dir, "older-export.new.tar"), file, {
    manifest: (m) => {
      for (const t of m.tables) {
        if (!renamed.includes(t.name)) continue;
        t.name = oldTable(t.name);
        t.parts = t.parts.map((part, i) => ({ ...part, path: tablePartPath(t.name, i + 1) }));
      }
    },
    path: (path) => renamed.reduce((p, now) => p.replace(`tables/${now}/`, `tables/${oldTable(now)}/`), path),
  });
  return file;
}
