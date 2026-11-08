// The read worker: a read-only connection to hub.sqlite on its own thread, for the reads that take long (the Time
// view's spans and usage over weeks). Its first message names the file; each later one is a query.
import { Database, type SQLQueryBindings } from "bun:sqlite";

export type ReadRequest =
  | { id: -1; path: string }
  | { id: number; sql: string; params: SQLQueryBindings[] | Record<string, SQLQueryBindings> };
export type ReadReply = { id: number; rows: unknown[] } | { id: number; error: string };

declare const self: Worker;

let conn: Database | undefined;

self.onmessage = (event: MessageEvent<ReadRequest>) => {
  const request = event.data;
  if ("path" in request) {
    conn = new Database(request.path, { readonly: true, strict: true });
    conn.run("PRAGMA busy_timeout = 5000");
    return;
  }
  try {
    if (!conn) throw new Error("no database: the worker's first message names it");
    const query = conn.query<unknown, SQLQueryBindings[]>(request.sql);
    const rows = Array.isArray(request.params) ? query.all(...request.params) : query.all(request.params as never);
    postMessage({ id: request.id, rows } satisfies ReadReply);
  } catch (error) {
    postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies ReadReply);
  }
};
