// The hub's SQLite database, the same file and schema as the Rust hub's (crates/fleetd/src/hub/store/db.rs): one
// connection for writes and short reads, and a read-only one on a worker thread for long reads (the Time view's), so
// they never stall the event loop.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../../gen/migrations.ts";
import { type Drift, migrate } from "./migrations.ts";
import { Reader } from "./reader.ts";

export type Params = SQLQueryBindings[] | Record<string, SQLQueryBindings>;

export class HubDb {
  /** Applied migrations that no longer match what ships (a changed file, or one a newer fleetd ran). */
  readonly drift: Drift[];
  private reader: Reader | undefined;

  private constructor(
    readonly conn: Database,
    /** `<home>/hub.sqlite`; undefined for an in-memory database. */
    readonly path: string | undefined,
  ) {
    // Lets the CLI write keys while the hub runs; a writer waits up to 5 s for the other's lock.
    conn.run("PRAGMA busy_timeout = 5000");
    conn.run("PRAGMA journal_mode = WAL");
    conn.run("PRAGMA synchronous = NORMAL");
    this.drift = migrate(conn, MIGRATIONS);
  }

  /** Opens (creating if needed) `<home>/hub.sqlite` in WAL mode and migrates it. */
  static open(home: string): HubDb {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = join(home, "hub.sqlite");
    return new HubDb(new Database(path, { create: true, strict: true }), path);
  }

  /** A private in-memory database, for tests. */
  static memory(): HubDb {
    return new HubDb(new Database(":memory:", { strict: true }), undefined);
  }

  /** Runs `fn` in one `BEGIN IMMEDIATE` transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(fn: (conn: Database) => T): T {
    return this.conn.transaction(fn).immediate(this.conn);
  }

  /**
   * A long read on a read-only connection of its own, off the event loop. It sees what was committed when it starts
   * (WAL). An in-memory database has no second connection, so it reads on the main one.
   */
  async read<T = Record<string, unknown>>(sql: string, params: Params = []): Promise<T[]> {
    const reader = this.readers();
    return reader ? reader.all<T>(sql, params) : this.all<T>(sql, params);
  }

  /** The read workers, started on first use; none for an in-memory database, whose long reads run on the main one. */
  readers(): Reader | undefined {
    if (!this.path) return undefined;
    this.reader ??= new Reader(this.path);
    return this.reader;
  }

  /** A short read on the main connection. */
  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    const query = this.conn.query<T, SQLQueryBindings[]>(sql);
    return Array.isArray(params) ? query.all(...params) : query.all(params as never);
  }

  close(): void {
    this.reader?.close();
    this.conn.close();
  }
}
