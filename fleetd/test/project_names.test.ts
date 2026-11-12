// The D317 renames: a hub from before them upgrades in place with what it kept under the old names now under the
// project's, and a session pinned to a renamed prompt keeps its text (the import of an older export: transfer.test.ts).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { tempHome } from "./helpers.ts";
import { expectRenamed, RENAMES_AT, seedOld, SQL } from "./project_names_kit.ts";

test("a hub from before the renames upgrades in place: every row under the project's names, nothing lost", () => {
  const home = tempHome();
  try {
    const conn = new Database(join(home.dir, "hub.sqlite"), { create: true, strict: true });
    seedOld(conn);
    conn.close();
    const db = HubDb.open(home.dir);
    expect(db.drift).toEqual([]);
    expectRenamed(db);
    db.conn.close();
  } finally {
    home.done();
  }
});

test("a session pinned to a renamed prompt keeps its text under the new id", () => {
  const home = tempHome();
  try {
    const conn = new Database(join(home.dir, "hub.sqlite"), { create: true, strict: true });
    migrate(conn, MIGRATIONS.slice(0, RENAMES_AT));
    // The old id, from the migration's own list.
    const oldStart = /\('([^']+)', 'assistant\.start'\)/.exec(SQL)![1]!;
    conn.run(`INSERT INTO prompt_versions (ref, text) VALUES ('${oldStart}@0123456789', 'You are {{project}}.')`);
    const refs = [{ id: oldStart, ref: `${oldStart}@0123456789`, scope: "global" }];
    conn.run(
      `INSERT INTO session_prompts (machine_id, thread_id, project_id, started_at, refs, text_sha, text) VALUES ('devbox', 't1', 'ada', '', '${JSON.stringify(refs)}', '', '')`,
    );
    conn.close();
    const db = HubDb.open(home.dir);
    expect(db.all("SELECT ref, text FROM prompt_versions WHERE ref LIKE '%@0123456789'")).toEqual([{ ref: "assistant.start@0123456789", text: "You are {{project}}." }]);
    expect(JSON.parse(db.all<{ refs: string }>("SELECT refs FROM session_prompts")[0]!.refs)).toEqual([
      { id: "assistant.start", ref: "assistant.start@0123456789", scope: "global" },
    ]);
    db.conn.close();
  } finally {
    home.done();
  }
});
