// Hourly digests of the spans (digest.ts), so a Time breakdown over a month reads a few thousand digests where it read
// every span (three seconds and more for 200k spans). An hour's digests are built from its spans in one snapshot, on
// a read worker (upkeep.ts), and stay exact without being built on each write: a read takes beside them, live, every
// span written into the hour since (ids past `upto`), the spans the build left out (`live`), and the hours no build
// covers yet, such as the edges of the period. A change to spans already digested (`resetHours`) unbuilds the hour.
import type { Database } from "bun:sqlite";
import { addDigest, addEncoded, digestOf, type Digest, emptyDigest, encode, fold, inSeq, type Seq, seqOf } from "./digest.ts";
import type { Row } from "./model.ts";
import { DAY, type Filter, HOUR, readMeta, retentionDays } from "./store.ts";

/** Every span of the read: an hour or a period's edge holds a few thousand. */
const ALL = 10_000_000;

/** An hour's build: its digests, and what a read takes live beside them. */
export type Built = {
  hour: number;
  /** `time_hours.version` and `reset` in the snapshot. */
  version: number;
  reset: number;
  /** The newest span id in the snapshot. */
  upto: number;
  /** Spans of the hour left out: open, or ending before they start. */
  live: number[];
  minStart: number | null;
  maxStart: number | null;
  digests: [machine: string, project: string, role: string, data: string][];
};

/** The digest of every role. */
export const ANY_ROLE = "*";

/** Builds hour `hour`'s digests from one snapshot of its spans. */
export function buildHour(c: Database, hour: number): Built {
  return c.transaction(() => {
    const h = c.query<{ version: number; reset: number }, [number]>("SELECT version, reset FROM time_hours WHERE hour = ?1").get(hour);
    const upto = c.query<{ m: number }, []>("SELECT COALESCE(MAX(id), 0) AS m FROM time_spans").get()?.m ?? 0;
    const got = readMeta(c, { sinceMs: Number.MIN_SAFE_INTEGER, untilMs: (hour + 1) * HOUR, startFrom: hour * HOUR }, ALL);
    const groups = new Map<string, Row[]>();
    const into = (key: string, r: Row) => {
      const list = groups.get(key);
      if (list) list.push(r);
      else groups.set(key, [r]);
    };
    const live: number[] = [];
    let minStart: number | null = null;
    let maxStart: number | null = null;
    for (const [r, m] of got) {
      minStart = minStart === null ? r.startMs : Math.min(minStart, r.startMs);
      maxStart = maxStart === null ? r.startMs : Math.max(maxStart, r.startMs);
      // An open span's time grows until it closes, and one that ends before it starts counts or not by the period.
      if (m.open || r.endMs < r.startMs) {
        live.push(r.id);
        continue;
      }
      const where = `${r.machineId ?? ""}\u0000${r.projectId ?? ""}`;
      into(`${where}\u0000${ANY_ROLE}`, r);
      if (r.role !== undefined) into(`${where}\u0000${r.role}`, r);
    }
    const digests = [...groups].map(([key, rows]): Built["digests"][number] => {
      const [machine, project, role] = key.split("\u0000") as [string, string, string];
      return [machine, project, role, encode(digestOf(rows))];
    });
    return { hour, version: h?.version ?? 0, reset: h?.reset ?? 0, upto, live, minStart, maxStart, digests };
  })();
}

/** Stores a build, unless its hour was reset or pruned since its snapshot; true when stored. */
export function saveHour(c: Database, b: Built, nowMs: number): boolean {
  if (b.hour < Math.floor((nowMs - retentionDays(c) * DAY) / HOUR)) return false;
  const reset = c.query<{ reset: number }, [number]>("SELECT reset FROM time_hours WHERE hour = ?1").get(b.hour)?.reset ?? 0;
  if (reset !== b.reset) return false;
  c.query("DELETE FROM time_digests WHERE hour = ?1").run(b.hour);
  const put = c.query("INSERT INTO time_digests (hour, machine_id, project_id, role, data) VALUES (?1, ?2, ?3, ?4, ?5)");
  for (const [m, p, role, data] of b.digests) put.run(b.hour, m, p, role, data);
  c.query(
    `INSERT INTO time_hours (hour, version, reset, built_version, built_ms, upto, live, min_start, max_start)
     VALUES (?1, ?2, ?3, ?2, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(hour) DO UPDATE SET built_version = excluded.built_version, built_ms = excluded.built_ms,
       upto = excluded.upto, live = excluded.live, min_start = excluded.min_start, max_start = excluded.max_start`,
  ).run(b.hour, b.version, b.reset, nowMs, b.upto, JSON.stringify(b.live), b.minStart, b.maxStart);
  return true;
}

/** Hours a digest read takes span by span at most; past that it is history not built yet (upkeep.ts). */
const UNBUILT_MAX = 24;

/**
 * Whether `[since, until)` is built but for UNBUILT_MAX hours, those past retention not counted (they hold no spans).
 * Until it is, as on a hub's first start, a read takes the spans as before: at most reads.ts MAX_ROWS of them.
 */
export function built(c: Database, since: number, until: number, nowMs: number): boolean {
  const from = Math.max(Math.floor(since / HOUR), Math.floor((nowMs - retentionDays(c) * DAY) / HOUR));
  const to = Math.floor((until - 1) / HOUR);
  if (to < from) return true;
  const n =
    c
      .query<{ n: number }, [number, number]>("SELECT COUNT(*) AS n FROM time_hours WHERE hour >= ?1 AND hour <= ?2 AND built_version IS NOT NULL")
      .get(from, to)?.n ?? 0;
  return to - from + 1 - n <= UNBUILT_MAX;
}

/** Which digests and spans a read takes: a machine, a project, a role (`ANY_ROLE` for all), and what it may read. */
export type Selection = {
  machineId?: string;
  projectId?: string;
  role: string;
  /** The same spans as a span read: the scope's and role's clauses of `Filter`. */
  filter: Pick<Filter, "machineId" | "project" | "lead" | "role">;
  /** Whether the key may read a project's spans; digests are kept per project. */
  mayRead: (machineId: string | undefined, projectId: string | undefined) => boolean;
};

/** A period's spans, digested: the sums and rows, and each thread's commands folded over the period. */
export type Merged = { d: Digest; seqs: Map<string, Seq> };

type HourRow = { hour: number; version: number; built_version: number; upto: number; live: string; min_start: number | null; max_start: number | null };

/** Whether every span the hour's digests hold starts inside `[since, until)`. */
const inside = (h: HourRow, since: number, until: number) =>
  h.min_start === null || h.max_start === null
    ? true
    : (h.hour * HOUR >= since || h.min_start >= since) && ((h.hour + 1) * HOUR <= until || h.max_start < until);

/**
 * Every span `pick` takes that starts in `[since, until)`, digested: built hours from their digests and the rest from
 * spans. Kinds of spans that start in `skip` (whole UTC days the caller reads from the daily roll-ups) are left out.
 */
export function digestRead(c: Database, pick: Selection, since: number, until: number, skip?: [number, number]): Merged {
  const h0 = Math.floor(since / HOUR);
  const h1 = Math.floor((until - 1) / HOUR);
  const skipped = (ms: number) => skip !== undefined && ms >= skip[0] && ms < skip[1];
  const hours = new Map<number, HourRow>();
  for (const h of c
    .query<HourRow, [number, number]>(
      `SELECT hour, version, built_version, upto, live, min_start, max_start FROM time_hours
       WHERE hour >= ?1 AND hour <= ?2 AND built_version IS NOT NULL`,
    )
    .all(h0, h1)) {
    if (inside(h, since, until)) hours.set(h.hour, h);
  }

  const d = emptyDigest();
  /** Thread -> hour -> its folded commands there, and the machines they came from (more than one: read again). */
  const seqs = new Map<string, Map<number, { seq: Seq; machines: Set<string>; parts: number }>>();
  const addSeqs = (hour: number, from: Map<string, Seq>, machine: (t: string) => Iterable<string>) => {
    for (const [t, s] of from) {
      let byHour = seqs.get(t);
      if (!byHour) seqs.set(t, (byHour = new Map()));
      const at = byHour.get(hour);
      if (at) {
        at.parts += 1;
        for (const m of machine(t)) at.machines.add(m);
      } else byHour.set(hour, { seq: s, machines: new Set(machine(t)), parts: 1 });
    }
  };

  // The built hours' digests.
  let sql = "SELECT hour, machine_id, project_id, data FROM time_digests WHERE hour >= ?1 AND hour <= ?2 AND role = ?3";
  const args: (string | number)[] = [h0, h1, pick.role];
  if (pick.machineId !== undefined) {
    sql += " AND machine_id = ?4";
    args.push(pick.machineId);
    if (pick.projectId !== undefined) {
      sql += " AND project_id = ?5";
      args.push(pick.projectId);
    }
  }
  for (const row of c.query<{ hour: number; machine_id: string; project_id: string; data: string }, (string | number)[]>(sql).all(...args)) {
    if (!hours.has(row.hour)) continue;
    if (!pick.mayRead(row.machine_id || undefined, row.project_id || undefined)) continue;
    addSeqs(row.hour, addEncoded(d, row.data, !skipped(row.hour * HOUR)), () => [row.machine_id]);
  }

  // Spans read live: hours no build covers, spans written into built hours since, and those the builds left out.
  const base = { ...pick.filter, sinceMs: since, untilMs: until };
  const live: Row[] = [];
  const take = (f: Filter) => {
    for (const [r] of readMeta(c, f, ALL)) if (pick.mayRead(r.machineId, r.projectId)) live.push(r);
  };
  let from: number | undefined;
  for (let h = h0; h <= h1 + 1; h++) {
    if (h <= h1 && !hours.has(h)) from ??= Math.max(since, h * HOUR);
    else if (from !== undefined) {
      take({ ...base, startFrom: from, startBefore: Math.min(until, h * HOUR) });
      from = undefined;
    }
  }
  const leftOut: number[] = [];
  for (const h of hours.values()) {
    if (h.version > h.built_version) take({ ...base, startFrom: Math.max(since, h.hour * HOUR), startBefore: Math.min(until, (h.hour + 1) * HOUR), afterId: h.upto });
    for (const id of JSON.parse(h.live) as number[]) leftOut.push(id);
  }
  if (leftOut.length > 0) take({ ...base, startFrom: since, ids: leftOut });

  const byHour = new Map<number, Row[]>();
  for (const r of live) {
    const h = Math.floor(r.startMs / HOUR);
    const list = byHour.get(h);
    if (list) list.push(r);
    else byHour.set(h, [r]);
  }
  for (const [h, rows] of byHour) {
    const one = digestOf(rows);
    addDigest(d, one, !skipped(h * HOUR));
    addSeqs(h, one.seqs, (t) => new Set(rows.flatMap((r) => (r.threadId === t ? [r.machineId ?? ""] : []))));
  }
  d.rows.sort((a, b) => a.id - b.id);

  // A thread whose commands in an hour came in parts (two projects, or a digest and spans read live) is read again
  // whole there, then each thread folds hour by hour.
  const folded = new Map<string, Seq>();
  for (const [t, byH] of seqs) {
    let acc: Seq | undefined;
    for (const h of [...byH.keys()].sort((a, b) => a - b)) {
      const at = byH.get(h) as { seq: Seq; machines: Set<string>; parts: number };
      let s = at.seq;
      if (at.parts > 1) {
        const rows: Row[] = [];
        const span = { ...base, startFrom: Math.max(since, h * HOUR), startBefore: Math.min(until, (h + 1) * HOUR), kinds: ["tool.bash", "git", "tool.edit"] } satisfies Filter;
        for (const m of at.machines) {
          for (const [r] of readMeta(c, m === "" ? { ...span, threadId: t } : { ...span, thread: [m, t] }, ALL)) {
            if (r.threadId === t && inSeq(r) && pick.mayRead(r.machineId, r.projectId)) rows.push(r);
          }
        }
        s = seqOf(rows);
      }
      acc = acc === undefined ? s : fold(acc, s);
    }
    if (acc) folded.set(t, acc);
  }
  return { d, seqs: folded };
}
