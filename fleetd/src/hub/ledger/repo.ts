// Synchronous SQL over the ledger tables. Callers compose these inside one
// write transaction and emit events after the commit; nothing here opens a transaction itself.
import type { Database } from "bun:sqlite";
import type {
  Decision,
  DecisionKey,
  DecisionRetired,
  DecisionScope,
  DecisionSource,
  DecisionState,
  PersonRef,
  ProjectRef,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isoMs } from "../store/time.ts";

const MAX_SAFE_INT = 9007199254740991;

/** Who is writing: filled by the hub from the caller (human device, agent key or lead-side call). */
export type Actor = {
  source: DecisionSource;
  /** "human:<device>", the agent key name, or "lead:<machineId>/<projectId>". */
  by: string;
  /** A human key's person. */
  person?: PersonRef;
};

/** Where a lookup starts: the workstream (when known), then its project, then global. */
export type Chain = { projectRef: ProjectRef; workstreamId?: string };

/** Stable text form of a project ref; machine ids cannot contain "/". */
export const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/** `D12` → 12; undefined for anything that isn't a decision id. */
export function decisionN(id: string): number | undefined {
  if (!/^D\d+$/.test(id)) return undefined;
  const n = Number(id.slice(1));
  return n > 0 && n <= MAX_SAFE_INT ? n : undefined;
}

const STOPWORDS = ["the", "and", "for", "should", "what", "which", "use", "with", "this", "that", "we", "do"];

/** FTS5 query matching any of the words in `text`; undefined when there are none worth matching. */
export function ftsQuery(text: string): string | undefined {
  const words: string[] = [];
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word !== "" && !words.includes(word)) words.push(word);
  }
  const kept = words
    .filter((w) => w.length >= 2 && !STOPWORDS.includes(w))
    .slice(0, 24)
    .map((w) => `"${w}"`);
  return kept.length > 0 ? kept.join(" OR ") : undefined;
}

function scopeColumns(scope: DecisionScope): [kind: string, id: string] {
  switch (scope.kind) {
    case "global":
      return ["global", ""];
    case "project":
      return ["project", projectKey(scope.projectRef)];
    case "workstream":
      return ["workstream", scope.workstreamId];
  }
}

export const decisionStateText = (state: DecisionState) => state;

export type RecordInput = {
  key: DecisionKey;
  scope: DecisionScope;
  value: string;
  why?: string;
  /** The project a workstream-scoped decision belongs to, so project-wide lookups find it. */
  projectRef?: ProjectRef;
};

export type DecisionFilter = {
  /** Global decisions plus everything recorded in this project. */
  chain?: Chain;
  /** Exactly this scope. */
  scope?: DecisionScope;
  source?: DecisionSource;
  /** Recorded at or after this time (ms). */
  sinceMs?: number;
  limit?: number;
};

const decode = (data: string) => JSON.parse(data) as Decision;

/** The Rust struct's field order, so a row reads the same as one the Rust hub wrote. */
function encode(d: Decision): string {
  const out: Record<string, unknown> = { decisionId: d.decisionId, key: d.key, scope: d.scope, value: d.value };
  if (d.why !== undefined) out.why = d.why;
  out.source = d.source;
  if (d.by !== undefined) out.by = d.by;
  if (d.person !== undefined) out.person = d.person;
  if (d.supersedes !== undefined) out.supersedes = d.supersedes;
  out.state = d.state;
  out.at = d.at;
  if (d.retired !== undefined) out.retired = d.retired;
  return JSON.stringify(out);
}

export function getDecision(db: Database, id: string): Decision | undefined {
  const n = decisionN(id);
  if (n === undefined) return undefined;
  const row = db.query<{ data: string }, [number]>("SELECT data FROM decisions WHERE n = ?").get(n);
  return row ? decode(row.data) : undefined;
}

function putDecision(db: Database, n: number, d: Decision): void {
  db.query("UPDATE decisions SET data = ?, state = ? WHERE n = ?").run(encode(d), d.state, n);
}

/** Inserts an active decision, superseding the active one on the same key and scope. */
export function recordDecision(db: Database, input: RecordInput, actor: Actor, nowMs: number): Decision {
  const [kind, id] = scopeColumns(input.scope);
  const previous = db
    .query<{ n: number; data: string }, [string, string, string]>(
      "SELECT n, data FROM decisions WHERE key = ? AND scope_kind = ? AND scope_id = ? AND state = 'active'",
    )
    .get(input.key, kind, id);
  const projectRef =
    input.scope.kind === "project" ? input.scope.projectRef : input.scope.kind === "workstream" ? input.projectRef : undefined;
  const inserted = db
    .query<{ n: number }, [string, string, string, string | null, string, string, number]>(
      `INSERT INTO decisions (key, scope_kind, scope_id, project_key, state, source, at_ms, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, '') RETURNING n`,
    )
    .get(input.key, kind, id, projectRef ? projectKey(projectRef) : null, "active", actor.source, nowMs);
  const n = inserted?.n as number;
  let supersedes: string | undefined;
  if (previous) {
    const old = decode(previous.data);
    putDecision(db, previous.n, { ...old, state: "superseded" });
    supersedes = old.decisionId;
  }
  const decision: Decision = {
    decisionId: `D${n}`,
    key: input.key,
    scope: input.scope,
    value: input.value,
    ...(input.why !== undefined ? { why: input.why } : {}),
    source: actor.source,
    by: actor.by,
    ...(actor.person ? { person: actor.person } : {}),
    ...(supersedes ? { supersedes } : {}),
    state: "active",
    at: isoMs(nowMs),
  };
  putDecision(db, n, decision);
  db.query("INSERT INTO decisions_fts (rowid, key, value, why) VALUES (?, ?, ?, ?)").run(n, input.key, input.value, input.why ?? "");
  return decision;
}

/** `retired`: who took it back and why, for a person's revoke. */
export function retireDecision(db: Database, id: string, retired: DecisionRetired | undefined): Decision {
  const decision = getDecision(db, id);
  if (!decision) throw new ToolError("not_found", `No decision ${id}.`);
  if (decision.state !== "active") {
    throw new ToolError("invalid", `${id} is already ${decision.state}.`, "Forget the decision that replaced it instead.");
  }
  const out: Decision = { ...decision, state: "retired" };
  if (retired) out.retired = retired;
  else delete out.retired;
  putDecision(db, decisionN(id) as number, out);
  return out;
}

/** The decision `id` when it is global or recorded in `projectRef` (project or workstream scope), in any state. */
export function getDecisionIn(db: Database, id: string, projectRef: ProjectRef): Decision | undefined {
  const n = decisionN(id);
  if (n === undefined) return undefined;
  const row = db
    .query<{ data: string }, [number, string]>(
      "SELECT data FROM decisions WHERE n = ? AND (scope_kind = 'global' OR project_key = ?)",
    )
    .get(n, projectKey(projectRef));
  return row ? decode(row.data) : undefined;
}

/** Every decision recorded in the project at project or workstream scope, in any state, newest first. */
export function historyInProject(db: Database, projectRef: ProjectRef, limit: number): Decision[] {
  return db
    .query<{ data: string }, [string, number]>(
      "SELECT data FROM decisions WHERE project_key = ? AND scope_kind IN ('project', 'workstream') ORDER BY n DESC LIMIT ?",
    )
    .all(projectKey(projectRef), limit)
    .map((r) => decode(r.data));
}

function filterParams(filter: DecisionFilter) {
  const scope = filter.scope ? scopeColumns(filter.scope) : undefined;
  return {
    project: filter.chain ? projectKey(filter.chain.projectRef) : null,
    kind: scope?.[0] ?? null,
    id: scope?.[1] ?? null,
  };
}

export function searchDecisions(db: Database, query: string, filter: DecisionFilter): Decision[] {
  const q = ftsQuery(query);
  if (q === undefined) return [];
  return db
    .query<{ data: string }, Record<string, string | number | null>>(
      `SELECT d.data FROM decisions_fts f JOIN decisions d ON d.n = f.rowid
         WHERE decisions_fts MATCH :q AND d.state = 'active'
           AND (:project IS NULL OR d.scope_kind = 'global' OR d.project_key = :project)
           AND (:kind IS NULL OR (d.scope_kind = :kind AND d.scope_id = :id))
         ORDER BY bm25(decisions_fts), d.n DESC LIMIT :limit`,
    )
    .all({ q, ...filterParams(filter), limit: filter.limit ?? 10 })
    .map((r) => decode(r.data));
}

export function listDecisions(db: Database, filter: DecisionFilter): Decision[] {
  return db
    .query<{ data: string }, Record<string, string | number | null>>(
      `SELECT data FROM decisions
         WHERE state = 'active'
           AND (:project IS NULL OR scope_kind = 'global' OR project_key = :project)
           AND (:kind IS NULL OR (scope_kind = :kind AND scope_id = :id))
           AND (:source IS NULL OR source = :source) AND at_ms >= :since
         ORDER BY n DESC LIMIT :limit`,
    )
    .all({
      ...filterParams(filter),
      source: filter.source ?? null,
      since: filter.sinceMs ?? 0,
      limit: filter.limit ?? 50,
    })
    .map((r) => decode(r.data));
}
