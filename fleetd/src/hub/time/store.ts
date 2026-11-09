// The time tables: span writes (idempotent on `(src, src_key)`), labels, per-day
// roll-ups, retention and reads. Every write runs inside the caller's transaction, so a batch's spans, labels,
// roll-ups and cursor commit together.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { Category, SpanExtra, SpanKind, SpanStatus } from "../../shared/contracts.ts";
import { categoryCode, categoryOf, categoryOfCode, kindCode, kindOf, statusCode, statusOf } from "./kinds.ts";
import { isDetail, type Row } from "./model.ts";

export const DEFAULT_RETENTION_DAYS = 30;
/** Roll-ups and critical paths outlive spans: a few KB per day. */
export const ROLLUP_DAYS = 400;
export const PRUNE_BATCH = 5_000;
const LABEL_MAX = 500;
export const DAY = 86_400_000;

/** Who a span belongs to. */
export type Ids = {
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  taskId?: string;
  threadId?: string;
  runId?: string;
  /** `AgentRole` as stored: lead, implementer, reviewer, ... */
  role?: string;
  /** A task's profile's name; for a lead, the one its session started on. */
  profile?: string;
};

/** A span on its way into the store. `endMs` absent opens it; a later write with the same key and an end closes it. */
export type NewSpan = {
  src: string;
  srcKey: string;
  kind: SpanKind;
  startMs: number;
  endMs?: number;
  /** Absent: the whole interval, 0 for detail spans. */
  exclMs?: number;
  ids: Ids;
  lane: string;
  parentKey?: string;
  /** Raw; normalized and deduped here. */
  label?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  extra?: SpanExtra;
};

/** One roll-up target besides the span's own ids, with a weight: a lead turn split over the orders its wake served. */
export type Share = { scope: string; id: string; of: number };

/** What a write did: counted in roll-ups (new, or closed an open one), opened, or unchanged (a resend). */
export type Wrote = { kind: "counted"; id: number } | { kind: "opened"; id: number } | { kind: "unchanged" };

/** How many days spans are kept. */
export function retentionDays(c: Database): number {
  return c.query<{ value: number }, []>("SELECT value FROM time_settings WHERE key = 'retention_days'").get()?.value ?? DEFAULT_RETENTION_DAYS;
}

export function cursor(c: Database, source: string): number | undefined {
  return c.query<{ value: number }, [string]>("SELECT value FROM time_cursors WHERE source = ?1").get(source)?.value ?? undefined;
}

export function setCursor(c: Database, source: string, value: number): void {
  c.query(
    `INSERT INTO time_cursors (source, value) VALUES (?1, ?2)
     ON CONFLICT(source) DO UPDATE SET value = MAX(value, excluded.value)`,
  ).run(source, value);
}

/** The program a shell command runs: after any `cd x &&` and `VAR=value` prefixes (node/runner/shell.rs). */
export function program(command: string): string | undefined {
  let rest = command.trim();
  for (;;) {
    if (rest.startsWith("cd ")) {
      const after = rest.slice(3);
      const i = after.indexOf("&&");
      if (i >= 0) {
        rest = after.slice(i + 2).trimStart();
        continue;
      }
    }
    const first = rest.split(/\s+/).filter(Boolean)[0];
    if (first === undefined) return undefined;
    if (first.includes("=") && !first.startsWith("=")) {
      rest = rest.slice(first.length).trimStart();
      continue;
    }
    return first;
  }
}

/** `text` cut to at most `max` UTF-16 units, never splitting a character. */
export function headUtf16(text: string, max: number): string {
  let units = 0;
  let out = "";
  for (const ch of text) {
    units += ch.length;
    if (units > max) return out;
    out += ch;
  }
  return text;
}

const WITH_SUB = ["cargo", "git", "gh", "npm", "pnpm", "yarn", "go", "vp", "docker", "npx", "bun", "uv", "poetry"];

/** The program family of a label: "cargo test", "git push", "pytest". Tools that are not a shell command are their own family. */
export function family(kind: SpanKind, tool: string | undefined, label: string): string {
  if (kind !== "tool.bash" && kind !== "git") return tool ?? kind;
  const prog0 = program(label);
  if (prog0 === undefined) return "";
  const prog = prog0.split("/").pop() ?? prog0;
  if (WITH_SUB.includes(prog)) {
    const at = label.indexOf(prog0);
    const tokens = label
      .slice(at < 0 ? 0 : at + prog0.length)
      .trimStart()
      .split(/\s+/)
      .filter(Boolean);
    let sub: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      if (t === "-C" || t === "-c") i++;
      else if (!t.startsWith("-")) {
        sub = t;
        break;
      }
    }
    if (sub !== undefined) return `${prog} ${[...sub].slice(0, 40).join("")}`;
  }
  return [...prog].slice(0, 80).join("");
}

const WT = /(?:\/[^\s/'"]+)*\/worktrees\/[^\s/'"]+\/[^\s/'"]+/g;

/** Worktree paths become `<wt>`, so the same command in two worktrees is one label. */
export const normalize = (label: string) => headUtf16(label.replace(WT, "<wt>"), LABEL_MAX);

function labelId(c: Database, fam: string, text: string): number {
  const hash = new Bun.CryptoHasher("sha256").update(fam).update(new Uint8Array([0])).update(text).digest().subarray(0, 16);
  const found = c.query<{ id: number }, [Uint8Array]>("SELECT id FROM time_labels WHERE hash = ?1").get(hash);
  if (found) return found.id;
  return Number(c.query("INSERT INTO time_labels (hash, family, text) VALUES (?1, ?2, ?3)").run(hash, fam, text).lastInsertRowid);
}

/** Writes one span; counts it in the roll-ups when it is new and closed, or when this write closes it. */
export function write(c: Database, span: NewSpan, shares: Share[] = []): Wrote {
  const existing = c
    .query<{ id: number; end_ms: number | null }, [string, string]>("SELECT id, end_ms FROM time_spans WHERE src = ?1 AND src_key = ?2")
    .get(span.src, span.srcKey);
  let label: number | null = null;
  if (span.label !== undefined) {
    const text = normalize(span.label);
    label = labelId(c, family(span.kind, span.extra?.tool, text), text);
  }
  const excl =
    span.endMs === undefined
      ? null
      : isDetail(span.kind)
        ? 0
        : Math.min(Math.max(span.exclMs ?? span.endMs - span.startMs, 0), Math.max(span.endMs - span.startMs, 0));
  const extra = span.extra === undefined ? null : JSON.stringify(span.extra);
  const parent =
    span.parentKey === undefined
      ? null
      : (c.query<{ id: number }, [string, string]>("SELECT id FROM time_spans WHERE src = ?1 AND src_key = ?2").get(span.src, span.parentKey)
          ?.id ?? null);
  let id: number;
  if (existing) {
    if (existing.end_ms !== null || span.endMs === undefined) return { kind: "unchanged" };
    id = existing.id;
    c.query(
      `UPDATE time_spans SET end_ms = ?2, excl_ms = ?3, status = ?4,
         extra = COALESCE(?5, extra), label_id = COALESCE(?6, label_id),
         exit_code = COALESCE(?7, exit_code), workstream_id = COALESCE(workstream_id, ?8),
         task_id = COALESCE(task_id, ?9), profile = COALESCE(profile, ?10)
       WHERE id = ?1`,
    ).run(
      id,
      span.endMs,
      excl,
      statusCode(span.status),
      extra,
      label,
      span.exitCode ?? null,
      span.ids.workstreamId ?? null,
      span.ids.taskId ?? null,
      span.ids.profile ?? null,
    );
  } else {
    const i = span.ids;
    id = Number(
      c
        .query(
          `INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, excl_ms, machine_id, project_id,
             workstream_id, task_id, thread_id, run_id, role, lane, parent_id, label_id, exit_code, out_bytes,
             status, extra, profile)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`,
        )
        .run(
          span.src,
          span.srcKey,
          kindCode(span.kind),
          categoryCode(categoryOf(span.kind)),
          span.startMs,
          span.endMs ?? null,
          excl,
          i.machineId ?? null,
          i.projectId ?? null,
          i.workstreamId ?? null,
          i.taskId ?? null,
          i.threadId ?? null,
          i.runId ?? null,
          i.role ?? null,
          span.lane,
          parent,
          label,
          span.exitCode ?? null,
          span.outBytes ?? null,
          statusCode(span.status),
          extra,
          i.profile ?? null,
        ).lastInsertRowid,
    );
    if (span.endMs === undefined) return { kind: "opened", id };
  }
  const owners = c
    .query<{ machine_id: string | null; project_id: string | null; workstream_id: string | null; task_id: string | null; role: string | null }, [number]>(
      "SELECT machine_id, project_id, workstream_id, task_id, role FROM time_spans WHERE id = ?1",
    )
    .get(id);
  const ms = excl ?? 0;
  const day = Math.floor(span.startMs / DAY);
  const targets: [string, string, number][] = [["fleet", "", 1]];
  if (owners?.machine_id) {
    const m = owners.machine_id;
    targets.push(["machine", m, 1]);
    if (owners.project_id) {
      targets.push(["project", `${m}/${owners.project_id}`, 1]);
      if (owners.role === "lead") targets.push(["lead", `${m}/${owners.project_id}`, 1]);
    }
  }
  if (owners?.workstream_id) targets.push(["order", owners.workstream_id, 1]);
  if (owners?.task_id) targets.push(["task", owners.task_id, 1]);
  for (const s of shares) targets.push([s.scope, s.id, Math.max(s.of, 1)]);
  const stmt = c.query(
    `INSERT INTO time_rollups (day, scope, scope_id, cat, kind, ms, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
     ON CONFLICT(day, scope, scope_id, cat, kind) DO UPDATE SET ms = ms + excluded.ms, n = n + 1`,
  );
  for (const [scope, scopeId, of] of targets) {
    // Integer division, as the Rust hub's i64 roll-ups do.
    stmt.run(day, scope, scopeId, categoryCode(categoryOf(span.kind)), kindCode(span.kind), Math.trunc(ms / of));
  }
  return { kind: "counted", id };
}

/** Resolves parents written later in the same batch. */
export function linkParents(c: Database, src: string, pairs: [child: string, parent: string][]): void {
  const stmt = c.query(
    `UPDATE time_spans SET parent_id = (SELECT id FROM time_spans WHERE src = ?1 AND src_key = ?3)
     WHERE src = ?1 AND src_key = ?2 AND parent_id IS NULL`,
  );
  for (const [child, parent] of pairs) stmt.run(src, child, parent);
}

/** Deletes spans past retention and roll-ups past ROLLUP_DAYS, one batch per call; true while more remain. */
export function prune(c: Database, nowMs: number): boolean {
  const cutoff = nowMs - retentionDays(c) * DAY;
  const n = c
    .query("DELETE FROM time_spans WHERE id IN (SELECT id FROM time_spans WHERE start_ms < ?1 ORDER BY start_ms LIMIT ?2)")
    .run(cutoff, PRUNE_BATCH).changes;
  c.query(
    `DELETE FROM time_labels WHERE id IN (SELECT l.id FROM time_labels l
       WHERE NOT EXISTS (SELECT 1 FROM time_spans s WHERE s.label_id = l.id) LIMIT ?1)`,
  ).run(PRUNE_BATCH);
  c.query("DELETE FROM time_rollups WHERE day < ?1").run(Math.floor((nowMs - ROLLUP_DAYS * DAY) / DAY));
  c.query("DELETE FROM time_paths WHERE computed_ms < ?1").run(nowMs - ROLLUP_DAYS * DAY);
  c.query("DELETE FROM time_wakes WHERE at_ms < ?1").run(cutoff);
  c.query("DELETE FROM time_lead_runs WHERE at_ms < ?1").run(cutoff);
  // An order's bounds give its wall time, read with its roll-ups, so they last as long.
  c.query("DELETE FROM time_orders WHERE COALESCE(end_ms, start_ms) < ?1").run(nowMs - ROLLUP_DAYS * DAY);
  return n === PRUNE_BATCH;
}

/** The bytes the time tables take on disk (SQLite's `dbstat`); 0 where this SQLite has no dbstat. */
export function storedBytes(c: Database): number {
  try {
    return (
      c
        .query<{ bytes: number | null }, []>(
          `SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'time\\_%' ESCAPE '\\'
             OR name LIKE 'sqlite_autoindex_time\\_%' ESCAPE '\\'`,
        )
        .get()?.bytes ?? 0
    );
  } catch {
    return 0;
  }
}

/** Which spans a read covers. */
export type Filter = {
  sinceMs: number;
  untilMs: number;
  machineId?: string;
  project?: [string, string];
  /** Lead lanes of a project. */
  lead?: [string, string];
  workstreamId?: string;
  taskIds?: string[];
  thread?: [string, string];
  role?: string;
  kinds?: SpanKind[];
  afterId?: number;
  /** Only spans that start here or later: keeps a period's read on the start index. */
  startFrom?: number;
  /** At the limit, keep the newest spans instead of the oldest. */
  newest?: boolean;
};

/** What a reader needs beside the row. */
export type Meta = { srcKey: string; role?: string; runId?: string; open: boolean };

/** An order's own spans and its share of lead turns (runs whose wake served it); `?3` is the order. */
const ORDER_SPANS = `(SELECT * FROM time_spans WHERE workstream_id = ?3
          UNION ALL
          SELECT t.* FROM time_lead_runs lr JOIN time_spans t ON t.run_id = lr.run_id
            AND +t.machine_id = lr.machine_id AND +t.thread_id = lr.thread_id
          WHERE lr.workstream_id = ?3 AND t.role = 'lead' AND t.workstream_id IS NOT ?3)`;

type SpanRow = {
  id: number;
  kind: number;
  start_ms: number;
  end_ms: number | null;
  excl_ms: number | null;
  lane: string;
  parent_id: number | null;
  label_id: number | null;
  text: string | null;
  family: string | null;
  exit_code: number | null;
  out_bytes: number | null;
  status: number;
  machine_id: string | null;
  project_id: string | null;
  workstream_id: string | null;
  task_id: string | null;
  thread_id: string | null;
  extra: string | null;
  src_key: string;
  role: string | null;
  run_id: string | null;
  profile: string | null;
};

export const read = (c: Database, f: Filter, limit: number): Row[] => readMeta(c, f, limit).map(([r]) => r);

const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);

/** Spans overlapping `[since, until)` that match, by id after `afterId`, at most `limit`. Open spans are cut at `until`. */
export function readMeta(c: Database, f: Filter, limit: number): [Row, Meta][] {
  const args: SQLQueryBindings[] = [f.untilMs, f.sinceMs];
  let from = "time_spans";
  if (f.workstreamId !== undefined) {
    args.push(f.workstreamId);
    from = ORDER_SPANS;
  }
  let sql = `SELECT s.id, s.kind, s.start_ms, s.end_ms, s.excl_ms, s.lane, s.parent_id, s.label_id, l.text, l.family,
       s.exit_code, s.out_bytes, s.status, s.machine_id, s.project_id, s.workstream_id, s.task_id, s.thread_id,
       s.extra, s.src_key, s.role, s.run_id, s.profile
     FROM ${from} s LEFT JOIN time_labels l ON l.id = s.label_id
     WHERE s.start_ms < ?1 AND COALESCE(s.end_ms, ?1) >= ?2`;
  // Each `?` in a clause numbered after the parameters bound so far.
  const add = (clause: string, values: SQLQueryBindings[]) => {
    const parts = clause.split("?");
    let out = parts[0] as string;
    for (let i = 1; i < parts.length; i++) {
      args.push(values[i - 1] as SQLQueryBindings);
      out += `?${args.length}${parts[i]}`;
    }
    sql += ` AND ${out}`;
  };
  if (f.machineId !== undefined) add("s.machine_id = ?", [f.machineId]);
  if (f.project) add("s.machine_id = ? AND s.project_id = ?", f.project);
  if (f.lead) add("s.machine_id = ? AND s.project_id = ? AND s.role = 'lead'", f.lead);
  if (f.startFrom !== undefined) add("s.start_ms >= ?", [f.startFrom]);
  if (f.taskIds) add("s.task_id IN (SELECT value FROM json_each(?))", [JSON.stringify(f.taskIds)]);
  if (f.thread) add("s.machine_id = ? AND s.thread_id = ?", f.thread);
  if (f.role !== undefined) add("s.role = ?", [f.role]);
  if (f.kinds) add("s.kind IN (SELECT value FROM json_each(?))", [JSON.stringify(f.kinds.map(kindCode))]);
  if (f.afterId !== undefined) add("s.id > ?", [f.afterId]);
  sql += ` ORDER BY s.id ${f.newest ? "DESC" : ""} LIMIT ${Math.trunc(limit)}`;
  const until = f.untilMs;
  const out = c
    .query<SpanRow, SQLQueryBindings[]>(sql)
    .all(...args)
    .map((r): [Row, Meta] => {
      const kind = kindOf(r.kind) ?? "runner.other";
      let extra: SpanExtra = {};
      if (r.extra !== null) {
        try {
          extra = JSON.parse(r.extra) as SpanExtra;
        } catch {
          extra = {};
        }
      }
      const row: Row = {
        id: r.id,
        kind,
        startMs: r.start_ms,
        endMs: r.end_ms ?? Math.max(until, r.start_ms),
        exclMs: r.excl_ms ?? (isDetail(kind) ? 0 : Math.max(until, r.start_ms) - r.start_ms),
        lane: r.lane,
        parentId: opt(r.parent_id),
        labelId: opt(r.label_id),
        label: opt(r.text),
        family: opt(r.family),
        exitCode: opt(r.exit_code),
        outBytes: opt(r.out_bytes),
        status: statusOf(r.status),
        machineId: opt(r.machine_id),
        projectId: opt(r.project_id),
        workstreamId: opt(r.workstream_id),
        taskId: opt(r.task_id),
        threadId: opt(r.thread_id),
        role: opt(r.role),
        profile: opt(r.profile),
        extra,
      };
      return [row, { srcKey: r.src_key, role: opt(r.role), runId: opt(r.run_id), open: r.end_ms === null }];
    });
  if (f.newest) out.reverse();
  return out;
}

/** Per category and kind, exclusive ms and count, from the roll-ups for whole UTC days in `[fromDay, toDay)`. */
export function rollupTotals(c: Database, scope: string, scopeId: string, fromDay: number, toDay: number): [Category, SpanKind, number, number][] {
  const out: [Category, SpanKind, number, number][] = [];
  for (const r of c
    .query<{ cat: number; kind: number; ms: number; n: number }, [string, string, number, number]>(
      `SELECT cat, kind, SUM(ms) AS ms, SUM(n) AS n FROM time_rollups
       WHERE scope = ?1 AND scope_id = ?2 AND day >= ?3 AND day < ?4 GROUP BY cat, kind`,
    )
    .all(scope, scopeId, fromDay, toDay)) {
    const cat = categoryOfCode(r.cat);
    const kind = kindOf(r.kind);
    if (cat && kind) out.push([cat, kind, r.ms, r.n]);
  }
  return out;
}
