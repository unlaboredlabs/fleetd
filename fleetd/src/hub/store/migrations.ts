// The Rust hub's migration runner, step for step, over the same files: a
// hub records each migration it ran by name, with the SHA-256 of its file, in `migrations_applied`, and runs every
// one not there. `user_version` still counts them, for an older fleetd opening the file.
import type { Database } from "bun:sqlite";

export type Migration = { name: string; sql: string };

/**
 * The oldest SQLite a hub migrates on. On macOS Bun's SQLite is the system's (fleetd ships none), and the CLI needs
 * macOS 13, whose SQLite is 3.39: this leaves room. CI's fleetd job runs every migration on it
 * (scripts/old-sqlite-check.ts).
 */
export const OLDEST_SQLITE = "3.37.2";

/**
 * The SHA-256 a migration's file had when it shipped, for one rewritten since to run on OLDEST_SQLITE with the same
 * schema and data (W775): a hub that ran it before reads no drift, and nothing runs again.
 */
export const REWRITTEN: Readonly<Record<string, string>> = {
  "202611071205_navis_are_projects": "a80021edeacce256e10454531fadd4f2b7ef9c7865a9ab73f95f40afca167f0a",
  "202611121235_one_team_vault": "c6ec2aedfe2e59bcc314a342183a4d1a3f4839eb91647347224e8ea5e5b0aeec",
};

/** A migration that didn't run, its transaction rolled back: the next start runs it again. */
export class MigrationFailed extends Error {}

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
        try {
          conn.run(next.sql);
        } catch (error) {
          throw failed(conn, next.name, error);
        }
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
    ...migrations
      .filter((m) => ran.has(m.name) && ran.get(m.name) !== sha256(m.sql) && ran.get(m.name) !== REWRITTEN[m.name])
      .map((m) => ({ kind: "changed" as const, name: m.name })),
    ...[...ran.keys()].filter((name) => !known.has(name)).sort().map((name) => ({ kind: "unknown" as const, name })),
  ];
}

/** Names the SQLite found and the one needed rather than SQLite's own words alone. */
function failed(conn: Database, name: string, error: unknown): MigrationFailed {
  const found = (conn.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  return new MigrationFailed(failure(name, found, error instanceof Error ? error.message : String(error)), { cause: error });
}

export function failure(name: string, found: string, why: string): string {
  return olderThan(found, OLDEST_SQLITE)
    ? `the hub's database can't update: migration ${name} needs SQLite ${OLDEST_SQLITE} or newer, and this machine's ` +
        `is ${found} (${why})`
    : `the hub's database can't update: migration ${name} failed on SQLite ${found}, which fleetd supports ` +
        `(${OLDEST_SQLITE} or newer): ${why}`;
}

/** Whether dotted version `a` is older than `b`. */
export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
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
