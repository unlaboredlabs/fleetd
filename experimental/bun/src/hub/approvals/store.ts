// The `requests` table (crates/fleetd/src/hub/approvals/store.rs): one row per secret or approval request (`Q<n>` is
// the row's `n`), the record behind the chat item that shows it. Every write goes through `write`, which keeps the
// kind rule.
import type { Database } from "bun:sqlite";
import type {
  GatedRunSpec,
  HumanRequest,
  ProjectRef,
  Purchase,
  RequestKind,
  RequestState,
  SecretRequest,
  SecureInput,
  ToolPermission,
} from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";

/** What a new request holds; the store numbers it and opens it. */
export type NewRequest = {
  projectRef: ProjectRef;
  workstreamId?: string;
  kind: RequestKind;
  text: string;
  secret?: SecretRequest;
  gated?: GatedRunSpec;
  permission?: ToolPermission;
  purchase?: Purchase;
  secureInput?: SecureInput;
  at: string;
  atMs: number;
};

export type RequestFilter = {
  projectRef?: ProjectRef;
  states?: RequestState[];
  kind?: RequestKind;
  limit: number;
};

/** What a request already came to, for a change that finds it settled: "Q1 is already approved", "Q1 already ran". */
export function settled(id: string, state: RequestState): string {
  if (state === "ran") return `${id} already ran`;
  if (state === "failed") return `${id} already ran, and failed`;
  return `${id} is already ${state}`;
}

/** Why a write was refused. */
export class RequestStoreError extends Error {
  constructor(
    readonly kind: "not_found" | "invalid" | "moved",
    readonly id: string,
    message: string,
    /** `moved`: the state someone else moved it to first. */
    readonly now?: RequestState,
  ) {
    super(message);
    this.name = "RequestStoreError";
  }
}

export const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

function nOf(id: string): number | undefined {
  const m = /^Q([1-9][0-9]*)$/.exec(id);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

const KEYS: (keyof HumanRequest)[] = [
  "requestId",
  "projectRef",
  "workstreamId",
  "kind",
  "text",
  "state",
  "secret",
  "gated",
  "permission",
  "purchase",
  "secureInput",
  "evidence",
  "exitCode",
  "outputTail",
  "createdAt",
  "answeredAt",
  "answeredBy",
  "answeredByPerson",
  "finishedAt",
];

/** The request as the Rust hub stores it: its struct's key order, absent fields left out. */
export function canonical(r: HumanRequest): HumanRequest {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out as HumanRequest;
}

const SECRET_STATES: RequestState[] = ["open", "stored", "withdrawn"];
const APPROVAL_STATES: RequestState[] = ["open", "approved", "denied", "ran", "failed"];

/** The contracts' `request_kind_rule`: why `r` is no request a reader accepts, or undefined. */
export function kindRule(r: HumanRequest): string | undefined {
  if (!/^Q[1-9][0-9]*$/.test(r.requestId)) return `${r.requestId} is not a request id`;
  if (typeof r.text !== "string" || [...r.text].length < 1 || [...r.text].length > 500) return "text must be 1 to 500 characters";
  if (r.kind === "secret") {
    if (!r.secret || r.gated || r.permission || r.purchase) return "a secret request has a secret and nothing else";
    if (r.secret.sink.startsWith("fill:") !== (r.secureInput !== undefined)) {
      return "a secret request has a secure input exactly when its sink is fill:";
    }
    if (r.secret.envName !== undefined && !r.secret.sink.startsWith("env:") && !r.secret.sink.startsWith("order:")) {
      return "only an env: or order: sink has an env name";
    }
  } else if (r.kind === "approval") {
    const held = [r.gated, r.permission, r.purchase, r.secureInput].filter((h) => h !== undefined).length;
    if (r.secret || held !== 1) {
      return "an approval has exactly one of a gated run, a tool prompt, a purchase and a secure input";
    }
  } else {
    return `unknown kind ${String(r.kind)}`;
  }
  const allowed = r.kind === "secret" ? SECRET_STATES : APPROVAL_STATES;
  if (!allowed.includes(r.state)) return `a ${r.kind === "secret" ? "Secret" : "Approval"} request is never ${r.state}`;
  return undefined;
}

const kindText = (kind: RequestKind) => (kind === "secret" ? "secret" : "approval");

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
