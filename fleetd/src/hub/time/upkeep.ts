// The time area's upkeep: builds the hourly digests the Time reads use (hours.ts), from the hours no build covers yet
// (all of history, on the first start) to the ones spans landed in since, and works out ahead what a breakdown would
// otherwise work out on every read: running orders' `change.ci` segments (half a second for a busy fleet) and the
// bytes the time tables take (a few hundred ms). `upkeep` runs on a read worker; the hub thread only stores its answer.
import type { Database } from "bun:sqlite";
import { type Built, buildHour, saveHour } from "./hours.ts";
import { decodeStored } from "./path.ts";
import { ciOf, orderPath } from "./reads.ts";
import { DAY, HOUR, retentionDays, storedBytes } from "./store.ts";

/** What one upkeep job does: build what is due, and when asked, the running orders' segments and the stored bytes. */
export type UpkeepJob = { now: number; ci: boolean; bytes: boolean };

/** A job's answer: builds, orders' `change.ci` segments (`done` 1 from a stored path), bytes, and whether more is due. */
export type Upkept = {
  hours: Built[];
  ci: [workstream: string, done: 0 | 1, computedMs: number, ci: string][];
  bytes?: number;
  more: boolean;
};

/** The work one job does at most, so a read on the same worker waits no longer. */
const BUDGET_MS = 250;
/** An hour spans keep landing in is built again at most this often; till then its new spans are read live. */
export const REBUILD_MS = 60_000;
/** Running orders whose segments are worked out, newest first: more than a breakdown computes (reads.ts). */
const RUNNING = 40;

export function upkeep(c: Database, job: UpkeepJob): Upkept {
  const start = performance.now();
  const over = () => performance.now() - start > BUDGET_MS;
  const last = Math.floor(job.now / HOUR);
  const first = Math.floor((job.now - retentionDays(c) * DAY) / HOUR);
  const known = new Map(
    c
      .query<{ hour: number; version: number; built_version: number | null; built_ms: number | null }, [number]>(
        "SELECT hour, version, built_version, built_ms FROM time_hours WHERE hour >= ?1",
      )
      .all(first)
      .map((h) => [h.hour, h]),
  );
  const due: number[] = [];
  for (let h = last; h >= first; h--) {
    const k = known.get(h);
    if (!k || k.built_version === null || (k.version > k.built_version && job.now - (k.built_ms ?? 0) >= REBUILD_MS)) due.push(h);
  }
  const hours: Built[] = [];
  for (const h of due) {
    if (over()) break;
    hours.push(buildHour(c, h));
  }
  let more = hours.length < due.length;

  const ci: Upkept["ci"] = [];
  if (job.ci) {
    for (const { workstream_id: w } of c
      .query<{ workstream_id: string }, [number]>("SELECT workstream_id FROM time_orders WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT ?1")
      .all(RUNNING)) {
      const path = orderPath(c, w, job.now);
      if (path) ci.push([w, 0, job.now, JSON.stringify(ciOf(path))]);
    }
  }
  // Done orders' segments, from their stored paths, a batch at a time.
  const stale = c
    .query<{ workstream_id: string; computed_ms: number; data: string }, []>(
      `SELECT p.workstream_id, p.computed_ms, p.data FROM time_paths p LEFT JOIN time_order_ci o ON o.workstream_id = p.workstream_id
       WHERE o.workstream_id IS NULL OR o.done = 0 OR o.computed_ms != p.computed_ms LIMIT 200`,
    )
    .all();
  if (stale.length === 200) more = true;
  for (const p of stale) {
    if (over()) {
      more = true;
      break;
    }
    const path = decodeStored(p.data);
    if (path) ci.push([p.workstream_id, 1, p.computed_ms, JSON.stringify(ciOf(path))]);
  }
  return { hours, ci, ...(job.bytes ? { bytes: storedBytes(c) } : {}), more };
}

/** Stores a job's answer, in the caller's transaction. */
export function saveUpkeep(c: Database, got: Upkept, nowMs: number): void {
  for (const b of got.hours) saveHour(c, b, nowMs);
  const put = c.query(
    `INSERT INTO time_order_ci (workstream_id, done, computed_ms, ci) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(workstream_id) DO UPDATE SET done = excluded.done, computed_ms = excluded.computed_ms, ci = excluded.ci`,
  );
  for (const [w, done, at, segs] of got.ci) put.run(w, done, at, segs);
  if (got.bytes !== undefined) {
    c.query("INSERT INTO time_settings (key, value) VALUES ('stored_bytes', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(got.bytes);
  }
}
