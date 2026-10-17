import {
  Ask,
  AskId,
  Batch,
  BatchId,
  Decision,
  DecisionId,
  type DecisionKey,
  type DecisionScope,
  type DecisionSource,
  type ProjectRef,
  type WorkstreamId,
} from "@fleetd/contracts";
import type { DatabaseSync } from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

/** Refusals the ledger returns to its callers; maps one to one onto McpToolError. */
export class LedgerError extends Schema.TaggedError<LedgerError>()("LedgerError", {
  code: Schema.Literals(["not_found", "invalid", "forbidden"]),
  message: Schema.String,
  fix: Schema.optionalKey(Schema.String),
}) {}

export const invalid = (message: string, fix?: string) =>
  new LedgerError(fix === undefined ? { code: "invalid", message } : { code: "invalid", message, fix });
export const notFound = (message: string) => new LedgerError({ code: "not_found", message });

/** Who is writing: filled by the hub from the caller (human device, agent key or lead-side call). */
export interface Actor {
  readonly source: DecisionSource;
  /** "human:<device>", the agent key name, or "lead:<machineId>/<projectId>". */
  readonly by: string;
}

/** Where a lookup starts: the workstream (when known), then its project, then global. */
export interface Chain {
  readonly projectRef: ProjectRef;
  readonly workstreamId?: WorkstreamId;
}

/** Stable text form of a project ref; machine ids cannot contain "/". */
export const projectKey = (ref: ProjectRef) => `${ref.machineId}/${ref.projectId}`;

/** An ask's project column: "" for an unrouted ask, which has no project yet. */
export const askProjectKey = (ref: ProjectRef | undefined) => (ref === undefined ? "" : projectKey(ref));

export const isoAt = (ms: number) => new Date(ms).toISOString();

const scopeColumns = (scope: DecisionScope) => {
  switch (scope.kind) {
    case "global":
      return { kind: "global", id: "" };
    case "project":
      return { kind: "project", id: projectKey(scope.projectRef) };
    case "workstream":
      return { kind: "workstream", id: scope.workstreamId };
  }
};

const decodeDecision = Schema.decodeSync(Schema.fromJsonString(Decision));
const encodeDecision = Schema.encodeSync(Schema.fromJsonString(Decision));
const decodeAsk = Schema.decodeSync(Schema.fromJsonString(Ask));
const encodeAsk = Schema.encodeSync(Schema.fromJsonString(Ask));

const serial = (prefix: string, id: string) => {
  const n = Number(id.slice(prefix.length));
  return id.startsWith(prefix) && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};
export const decisionN = (id: string) => serial("D", id);
export const askN = (id: string) => serial("A", id);
export const batchN = (id: string) => serial("B", id);

const STOPWORDS = new Set(["the", "and", "for", "should", "what", "which", "use", "with", "this", "that", "we", "do"]);

/** FTS5 query matching any of the words in `text`; undefined when there are none worth matching. */
export const ftsQuery = (text: string) => {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (w) => w.length >= 2 && !STOPWORDS.has(w),
  );
  return words.length === 0 ? undefined : words.slice(0, 24).map((w) => `"${w}"`).join(" OR ");
};

export interface RecordInput {
  readonly key: DecisionKey;
  readonly scope: DecisionScope;
  readonly value: string;
  readonly why?: string;
  readonly askId?: AskId;
  /** The project a workstream-scoped decision belongs to, so project-wide lookups find it. */
  readonly projectRef?: ProjectRef;
}

export interface DecisionFilter {
  /** Global decisions plus everything recorded in this project. */
  readonly chain?: Chain;
  /** Exactly this scope. */
  readonly scope?: DecisionScope;
  readonly source?: DecisionSource;
  /** Recorded at or after this time (ms). */
  readonly sinceMs?: number;
  readonly limit?: number;
}

export interface StoredBatch {
  readonly batch: Batch;
  readonly n: number;
  readonly lastAddMs: number | undefined;
  readonly publishedMs: number | undefined;
}

/**
 * Synchronous SQL over the ledger tables. Callers compose these inside `HubDb.transaction` and emit events after
 * the commit; nothing here opens a transaction itself.
 */
const makeRepo = (db: DatabaseSync) => {
  const sql = {
    decisionInsert: db.prepare(
      `INSERT INTO decisions (key, scope_kind, scope_id, project_key, state, source, at_ms, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, '') RETURNING n`,
    ),
    decisionSetData: db.prepare("UPDATE decisions SET data = ?, state = ? WHERE n = ?"),
    decisionGet: db.prepare("SELECT data, project_key FROM decisions WHERE n = ?"),
    decisionActiveSame: db.prepare(
      "SELECT n, data FROM decisions WHERE key = ? AND scope_kind = ? AND scope_id = ? AND state = 'active'",
    ),
    activeOnKey: db.prepare("SELECT data FROM decisions WHERE key = ? AND project_key = ? AND state = 'active' ORDER BY n"),
    ftsInsert: db.prepare("INSERT INTO decisions_fts (rowid, key, value, why) VALUES (?, ?, ?, ?)"),
    resolve: db.prepare(
      `SELECT data FROM decisions
       WHERE key = $key AND state = 'active' AND (
         (scope_kind = 'workstream' AND scope_id = $ws) OR (scope_kind = 'project' AND scope_id = $project)
         OR scope_kind = 'global')
       ORDER BY CASE scope_kind WHEN 'workstream' THEN 0 WHEN 'project' THEN 1 ELSE 2 END LIMIT 1`,
    ),
    search: db.prepare(
      `SELECT d.data FROM decisions_fts f JOIN decisions d ON d.n = f.rowid
       WHERE decisions_fts MATCH $q AND d.state = 'active'
         AND ($project IS NULL OR d.scope_kind = 'global' OR d.project_key = $project)
         AND ($kind IS NULL OR (d.scope_kind = $kind AND d.scope_id = $id))
       ORDER BY bm25(decisions_fts), d.n DESC LIMIT $limit`,
    ),
    list: db.prepare(
      `SELECT data FROM decisions
       WHERE state = 'active'
         AND ($project IS NULL OR scope_kind = 'global' OR project_key = $project)
         AND ($kind IS NULL OR (scope_kind = $kind AND scope_id = $id))
         AND ($source IS NULL OR source = $source) AND at_ms >= $since
       ORDER BY n DESC LIMIT $limit`,
    ),
    askInsert: db.prepare(
      `INSERT INTO asks (project_key, workstream_id, key, state, filed_by, batch_n, created_ms, data)
       VALUES (?, ?, ?, ?, ?, NULL, ?, '') RETURNING n`,
    ),
    askSet: db.prepare("UPDATE asks SET data = ?, state = ?, batch_n = ? WHERE n = ?"),
    askSetKey: db.prepare("UPDATE asks SET key = ? WHERE n = ?"),
    askGet: db.prepare("SELECT data, filed_by FROM asks WHERE n = ?"),
    askOpenSame: db.prepare("SELECT data FROM asks WHERE project_key = ? AND key = ? AND state = 'open' LIMIT 1"),
    askList: db.prepare(
      `SELECT data FROM asks
       WHERE ($state IS NULL OR state = $state) AND ($project IS NULL OR project_key = $project)
         AND ($ws IS NULL OR workstream_id = $ws) AND ($batch IS NULL OR batch_n = $batch)
       ORDER BY batch_n IS NULL, batch_n, json_extract(data, '$.number'), n LIMIT $limit`,
    ),
    batchInsert: db.prepare(
      "INSERT INTO batches (state, created_ms, last_add_ms, published_ms) VALUES ('open', ?, NULL, NULL) RETURNING n",
    ),
    batchGet: db.prepare("SELECT n, state, created_ms, last_add_ms, published_ms FROM batches WHERE n = ?"),
    batchCollecting: db.prepare(
      "SELECT n FROM batches WHERE state = 'open' AND published_ms IS NULL ORDER BY n DESC LIMIT 1",
    ),
    batchLatestOpen: db.prepare(
      "SELECT n FROM batches WHERE state = 'open' ORDER BY published_ms IS NULL, n DESC LIMIT 1",
    ),
    batchList: db.prepare(
      "SELECT n FROM batches WHERE ($state IS NULL OR state = $state) ORDER BY n DESC LIMIT $limit",
    ),
    batchTouch: db.prepare("UPDATE batches SET last_add_ms = ? WHERE n = ?"),
    batchPublish: db.prepare("UPDATE batches SET published_ms = ? WHERE n = ? AND published_ms IS NULL"),
    batchClose: db.prepare("UPDATE batches SET state = 'closed' WHERE n = ?"),
    itemInsert: db.prepare("INSERT INTO batch_items (batch_n, number, ask_n) VALUES (?, ?, ?)"),
    itemNext: db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM batch_items WHERE batch_n = ?"),
    items: db.prepare("SELECT number, ask_n FROM batch_items WHERE batch_n = ? ORDER BY number"),
  };

  const getDecision = (id: string): Decision | undefined => {
    const n = decisionN(id);
    const row = n === undefined ? undefined : sql.decisionGet.get(n);
    return row ? decodeDecision(String(row.data)) : undefined;
  };

  const putDecision = (n: number, decision: Decision) => sql.decisionSetData.run(encodeDecision(decision), decision.state, n);

  /** Inserts an active decision, superseding the active one on the same key and scope. */
  const recordDecision = (input: RecordInput, actor: Actor, nowMs: number): Decision => {
    const scope = scopeColumns(input.scope);
    const previous = sql.decisionActiveSame.get(input.key, scope.kind, scope.id);
    const projectRef =
      input.scope.kind === "project" ? input.scope.projectRef : input.scope.kind === "workstream" ? input.projectRef : undefined;
    const n = Number(
      sql.decisionInsert.get(
        input.key,
        scope.kind,
        scope.id,
        projectRef ? projectKey(projectRef) : null,
        "active",
        actor.source,
        nowMs,
      )?.n,
    );
    let supersedes: DecisionId | undefined;
    if (previous) {
      const old = decodeDecision(String(previous.data));
      putDecision(Number(previous.n), { ...old, state: "superseded" });
      supersedes = old.decisionId;
    }
    const decision: Decision = {
      decisionId: DecisionId.make(`D${n}`),
      key: input.key,
      scope: input.scope,
      value: input.value,
      ...(input.why === undefined ? {} : { why: input.why }),
      source: actor.source,
      by: actor.by,
      ...(input.askId === undefined ? {} : { askId: input.askId }),
      ...(supersedes === undefined ? {} : { supersedes }),
      state: "active",
      at: isoAt(nowMs),
    };
    putDecision(n, decision);
    sql.ftsInsert.run(n, input.key, input.value, input.why ?? "");
    return decision;
  };

  const retireDecision = (id: string): Decision => {
    const decision = getDecision(id);
    if (decision === undefined) throw notFound(`No decision ${id}.`);
    if (decision.state !== "active") {
      throw invalid(`${id} is already ${decision.state}.`, "Forget the decision that replaced it instead.");
    }
    const retired: Decision = { ...decision, state: "retired" };
    putDecision(decisionN(id)!, retired);
    return retired;
  };

  const resolve = (key: string, chain: Chain): Decision | undefined => {
    const row = sql.resolve.get({ key, ws: chain.workstreamId ?? null, project: projectKey(chain.projectRef) });
    return row ? decodeDecision(String(row.data)) : undefined;
  };

  /** Active decisions on `key` recorded in the project, at project or workstream scope, oldest first. */
  const activeOnKey = (key: string, projectRef: ProjectRef): Array<Decision> =>
    sql.activeOnKey.all(key, projectKey(projectRef)).map((row) => decodeDecision(String(row.data)));

  const filterParams = (filter: { chain?: Chain; scope?: DecisionScope }) => {
    const scope = filter.scope ? scopeColumns(filter.scope) : undefined;
    return {
      project: filter.chain ? projectKey(filter.chain.projectRef) : null,
      kind: scope?.kind ?? null,
      id: scope?.id ?? null,
    };
  };

  const searchDecisions = (query: string, filter: DecisionFilter): Array<Decision> => {
    const q = ftsQuery(query);
    if (q === undefined) return [];
    return sql.search
      .all({ q, ...filterParams(filter), limit: filter.limit ?? 10 })
      .map((row) => decodeDecision(String(row.data)));
  };

  const listDecisions = (filter: DecisionFilter): Array<Decision> =>
    sql.list
      .all({ ...filterParams(filter), source: filter.source ?? null, since: filter.sinceMs ?? 0, limit: filter.limit ?? 50 })
      .map((row) => decodeDecision(String(row.data)));

  const getAskRow = (id: string) => {
    const n = askN(id);
    const row = n === undefined ? undefined : sql.askGet.get(n);
    return row && n !== undefined ? { n, ask: decodeAsk(String(row.data)), filedBy: String(row.filed_by) } : undefined;
  };

  const putAsk = (ask: Ask) =>
    sql.askSet.run(encodeAsk(ask), ask.state, ask.batchId === undefined ? null : batchN(ask.batchId)!, askN(ask.askId)!);

  /**
   * Inserts an ask; `build` receives the new id and returns the record to store. The key column follows the built
   * ask's key, for asks whose key names their own id (`gated.a7`).
   */
  const insertAsk = (projectRef: ProjectRef | undefined, key: string, workstreamId: string | undefined, filedBy: string, nowMs: number, build: (askId: AskId) => Ask): Ask => {
    const n = Number(sql.askInsert.get(askProjectKey(projectRef), workstreamId ?? null, key, "open", filedBy, nowMs)?.n);
    const ask = build(AskId.make(`A${n}`));
    if (ask.key !== key) sql.askSetKey.run(ask.key, n);
    putAsk(ask);
    return ask;
  };

  const openAskWithKey = (projectRef: ProjectRef | undefined, key: string): Ask | undefined => {
    const row = sql.askOpenSame.get(askProjectKey(projectRef), key);
    return row ? decodeAsk(String(row.data)) : undefined;
  };

  const listAsks = (filter: {
    readonly state?: string;
    readonly projectRef?: ProjectRef;
    readonly workstreamId?: string;
    readonly batchId?: string;
    readonly limit?: number;
  }): Array<Ask> =>
    sql.askList
      .all({
        state: filter.state ?? null,
        project: filter.projectRef ? projectKey(filter.projectRef) : null,
        ws: filter.workstreamId ?? null,
        batch: filter.batchId === undefined ? null : (batchN(filter.batchId) ?? -1),
        limit: filter.limit ?? 100,
      })
      .map((row) => decodeAsk(String(row.data)));

  const getBatch = (n: number): StoredBatch | undefined => {
    const row = sql.batchGet.get(n);
    if (!row) return undefined;
    const items = sql.items.all(n).map((item) => ({
      number: Number(item.number),
      askId: AskId.make(`A${Number(item.ask_n)}`),
    }));
    return {
      n,
      batch: {
        batchId: BatchId.make(`B${n}`),
        createdAt: isoAt(Number(row.created_ms)),
        items,
        state: row.state === "closed" ? "closed" : "open",
      },
      lastAddMs: row.last_add_ms === null ? undefined : Number(row.last_add_ms),
      publishedMs: row.published_ms === null ? undefined : Number(row.published_ms),
    };
  };

  const collectingBatch = () => {
    const row = sql.batchCollecting.get();
    return row ? getBatch(Number(row.n)) : undefined;
  };

  /** Gives `ask` the next number in batch `n`; `quiet` (a new ask) restarts the batch's quiet window. */
  const placeIn = (n: number, ask: Ask, nowMs: number, quiet: boolean): { ask: Ask; batch: StoredBatch } => {
    const number = Number(sql.itemNext.get(n)?.next);
    sql.itemInsert.run(n, number, askN(ask.askId)!);
    if (quiet) sql.batchTouch.run(nowMs, n);
    const placed: Ask = { ...ask, batchId: BatchId.make(`B${n}`), number };
    putAsk(placed);
    return { ask: placed, batch: getBatch(n)! };
  };

  const newBatch = (nowMs: number) => Number(sql.batchInsert.get(nowMs)?.n);

  /** A new ask joins the collecting batch, creating it if needed. */
  const addToCollecting = (ask: Ask, nowMs: number) => placeIn(collectingBatch()?.n ?? newBatch(nowMs), ask, nowMs, true);

  /**
   * "later": the ask leaves `fromBatch` (whose item list keeps it, numbers never change) for the collecting batch.
   * It does not start the quiet window, so it is shown again with the next new ask rather than 30 s from now.
   */
  const moveToLaterBatch = (ask: Ask, fromBatch: number, nowMs: number): Ask => {
    const collecting = collectingBatch();
    const n = collecting && collecting.n !== fromBatch ? collecting.n : newBatch(nowMs);
    return placeIn(n, ask, nowMs, false).ask;
  };

  /** True when it was still unpublished. */
  const publishBatch = (n: number, nowMs: number) => sql.batchPublish.run(nowMs, n).changes > 0;

  /** Closes the batch once no item is still open in it (answered, withdrawn, or moved to a later batch). */
  const closeIfDone = (n: number): boolean => {
    const stored = getBatch(n);
    if (!stored || stored.batch.state === "closed") return false;
    const stillOpen = stored.batch.items.some((item) => {
      const ask = getAskRow(item.askId)?.ask;
      return ask !== undefined && ask.state === "open" && ask.batchId === stored.batch.batchId;
    });
    if (stillOpen) return false;
    sql.batchClose.run(n);
    return true;
  };

  /** Latest open batch the human has been shown; the collecting one only when none was published. */
  const latestOpenBatch = () => {
    const row = sql.batchLatestOpen.get();
    return row ? getBatch(Number(row.n)) : undefined;
  };

  const listBatches = (filter: { readonly state?: string; readonly limit?: number }) =>
    sql.batchList
      .all({ state: filter.state ?? null, limit: filter.limit ?? 20 })
      .map((row) => getBatch(Number(row.n))!);

  return {
    db,
    getDecision,
    recordDecision,
    retireDecision,
    resolve,
    activeOnKey,
    searchDecisions,
    listDecisions,
    getAskRow,
    putAsk,
    insertAsk,
    openAskWithKey,
    listAsks,
    getBatch,
    collectingBatch,
    addToCollecting,
    moveToLaterBatch,
    publishBatch,
    closeIfDone,
    latestOpenBatch,
    listBatches,
  };
};

export type Repo = ReturnType<typeof makeRepo>;

/** Internal: the ledger's prepared statements over the hub database. */
export class LedgerRepo extends Context.Service<LedgerRepo, Repo>()("fleetd/ledger/LedgerRepo") {}

export const layer = Layer.effect(
  LedgerRepo,
  Effect.gen(function* () {
    return makeRepo((yield* HubDb.HubDb).db);
  }),
);

/**
 * Runs `fn` in one write transaction. A thrown LedgerError rolls everything back and becomes the failure; any
 * other throw is a defect.
 */
export const write = <A>(repo: Repo, fn: () => A): Effect.Effect<A, LedgerError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(HubDb.transaction(repo.db, fn));
    } catch (error) {
      if (error instanceof LedgerError) return Effect.fail(error);
      return Effect.die(error);
    }
  });
