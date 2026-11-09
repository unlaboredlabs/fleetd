// Spans folded out of the event log: queue waits, usage parks, waits on a
// person's answer to a request, wake debounces, offline writes, and each order's bounds and critical path. It walks
// the log in seq order from `time_cursors('events')` and wakes on the log's appends; a replay is a no-op because every
// span key is deterministic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { HubEvent, HumanRequest, SpanExtra, SpanKind } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { BATCH_MS, events } from "../store/events.ts";
import { parseMs } from "../store/time.ts";
import { profileOf, threadLane, who, writeHub } from "./ingest.ts";
import { kindCode, kindOf } from "./kinds.ts";
import { cursor, headUtf16, type Ids, type NewSpan, resetHours, setCursor, type Share, write } from "./store.ts";
import { orderPath } from "./reads.ts";

const CURSOR = "events";
const BUSY_LOOKBACK_MS = 6 * 3600 * 1000;
const QUEUE: SpanKind[] = ["queue.slot", "queue.lease", "queue.offline", "queue.usage"];

/**
 * Projects the log from its cursor in the background, and again after every append, until the hub stops. As the Rust
 * hub's projector runs on its own task, the hub serves while this catches up: one transaction of at most a page (or
 * BATCH_MS) at a time, in seq order, then the event loop's other work. Reads see what has been projected so far.
 */
export function startProjector(hub: Hub): Promise<void> {
  const stop = hub.shutdown.signal;
  let dirty = true;
  let wake: (() => void) | undefined;
  const nudge = () => {
    dirty = true;
    wake?.();
  };
  const unsubscribe = events(hub).subscribe(nudge);
  stop.addEventListener("abort", nudge, { once: true });
  return (async () => {
    try {
      for (;;) {
        // The first batch after the hub's other loops have started, and each next after the work that waited.
        await Bun.sleep(0);
        if (!dirty && !stop.aborted) await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        if (stop.aborted) return;
        try {
          // A transaction that failed waits for the next append, as the Rust projector's does.
          if (!projectSome(hub, BATCH_MS)) dirty = false;
        } catch (error) {
          console.error("time: events not projected:", error);
          dirty = false;
        }
      }
    } finally {
      unsubscribe();
    }
  })();
}

/**
 * One transaction's worth past the cursor: a page's events, or as many as fit in `budgetMs` (at least one), with the
 * cursor's move. True while more wait.
 */
export function projectSome(hub: Hub, budgetMs: number): boolean {
  const at = cursor(hub.db.conn, CURSOR) ?? 0;
  const page = events(hub).page(at);
  if (page.events.length === 0 && page.cursor === at) return false;
  const started = performance.now();
  const cut = hub.db.transaction((c) => {
    let n = 0;
    for (const e of page.events) {
      apply(c, e);
      n += 1;
      if (n < page.events.length && performance.now() - started >= budgetMs) break;
    }
    const rest = n < page.events.length;
    setCursor(c, CURSOR, rest ? (page.events[n - 1] as HubEvent).seq : page.cursor);
    return rest;
  });
  return cut || page.more;
}

const atMs = (e: HubEvent) => parseMs(e.at) ?? 0;

function dataStr(e: HubEvent, key: string): string | undefined {
  const v = (e.data as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Closes every open span of `kinds` matching `clause` at `end`. Through the open spans' index: by a thread's, SQLite
 * walks every span the thread ever had.
 */
function closeOpen(c: Database, kinds: SpanKind[], clause: string, args: string[], end: number): void {
  const open = c
    .query<{ src_key: string; start_ms: number }, SQLQueryBindings[]>(
      `SELECT src_key, start_ms FROM time_spans INDEXED BY time_spans_open WHERE src = 'h' AND end_ms IS NULL
         AND kind IN (SELECT value FROM json_each(?1)) AND ${clause}`,
    )
    .all(JSON.stringify(kinds.map(kindCode)), ...args);
  for (const o of open) close(c, o.src_key, o.start_ms, end);
}

function close(c: Database, key: string, start: number, end: number, extra?: SpanExtra): void {
  const row = c.query<{ kind: number; extra: string | null }, [string]>("SELECT kind, extra FROM time_spans WHERE src = 'h' AND src_key = ?1").get(key);
  if (!row) return;
  let old: SpanExtra | undefined;
  try {
    old = row.extra === null ? undefined : (JSON.parse(row.extra) as SpanExtra);
  } catch {
    old = undefined;
  }
  let merged = extra ?? old;
  if (old && extra) {
    merged = { ...old };
    if (extra.decidedBy !== undefined) merged.decidedBy = extra.decidedBy;
    if (extra.answeredBy !== undefined) merged.answeredBy = extra.answeredBy;
    if (extra.key !== undefined) merged.key = extra.key;
  }
  write(c, {
    src: "h",
    srcKey: key,
    kind: kindOf(row.kind) ?? "runner.other",
    startMs: start,
    endMs: Math.max(end, start),
    ids: {},
    lane: "",
    status: "ok",
    ...(merged === undefined ? {} : { extra: merged }),
  });
}

function open(c: Database, key: string, kind: SpanKind, start: number, ids: Ids, lane: string, extra: SpanExtra = {}): void {
  writeHub(c, {
    src: "h",
    srcKey: key,
    kind,
    startMs: start,
    ids,
    lane,
    status: "ok",
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });
}

function taskIds(c: Database, task: string): Ids {
  const n = /^T[0-9]+$/.test(task) ? Number(task.slice(1)) : -1;
  const row = c
    .query<{ machine_id: string; project_id: string; workstream_id: string; thread_id: string | null; data: string }, [number]>(
      "SELECT machine_id, project_id, workstream_id, thread_id, data FROM tasks WHERE n = ?1",
    )
    .get(n);
  if (!row) return { taskId: task };
  let data: { profile?: unknown } = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }
  return {
    machineId: row.machine_id,
    projectId: row.project_id,
    workstreamId: row.workstream_id,
    taskId: task,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    profile: profileOf(data),
  };
}

function queueKind(kind: string | undefined, reason: string | undefined): SpanKind {
  const k = kind ?? reason ?? "";
  if (k.startsWith("lease")) return "queue.lease";
  if (k.includes("offline")) return "queue.offline";
  if (k.includes("usage")) return "queue.usage";
  return "queue.slot";
}

function requestsLane(ids: Ids): string {
  if (ids.workstreamId !== undefined) return `requests:${ids.workstreamId}`;
  if (ids.machineId !== undefined && ids.projectId !== undefined) return `requests:${ids.machineId}/${ids.projectId}`;
  return "requests:fleet";
}

export function apply(c: Database, e: HubEvent): void {
  const at = atMs(e);
  const seq = e.seq;
  const m = e.machineId;
  const t = e.threadId;
  switch (e.type) {
    case "task.queued": {
      const task = dataStr(e, "taskId");
      if (task === undefined) return;
      closeOpen(c, QUEUE, "task_id = ?2", [task], at);
      const reason = dataStr(e, "queuedReason");
      open(c, `task/${task}/q/${seq}`, queueKind(dataStr(e, "queuedKind"), reason), at, taskIds(c, task), `task:${task}`, reason === undefined ? {} : { reason: headUtf16(reason, 200) });
      return;
    }
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const task = dataStr(e, "taskId");
      if (task === undefined) return;
      closeOpen(c, QUEUE, "task_id = ?2", [task], at);
      if (e.type === "task.started" && m !== undefined && t !== undefined) {
        // Node spans that arrived before the task knew its thread.
        const ids = taskIds(c, task);
        // Those spans change project, task and profile, so their hours' digests are built again.
        const hours = c
          .query<{ h: number }, [string, string]>(
            "SELECT DISTINCT start_ms / 3600000 AS h FROM time_spans WHERE machine_id = ?1 AND thread_id = ?2 AND task_id IS NULL AND role IS NULL",
          )
          .all(m, t)
          .map((r) => r.h);
        resetHours(c, hours);
        c.query(
          `UPDATE time_spans SET task_id = ?3, workstream_id = ?4, project_id = COALESCE(project_id, ?5),
             profile = COALESCE(profile, ?6)
           WHERE machine_id = ?1 AND thread_id = ?2 AND task_id IS NULL AND role IS NULL`,
        ).run(m, t, task, ids.workstreamId ?? null, ids.projectId ?? null, ids.profile ?? null);
      }
      return;
    }
    case "thread.usage_limited": {
      if (m === undefined || t === undefined) return;
      const ids = { ...who(c, m, t).ids };
      const run = dataStr(e, "runId");
      if (run !== undefined) ids.runId = run;
      open(c, `park/${m}/${t}/${seq}`, "park.usage", at, ids, threadLane(m, t));
      return;
    }
    case "thread.started":
      if (m === undefined || t === undefined) return;
      closeOpen(c, ["park.usage"], "machine_id = ?2 AND thread_id = ?3", [m, t], at);
      return;
    case "request.opened":
    case "request.updated": {
      const id = dataStr(e, "requestId");
      if (id === undefined) return;
      const key = `request/${id}`;
      if (dataStr(e, "state") === "open") {
        const r = getRequest(c, id);
        // A permission prompt's wait is the node's `wait.permission` span; its request adds no second one.
        if (!r || r.permission) return;
        const ids: Ids = {
          machineId: r.projectRef.machineId,
          projectId: r.projectRef.projectId,
          ...(r.workstreamId === undefined ? {} : { workstreamId: r.workstreamId }),
        };
        open(c, key, "wait.request", at, ids, requestsLane(ids), r.secret ? { key: r.secret.key } : {});
        return;
      }
      const start = c
        .query<{ start_ms: number }, [string]>("SELECT start_ms FROM time_spans WHERE src = 'h' AND src_key = ?1 AND end_ms IS NULL")
        .get(key)?.start_ms;
      if (start === undefined) return;
      const by = dataStr(e, "by");
      close(c, key, start, at, { decidedBy: "human", ...(by === undefined ? {} : { answeredBy: headUtf16(by, 80) }) });
      return;
    }
    case "lead.woken": {
      if (m === undefined || t === undefined) return;
      const first = Math.min(parseMs(dataStr(e, "firstTriggerAt") ?? "") ?? at, at);
      const raw = (e.data as { workstreamIds?: unknown } | undefined)?.workstreamIds;
      const ws = Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
      c.query("INSERT OR IGNORE INTO time_wakes (machine_id, thread_id, at_ms, workstreams) VALUES (?1, ?2, ?3, ?4)").run(m, t, at, JSON.stringify(ws));
      const ids = { ...who(c, m, t).ids };
      if (ws.length === 1) ids.workstreamId = ws[0] as string;
      const shares: Share[] = ws.map((id) => ({ scope: "order", id, of: ws.length }));
      const span: NewSpan = {
        src: "h",
        srcKey: `wake/${m}/${t}/${seq}`,
        kind: "wake.debounce",
        startMs: first,
        endMs: at,
        // A wake that waited while the lead was mid-turn: that part is the run's, so it is not counted twice.
        exclMs: at - first - busyMs(c, m, t, first, at),
        ids,
        lane: threadLane(m, t),
        status: "ok",
      };
      write(c, span, ws.length === 1 ? [] : shares);
      return;
    }
    case "write.delivered":
    case "write.expired": {
      if (m === undefined || t === undefined) return;
      const queued = parseMs(dataStr(e, "queuedAt") ?? "");
      if (queued === undefined) return;
      const ids = { ...who(c, m, t).ids };
      const run = dataStr(e, "runId");
      if (run !== undefined) ids.runId = run;
      writeHub(c, {
        src: "h",
        srcKey: `write/${m}/${t}/${seq}`,
        kind: "wait.offline",
        startMs: queued,
        endMs: at,
        ids,
        lane: threadLane(m, t),
        status: e.type === "write.expired" ? "cancelled" : "ok",
      });
      return;
    }
    case "workstream.created": {
      const w = dataStr(e, "workstreamId") ?? workstreamFromSummary(e);
      if (w === undefined || m === undefined || e.projectId === undefined) return;
      c.query("INSERT OR IGNORE INTO time_orders (workstream_id, machine_id, project_id, start_ms) VALUES (?1, ?2, ?3, ?4)").run(w, m, e.projectId, at);
      return;
    }
    case "workstream.done": {
      const w = dataStr(e, "workstreamId");
      if (w === undefined) return;
      c.query("UPDATE time_orders SET end_ms = ?2 WHERE workstream_id = ?1 AND end_ms IS NULL").run(w, at);
      const path = orderPath(c, w, at);
      if (path !== undefined) {
        c.query(
          `INSERT INTO time_paths (workstream_id, computed_ms, data) VALUES (?1, ?2, ?3)
           ON CONFLICT(workstream_id) DO UPDATE SET computed_ms = excluded.computed_ms, data = excluded.data`,
        ).run(w, at, JSON.stringify(path));
      }
      return;
    }
  }
}

/** How long thread `t` was running within `[from, to]`, from its `thread.*` events. */
export function busyMs(c: Database, m: string, t: string, from: number, to: number): number {
  const rows = c
    .query<{ created_ms: number; type: string }, [string, string, number, number]>(
      // The window by `created_ms` bounds the walk; left to itself SQLite takes the machine's or the types' index and
      // walks every such event the log holds, once per wake.
      `SELECT created_ms, type FROM events INDEXED BY events_by_created
       WHERE created_ms >= ?3 AND created_ms <= ?4 AND machine_id = ?1 AND type IN
         ('thread.started', 'thread.completed', 'thread.failed', 'thread.interrupted', 'thread.usage_limited')
         AND json_extract(data, '$.threadId') = ?2
       ORDER BY seq`,
    )
    .all(m, t, from - BUSY_LOOKBACK_MS, to);
  let since: number | undefined;
  let busy = 0;
  for (const r of rows) {
    if (r.type === "thread.started") {
      if (since === undefined) since = r.created_ms;
    } else if (since !== undefined) {
      busy += Math.max(Math.min(r.created_ms, to) - Math.max(since, from), 0);
      since = undefined;
    }
  }
  if (since !== undefined) busy += Math.max(to - Math.max(since, from), 0);
  return Math.max(Math.min(busy, to - from), 0);
}

function getRequest(c: Database, id: string): HumanRequest | undefined {
  if (!/^Q[0-9]+$/.test(id)) return undefined;
  const row = c.query<{ data: string }, [number]>("SELECT data FROM requests WHERE n = ?1").get(Number(id.slice(1)));
  try {
    return row ? (JSON.parse(row.data) as HumanRequest) : undefined;
  } catch {
    return undefined;
  }
}

function workstreamFromSummary(e: HubEvent): string | undefined {
  const i = e.summary.indexOf(" W");
  if (i < 0) return undefined;
  const id = /^[A-Za-z0-9]*/.exec(e.summary.slice(i + 1))?.[0] ?? "";
  return id.length > 1 && /^[0-9]+$/.test(id.slice(1)) ? id : undefined;
}
