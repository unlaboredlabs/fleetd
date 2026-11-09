// The Rust hub's migration runner, step for step, over the same files: a
// hub records each migration it ran by name, with the SHA-256 of its file, in `migrations_applied`, and runs every
// one not there. `user_version` still counts them, for an older fleetd opening the file.
import type { Database } from "bun:sqlite";

export type Migration = { name: string; sql: string };

/** `changed`: its file changed after it ran. `unknown`: no file of this build has its name. */
export type Drift = { kind: "changed" | "unknown"; name: string };

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

export function migrate(conn: Database, migrations: readonly Migration[]): Drift[] {
  conn.transaction(() => {
    const tracked = conn
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations_applied'")
      .get();
    if (tracked) return;
    conn.run("CREATE TABLE migrations_applied (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL) WITHOUT ROWID");
    // A database from before names counted its migrations in user_version: the first that many ran.
    for (const m of migrations.slice(0, userVersion(conn))) record(conn, m);
  }).immediate();
  for (;;) {
    // Read inside the lock each time: another process may have migrated while we waited.
    const done = conn
      .transaction(() => {
        const ran = applied(conn);
        const next = migrations.find((m) => !ran.has(m.name));
        if (!next) return drift(ran, migrations);
        if (next.sql.includes("DROP TABLE profile_settings")) logDroppedOverrides(conn);
        conn.run(next.sql);
        record(conn, next);
        conn.run(`PRAGMA user_version = ${ran.size + 1}`);
        return undefined;
      })
      .immediate();
    if (done) return done;
  }
}

export function userVersion(conn: Database): number {
  return (conn.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function record(conn: Database, m: Migration) {
  conn.query("INSERT INTO migrations_applied (name, sha256) VALUES (?, ?)").run(m.name, sha256(m.sql));
}

function applied(conn: Database): Map<string, string> {
  const rows = conn.query("SELECT name, sha256 FROM migrations_applied").all() as { name: string; sha256: string }[];
  return new Map(rows.map((r) => [r.name, r.sha256]));
}

function drift(ran: Map<string, string>, migrations: readonly Migration[]): Drift[] {
  const known = new Set(migrations.map((m) => m.name));
  return [
    ...migrations.filter((m) => ran.has(m.name) && ran.get(m.name) !== sha256(m.sql)).map((m) => ({ kind: "changed" as const, name: m.name })),
    ...[...ran.keys()].filter((name) => !known.has(name)).sort().map((name) => ({ kind: "unknown" as const, name })),
  ];
}

/** Profiles became rows (W146): one line for each project's model or effort override the migration drops. */
function logDroppedOverrides(conn: Database) {
  const rows = conn
    .query(
      `SELECT machine_id, project_id, profile, model, effort FROM profile_settings WHERE project_id != ''
       ORDER BY machine_id, project_id, profile`,
    )
    .all() as { machine_id: string; project_id: string; profile: string; model: string | null; effort: string | null }[];
  for (const r of rows) {
    console.warn(
      `profiles: a project's override of a profile is dropped; make a profile of it and allow it in the project ` +
        `project=${r.machine_id}/${r.project_id} profile=${r.profile} model=${r.model ?? "-"} effort=${r.effort ?? "-"}`,
    );
  }
}
