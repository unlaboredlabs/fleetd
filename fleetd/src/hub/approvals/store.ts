// The `requests` table: one row per secret or approval request (`Q<n>` is
// the row's `n`), the record behind the chat item that shows it. Every write goes through `write`, which keeps the
// kind rule.
import type { Database } from "bun:sqlite";
import type {
  HumanRequest,
  RequestState,
} from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { canonical, kindRule, kindText, type NewRequest, nOf, projectKey, type RequestFilter, RequestStoreError, settled } from "./request.ts";

export { canonical, kindRule, type NewRequest, projectKey, type RequestFilter, RequestStoreError, settled } from "./request.ts";

export class Requests {
  constructor(private readonly db: HubDb) {}

  create(add: NewRequest): HumanRequest {
    const record = (n: number) =>
      canonical({
        requestId: `Q${n}`,
        projectRef: { machineId: add.projectRef.machineId, projectId: add.projectRef.projectId },
        workstreamId: add.workstreamId,
        kind: add.kind,
        text: add.text,
        state: "open",
        secret: add.secret,
        gated: add.gated,
        permission: add.permission,
        purchase: add.purchase,
        secureInput: add.secureInput,
        createdAt: add.at,
      } as HumanRequest);
    // Checked before a number is taken: an invalid request never leaves a row behind.
    const why = kindRule(record(1));
    if (why) throw new RequestStoreError("invalid", "Q0", why);
    return this.db.transaction((c) => {
      const n = Number(
        c
          .query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?, ?, 'open', ?, '{}')")
          .run(projectKey(add.projectRef), kindText(add.kind), add.atMs).lastInsertRowid,
      );
      const request = record(n);
      c.query("UPDATE requests SET data = ? WHERE n = ?").run(JSON.stringify(request), n);
      return request;
    });
  }

  get(id: string): HumanRequest | undefined {
    const n = nOf(id);
    if (n === undefined) return undefined;
    const row = this.db.conn.query<{ data: string }, [number]>("SELECT data FROM requests WHERE n = ?").get(n);
    return row ? (JSON.parse(row.data) as HumanRequest) : undefined;
  }

  /** Newest first. */
  list(filter: RequestFilter): HumanRequest[] {
    const rows = this.db.conn
      .query<{ data: string }, [string | null, string | null, string | null, number]>(
        `SELECT data FROM requests
          WHERE (?1 IS NULL OR project_key = ?1)
            AND (?2 IS NULL OR state IN (SELECT value FROM json_each(?2)))
            AND (?3 IS NULL OR kind = ?3)
          ORDER BY n DESC LIMIT ?4`,
      )
      .all(
        filter.projectRef ? projectKey(filter.projectRef) : null,
        filter.states ? JSON.stringify(filter.states) : null,
        filter.kind ? kindText(filter.kind) : null,
        Math.max(1, Math.min(filter.limit, Number.MAX_SAFE_INTEGER)),
      );
    return rows.map((r) => JSON.parse(r.data) as HumanRequest);
  }

  /** Applies `change` to the stored request and saves it, if the result still holds the kind rule. */
  update(id: string, change: (r: HumanRequest) => void): HumanRequest {
    return this.write(id, undefined, change);
  }

  /**
   * As `update`, only while the request is still `from`: of two answers at once exactly one moves it, and the other
   * gets `moved`. Read and write share one immediate transaction, and the write is guarded by the state.
   */
  updateFrom(id: string, from: RequestState, change: (r: HumanRequest) => void): HumanRequest {
    return this.write(id, from, change);
  }

  private write(id: string, from: RequestState | undefined, change: (r: HumanRequest) => void): HumanRequest {
    const n = nOf(id);
    if (n === undefined) throw new RequestStoreError("not_found", id, `no request ${id}`);
    return this.db.transaction((c: Database) => {
      const row = c.query<{ data: string }, [number]>("SELECT data FROM requests WHERE n = ?").get(n);
      if (!row) throw new RequestStoreError("not_found", id, `no request ${id}`);
      const request = JSON.parse(row.data) as HumanRequest;
      if (from !== undefined && request.state !== from) {
        throw new RequestStoreError("moved", id, settled(id, request.state), request.state);
      }
      const was = request.state;
      change(request);
      // Checked like the Rust decoder, so a write can never store a request no reader accepts.
      const saved = canonical(request);
      const why = kindRule(saved);
      if (why) throw new RequestStoreError("invalid", id, why);
      const changed = c
        .query("UPDATE requests SET state = ?, data = ? WHERE n = ? AND state = ?")
        .run(saved.state, JSON.stringify(saved), n, was).changes;
      if (changed !== 1) throw new RequestStoreError("moved", id, settled(id, request.state), request.state);
      return saved;
    });
  }
}
