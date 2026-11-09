// The read worker: a read-only connection to hub.sqlite on its own thread, for the reads that take long (the Time
// view's spans and usage over weeks). Its first message names the file; each later one is a query, or a Time read
// answered whole (time/reads.ts), or the Time digests' upkeep (time/upkeep.ts), so its seconds of work run here rather
// than on the hub's event loop.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { ToolError } from "../../shared/errors.ts";
import { answer, type TimeJob } from "../time/reads.ts";
import { upkeep, type UpkeepJob } from "../time/upkeep.ts";

/** A ToolError's fields, as they cross to the main thread (an Error's class doesn't). */
export type WireToolError = { code: ToolError["code"]; message: string; fix?: string; reason?: ToolError["reason"]; personFix?: string };

export type ReadRequest =
  | { id: -1; path: string }
  | { id: number; sql: string; params: SQLQueryBindings[] | Record<string, SQLQueryBindings> }
  | { id: number; time: TimeJob }
  | { id: number; upkeep: UpkeepJob };
export type ReadReply = { id: number; rows: unknown[] } | { id: number; output: unknown } | { id: number; error: string; tool?: WireToolError };

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
    if ("time" in request) {
      postMessage({ id: request.id, output: answer(conn, request.time) } satisfies ReadReply);
      return;
    }
    if ("upkeep" in request) {
      postMessage({ id: request.id, output: upkeep(conn, request.upkeep) } satisfies ReadReply);
      return;
    }
    const query = conn.query<unknown, SQLQueryBindings[]>(request.sql);
    const rows = Array.isArray(request.params) ? query.all(...request.params) : query.all(request.params as never);
    postMessage({ id: request.id, rows } satisfies ReadReply);
  } catch (error) {
    const tool =
      error instanceof ToolError
        ? {
            code: error.code,
            message: error.message,
            ...(error.fix !== undefined ? { fix: error.fix } : {}),
            ...(error.reason !== undefined ? { reason: error.reason } : {}),
            ...(error.personFix !== undefined ? { personFix: error.personFix } : {}),
          }
        : undefined;
    postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error), ...(tool ? { tool } : {}) } satisfies ReadReply);
  }
};
