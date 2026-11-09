// The metrics tables (crates/fleetd/src/hub/metrics/store.rs): landed changes (idempotent on `(repo, unit_key)`), when
// each Change passed review, each repo's read state, the person's touches and identities, retention. Writes run
// inside the caller's transaction; the same SQL as Rust.
import type { Database } from "bun:sqlite";
import { ROLLUP_DAYS } from "../time/store.ts";

/** Landed changes and touches outlive the event log and spans: as long as the time roll-ups. */
export const DEFAULT_RETENTION_DAYS = ROLLUP_DAYS;
export const PRUNE_BATCH = 5_000;
export const DAY_MS = 86_400_000;
const RETENTION_KEY = "metrics_retention_days";
/** In `time_cursors`: the event log's oldest event when the projector first ran. Merges are known from there on. */
export const KNOWN_SINCE = "metrics:known_since";
export const SKIPPED = "skipped";

/** The repo key of a train's GitHub repo ("acme/web"): its remote, host first ("github.com/acme/web"). */
export const githubRemote = (repo: string) => `github.com/${repo.toLowerCase()}`;

/** The train's repo of a GitHub remote, the inverse of `githubRemote`. */
export const trainRepo = (remote: string) => (remote.startsWith("github.com/") ? remote.slice("github.com/".length) : undefined);

export function retentionDays(c: Database): number {
  const row = c.query<{ value: number }, [string]>("SELECT value FROM time_settings WHERE key = ?1").get(RETENTION_KEY);
  return row?.value ?? DEFAULT_RETENTION_DAYS;
}

/** Deletes up to PRUNE_BATCH landed changes and touches older than the retention; true when there may be more. */
export function prune(c: Database, nowMs: number): boolean {
  const cutoff = nowMs - retentionDays(c) * DAY_MS;
  const merges = c
    .query(
      `DELETE FROM metric_merges WHERE (repo, unit_key) IN
         (SELECT repo, unit_key FROM metric_merges WHERE merged_ms < ?1 ORDER BY merged_ms LIMIT ?2)`,
    )
    .run(cutoff, PRUNE_BATCH).changes;
  const touches = c
    .query("DELETE FROM metric_touches WHERE id IN (SELECT id FROM metric_touches WHERE at_ms < ?1 ORDER BY at_ms LIMIT ?2)")
    .run(cutoff, PRUNE_BATCH).changes;
  // A Change's stamp is read when it lands; one older than the retention would land outside every range.
  c.query("DELETE FROM metric_changes WHERE review_passed_ms < ?1").run(cutoff);
  return merges === PRUNE_BATCH || touches === PRUNE_BATCH;
}

/** One landed change (or a skipped merge). Absent fields leave a stored value as it is. */
export type MergeRow = {
  repo: string;
  unitKey: string;
  machineId?: string;
  projectId?: string;
  prNumber?: number;
  mergedMs: number;
  mergedSha?: string;
  /** A MergeRoute, or "skipped" with `skipWhy`. */
  route: string;
  skipWhy?: string;
  workstreamId?: string;
  taskId?: string;
  changeId?: string;
  batchPr?: number;
  requestedMs?: number;
  requestedBasis?: string;
  prCreatedMs?: number;
  firstPrMs?: number;
  reviewPassedMs?: number;
  authorKind?: string;
  mergedByKind?: string;
  additions?: number;
  deletions?: number;
  title?: string;
  url?: string;
  seenClaim?: string;
  src: string;
  /** The merger's login on the git host, for the merge-by-hand touch. Not stored; reads give none. */
  mergedBy?: string;
};

const MERGE_COLUMNS = `repo, unit_key, machine_id, project_id, pr_number, merged_ms, merged_sha, route, skip_why,
  workstream_id, task_id, change_id, batch_pr, requested_ms, requested_basis, pr_created_ms, first_pr_ms,
  review_passed_ms, author_kind, merged_by_kind, additions, deletions, title, url, seen_claim, src`;

const UPSERT_MERGE = `INSERT INTO metric_merges (${MERGE_COLUMNS})
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
 ON CONFLICT(repo, unit_key) DO UPDATE SET
   route = CASE WHEN metric_merges.route = 'train' THEN 'train' ELSE excluded.route END,
   skip_why = CASE WHEN metric_merges.route = 'train' THEN NULL ELSE excluded.skip_why END,
   merged_ms = CASE WHEN metric_merges.route = 'train' AND excluded.route <> 'train' THEN metric_merges.merged_ms
     ELSE excluded.merged_ms END,
   machine_id = COALESCE(excluded.machine_id, machine_id),
   project_id = COALESCE(excluded.project_id, project_id),
   pr_number = COALESCE(excluded.pr_number, pr_number),
   merged_sha = COALESCE(excluded.merged_sha, merged_sha),
   workstream_id = COALESCE(excluded.workstream_id, workstream_id),
   task_id = COALESCE(excluded.task_id, task_id),
   change_id = COALESCE(excluded.change_id, change_id),
   batch_pr = COALESCE(excluded.batch_pr, batch_pr),
   requested_ms = COALESCE(excluded.requested_ms, requested_ms),
   requested_basis = COALESCE(excluded.requested_basis, requested_basis),
   pr_created_ms = COALESCE(excluded.pr_created_ms, pr_created_ms),
   first_pr_ms = COALESCE(excluded.first_pr_ms, first_pr_ms),
   review_passed_ms = COALESCE(excluded.review_passed_ms, review_passed_ms),
   author_kind = COALESCE(excluded.author_kind, author_kind),
   merged_by_kind = CASE WHEN metric_merges.route = 'train' THEN metric_merges.merged_by_kind
     ELSE COALESCE(excluded.merged_by_kind, merged_by_kind) END,
   additions = COALESCE(excluded.additions, additions),
   deletions = COALESCE(excluded.deletions, deletions),
   title = COALESCE(excluded.title, title),
   url = COALESCE(excluded.url, url),
   seen_claim = COALESCE(excluded.seen_claim, seen_claim),
   src = excluded.src`;

const n = <T>(v: T | undefined): T | null => v ?? null;

/** Writes a landed change. The train's word is final; other fields fill in, a later report's value winning. */
export function upsertMerge(c: Database, m: MergeRow): void {
  c.query(UPSERT_MERGE).run(
    m.repo,
    m.unitKey,
    n(m.machineId),
    n(m.projectId),
    n(m.prNumber),
    m.mergedMs,
    n(m.mergedSha),
    m.route,
    n(m.skipWhy),
    n(m.workstreamId),
    n(m.taskId),
    n(m.changeId),
    n(m.batchPr),
    n(m.requestedMs),
    n(m.requestedBasis),
    n(m.prCreatedMs),
    n(m.firstPrMs),
    n(m.reviewPassedMs),
    n(m.authorKind),
    n(m.mergedByKind),
    n(m.additions),
    n(m.deletions),
    n(m.title),
    n(m.url),
    n(m.seenClaim),
    m.src,
  );
}

/** A repo the metrics read, created on first sight. */
export function seeRepo(c: Database, repo: string, host: string): void {
  c.query("INSERT OR IGNORE INTO metric_repos (repo, host) VALUES (?1, ?2)").run(repo, host);
}

/** When a Change first passed review: the earliest kept. A Change that already landed takes it too. */
export function stampReview(c: Database, changeId: string, atMs: number): void {
  c.query(
    `INSERT INTO metric_changes (change_id, review_passed_ms) VALUES (?1, ?2)
     ON CONFLICT(change_id) DO UPDATE SET review_passed_ms = MIN(review_passed_ms, excluded.review_passed_ms)`,
  ).run(changeId, atMs);
  c.query(
    `UPDATE metric_merges SET review_passed_ms = (SELECT review_passed_ms FROM metric_changes WHERE change_id = ?1)
     WHERE change_id = ?1 AND review_passed_ms IS NULL`,
  ).run(changeId);
}

export function reviewPassed(c: Database, changeId: string): number | undefined {
  return (
    c.query<{ v: number | null }, [string]>("SELECT review_passed_ms AS v FROM metric_changes WHERE change_id = ?1").get(changeId)?.v ??
    undefined
  );
}

/** Gives an order's landed changes its request time once it is known. */
export function setRequested(c: Database, workstreamId: string, atMs: number, basis: string): void {
  c.query(
    `UPDATE metric_merges SET requested_ms = ?2, requested_basis = ?3
     WHERE workstream_id = ?1 AND requested_ms IS NULL`,
  ).run(workstreamId, atMs, basis);
}

type MergeSql = {
  repo: string;
  unit_key: string;
  machine_id: string | null;
  project_id: string | null;
  pr_number: number | null;
  merged_ms: number;
  merged_sha: string | null;
  route: string;
  skip_why: string | null;
  workstream_id: string | null;
  task_id: string | null;
  change_id: string | null;
  batch_pr: number | null;
  requested_ms: number | null;
  requested_basis: string | null;
  pr_created_ms: number | null;
  first_pr_ms: number | null;
  review_passed_ms: number | null;
  author_kind: string | null;
  merged_by_kind: string | null;
  additions: number | null;
  deletions: number | null;
  title: string | null;
  url: string | null;
  seen_claim: string | null;
  src: string;
};

/** Every stored row with `merged_ms` in `[since, until)`, in `repos` when given: the SQL and its parameters. */
export function mergesSql(sinceMs: number, untilMs: number, repos?: string[]): [string, (string | number | null)[]] {
  return [
    `SELECT ${MERGE_COLUMNS} FROM metric_merges
     WHERE merged_ms >= ?1 AND merged_ms < ?2 AND (?3 IS NULL OR repo IN (SELECT value FROM json_each(?3)))
     ORDER BY merged_ms DESC, repo, unit_key`,
    [sinceMs, untilMs, repos === undefined ? null : JSON.stringify(repos)],
  ];
}

/** A row as read; NULL columns are absent. */
export function mergeOf(r: MergeSql): MergeRow {
  const m: MergeRow = { repo: r.repo, unitKey: r.unit_key, mergedMs: r.merged_ms, route: r.route, src: r.src };
  const opt = <K extends keyof MergeRow>(k: K, v: MergeRow[K] | null) => {
    if (v !== null) m[k] = v;
  };
  opt("machineId", r.machine_id);
  opt("projectId", r.project_id);
  opt("prNumber", r.pr_number);
  opt("mergedSha", r.merged_sha);
  opt("skipWhy", r.skip_why);
  opt("workstreamId", r.workstream_id);
  opt("taskId", r.task_id);
  opt("changeId", r.change_id);
  opt("batchPr", r.batch_pr);
  opt("requestedMs", r.requested_ms);
  opt("requestedBasis", r.requested_basis);
  opt("prCreatedMs", r.pr_created_ms);
  opt("firstPrMs", r.first_pr_ms);
  opt("reviewPassedMs", r.review_passed_ms);
  opt("authorKind", r.author_kind);
  opt("mergedByKind", r.merged_by_kind);
  opt("additions", r.additions);
  opt("deletions", r.deletions);
  opt("title", r.title);
  opt("url", r.url);
  opt("seenClaim", r.seen_claim);
  return m;
}

/**
 * A read for the worker that answers in one JSON text, `[[col, …], …]`, in the order `sql` gives: one string crosses
 * threads at a fraction of the cost of cloning every row object (a 2,500-row read: 4.9 ms against 11.4).
 */
export function asJson(sql: string, columns: string): string {
  return `SELECT json_group_array(json_array(${columns})) AS j FROM (${sql})`;
}

/** The rows of an `asJson` read, each its columns' values in order. */
export const fromJson = (answer: { j: string }[]): unknown[][] => JSON.parse(answer[0]?.j ?? "[]") as unknown[][];

/** A row of MERGE_COLUMN_LIST's values, as `mergeOf` reads the same columns by name. */
export function mergeOfValues(v: unknown[]): MergeRow {
  const m: MergeRow = { repo: v[0] as string, unitKey: v[1] as string, mergedMs: v[5] as number, route: v[7] as string, src: v[25] as string };
  const keys: [number, keyof MergeRow][] = [
    [2, "machineId"], [3, "projectId"], [4, "prNumber"], [6, "mergedSha"], [8, "skipWhy"], [9, "workstreamId"], [10, "taskId"],
    [11, "changeId"], [12, "batchPr"], [13, "requestedMs"], [14, "requestedBasis"], [15, "prCreatedMs"], [16, "firstPrMs"],
    [17, "reviewPassedMs"], [18, "authorKind"], [19, "mergedByKind"], [20, "additions"], [21, "deletions"], [22, "title"],
    [23, "url"], [24, "seenClaim"],
  ];
  for (const [i, k] of keys) if (v[i] !== null) (m as Record<string, unknown>)[k] = v[i];
  return m;
}

/** A row of TOUCH_COLUMN_LIST's values, as `touchOf` reads the same columns by name. */
export function touchOfValues(v: unknown[]): TouchRow {
  const t: TouchRow = {
    src: v[0] as string,
    srcKey: v[1] as string,
    kind: v[2] as string,
    atMs: v[3] as number,
    creditMs: v[4] as number,
    estimated: v[12] !== 0,
    outside: v[13] !== 0,
  };
  const keys: [number, keyof TouchRow][] = [[5, "endMs"], [6, "machineId"], [7, "projectId"], [8, "repo"], [9, "workstreamId"], [10, "prNumber"], [11, "keyId"]];
  for (const [i, k] of keys) if (v[i] !== null) (t as Record<string, unknown>)[k] = v[i];
  return t;
}

export const MERGE_COLUMN_LIST = MERGE_COLUMNS;
export const TOUCH_COLUMN_LIST = `src, src_key, kind, at_ms, credit_ms, end_ms, machine_id, project_id, repo, workstream_id, pr_number,
       key_id, estimated, outside`;

export function merges(c: Database, sinceMs: number, untilMs: number, repos?: string[]): MergeRow[] {
  const [sql, params] = mergesSql(sinceMs, untilMs, repos);
  return c.query<MergeSql, (string | number | null)[]>(sql).all(...params).map(mergeOf);
}

/** A repo's read state. */
export type RepoRow = {
  repo: string;
  /** GitHost as stored: "github", "gitlab", ... or "git". */
  host: string;
  defaultBranch?: string;
  lastOkMs?: number;
  lastError?: string;
  backfilledMs?: number;
  /** A read of its merged PRs was cut short and goes on at the next one. */
  partlyRead: boolean;
};

export function repos(c: Database): RepoRow[] {
  return c
    .query<
      {
        repo: string;
        host: string;
        default_branch: string | null;
        last_ok_ms: number | null;
        last_error: string | null;
        backfilled_ms: number | null;
        partly: number;
      },
      []
    >(
      `SELECT repo, host, default_branch, last_ok_ms, last_error, backfilled_ms, merged_resume IS NOT NULL AS partly
       FROM metric_repos ORDER BY repo`,
    )
    .all()
    .map((r) => ({
      repo: r.repo,
      host: r.host,
      ...(r.default_branch === null ? {} : { defaultBranch: r.default_branch }),
      ...(r.last_ok_ms === null ? {} : { lastOkMs: r.last_ok_ms }),
      ...(r.last_error === null ? {} : { lastError: r.last_error }),
      ...(r.backfilled_ms === null ? {} : { backfilledMs: r.backfilled_ms }),
      partlyRead: r.partly !== 0,
    }));
}

/** One act by the person. Idempotent on `(src, srcKey)`. */
export type TouchRow = {
  /** "chat", "request", "steer", "decision", "order", "merge", "app" or "host". */
  src: string;
  srcKey: string;
  /** A TouchKind. */
  kind: string;
  /** When the act was recorded; the act itself took the `creditMs` before it. */
  atMs: number;
  creditMs: number;
  /** An interval observed as it is (app use): `[atMs, endMs]`. */
  endMs?: number;
  machineId?: string;
  projectId?: string;
  repo?: string;
  workstreamId?: string;
  prNumber?: number;
  /** The name of the key that made it, or the git host login. */
  keyId?: string;
  estimated: boolean;
  /** On work fleetd didn't write. */
  outside: boolean;
};

/** Writes a touch; a later read of the same act replaces what an earlier one said. */
export function upsertTouch(c: Database, t: TouchRow): void {
  c.query(
    `INSERT INTO metric_touches (src, src_key, kind, at_ms, credit_ms, end_ms, machine_id, project_id, repo,
       workstream_id, pr_number, key_id, estimated, outside)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(src, src_key) DO UPDATE SET kind = excluded.kind, at_ms = excluded.at_ms,
       credit_ms = excluded.credit_ms, end_ms = excluded.end_ms,
       machine_id = COALESCE(excluded.machine_id, machine_id),
       project_id = COALESCE(excluded.project_id, project_id), repo = COALESCE(excluded.repo, repo),
       workstream_id = COALESCE(excluded.workstream_id, workstream_id),
       pr_number = COALESCE(excluded.pr_number, pr_number), key_id = COALESCE(excluded.key_id, key_id),
       estimated = excluded.estimated, outside = excluded.outside`,
  ).run(
    t.src,
    t.srcKey,
    t.kind,
    t.atMs,
    t.creditMs,
    n(t.endMs),
    n(t.machineId),
    n(t.projectId),
    n(t.repo),
    n(t.workstreamId),
    n(t.prNumber),
    n(t.keyId),
    t.estimated ? 1 : 0,
    t.outside ? 1 : 0,
  );
}

type TouchSql = {
  src: string;
  src_key: string;
  kind: string;
  at_ms: number;
  credit_ms: number;
  end_ms: number | null;
  machine_id: string | null;
  project_id: string | null;
  repo: string | null;
  workstream_id: string | null;
  pr_number: number | null;
  key_id: string | null;
  estimated: number;
  outside: number;
};

/** Every touch recorded in `[since, until)`, oldest first: the SQL and its parameters. */
export function touchesSql(sinceMs: number, untilMs: number): [string, number[]] {
  return [
    `SELECT ${TOUCH_COLUMN_LIST} FROM metric_touches WHERE at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms, id`,
    [sinceMs, untilMs],
  ];
}

export function touchOf(r: TouchSql): TouchRow {
  const t: TouchRow = {
    src: r.src,
    srcKey: r.src_key,
    kind: r.kind,
    atMs: r.at_ms,
    creditMs: r.credit_ms,
    estimated: r.estimated !== 0,
    outside: r.outside !== 0,
  };
  if (r.end_ms !== null) t.endMs = r.end_ms;
  if (r.machine_id !== null) t.machineId = r.machine_id;
  if (r.project_id !== null) t.projectId = r.project_id;
  if (r.repo !== null) t.repo = r.repo;
  if (r.workstream_id !== null) t.workstreamId = r.workstream_id;
  if (r.pr_number !== null) t.prNumber = r.pr_number;
  if (r.key_id !== null) t.keyId = r.key_id;
  return t;
}

export function touches(c: Database, sinceMs: number, untilMs: number): TouchRow[] {
  const [sql, params] = touchesSql(sinceMs, untilMs);
  return c.query<TouchSql, number[]>(sql).all(...params).map(touchOf);
}

/** The person's own git host logins and emails, lowercased. */
export function identities(c: Database): string[] {
  return c
    .query<{ identity: string }, []>("SELECT identity FROM metric_identities ORDER BY identity")
    .all()
    .map((r) => r.identity);
}

/** Records one of the person's identities; `src` says where it was learned. */
export function addIdentity(c: Database, identity: string, src: string): void {
  c.query(
    `INSERT INTO metric_identities (identity, src) VALUES (?1, ?2)
     ON CONFLICT(identity) DO UPDATE SET src = excluded.src`,
  ).run(identity.trim().toLowerCase(), src);
}

/** Where a repo's reviews and comments were last read up to. */
export function reviewsCursor(c: Database, repo: string): number | undefined {
  return c.query<{ v: number | null }, [string]>("SELECT reviews_cursor_ms AS v FROM metric_repos WHERE repo = ?1").get(repo)?.v ?? undefined;
}

export function setReviewsCursor(c: Database, repo: string, atMs: number): void {
  c.query("UPDATE metric_repos SET reviews_cursor_ms = MAX(COALESCE(reviews_cursor_ms, 0), ?2) WHERE repo = ?1").run(repo, atMs);
}
