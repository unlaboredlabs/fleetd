// The one writer: node batches and hub spans, each committed in one transaction
// with labels, roll-ups and the node's cursor; a node batch is acked only after its commit. Node spans move onto the
// hub clock and are joined to their task, order or lead here.
import type { Database } from "bun:sqlite";
import type { SpanExtra, SpanKind, SpanStatus } from "../../shared/contracts.ts";
import { kindOf, parseKind } from "./kinds.ts";
import { cursor, type Ids, linkParents, type NewSpan, setCursor, type Share, write } from "./store.ts";

/** A wake explains a lead run that started at most this long after it (the send, then claude picking it up). */
const WAKE_SLACK_MS = 120_000;

/** A node span as the `spans` frame carries it. */
export type SpanWire = {
  key: string;
  kind: SpanKind;
  sessionId: string;
  runId?: string;
  parent?: string;
  startMs: number;
  endMs: number;
  exclMs?: number;
  label?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  extra?: SpanExtra;
};

export type SpansFrame = { fromRid: number; toRid: number; spans: unknown[] };

export type Ack = { upto: number; rewind: boolean };

export function gap(now: number, count: number): NewSpan {
  return {
    src: "h",
    srcKey: `gap/${now}`,
    kind: "gap",
    startMs: now,
    endMs: now,
    ids: {},
    lane: "fleet",
    status: "incomplete",
    extra: { count, reason: "the hub's span writer was full" },
  };
}

/** Closes the open hub spans under `prefix`. */
export function closePrefix(c: Database, prefix: string, end: number): void {
  const open = c
    .query<{ src_key: string; kind: number; start_ms: number }, [string]>(
      `SELECT src_key, kind, start_ms FROM time_spans WHERE src = 'h' AND end_ms IS NULL
         AND substr(src_key, 1, length(?1)) = ?1`,
    )
    .all(prefix);
  for (const o of open) {
    write(c, {
      src: "h",
      srcKey: o.src_key,
      kind: kindOf(o.kind) ?? "runner.other",
      startMs: o.start_ms,
      endMs: Math.max(end, o.start_ms),
      ids: {},
      lane: "",
      status: "ok",
    });
  }
}

/** A hub span, joined to its task's order and project when it names only the task. */
export function writeHub(c: Database, s: NewSpan): void {
  const span: NewSpan = { ...s, ids: { ...s.ids } };
  const t = span.ids.taskId;
  if (t !== undefined && (span.ids.workstreamId === undefined || span.ids.projectId === undefined) && /^T[0-9]+$/.test(t)) {
    const row = c
      .query<{ machine_id: string; project_id: string; workstream_id: string }, [number]>(
        "SELECT machine_id, project_id, workstream_id FROM tasks WHERE n = ?1",
      )
      .get(Number(t.slice(1)));
    if (row) {
      span.ids.machineId ??= row.machine_id;
      span.ids.projectId ??= row.project_id;
      span.ids.workstreamId ??= row.workstream_id;
    }
  }
  write(c, span);
}

/** Who a node session is: a task's thread, a lead, or unknown yet. */
export type Who = { ids: Ids; lead: boolean };

/** A stored task's profile; a row without one is high, as the hub reads it (ProfileName::legacy). */
export const profileOf = (task: { profile?: unknown }) => (typeof task.profile === "string" ? task.profile : "high");

export function who(c: Database, machine: string, thread: string): Who {
  const task = c
    .query<{ n: number; project_id: string; workstream_id: string; data: string }, [string, string]>(
      `SELECT n, project_id, workstream_id, data FROM tasks WHERE machine_id = ?1 AND thread_id = ?2
       ORDER BY n DESC LIMIT 1`,
    )
    .get(machine, thread);
  if (task) {
    let data: { kind?: unknown; qa?: unknown; profile?: unknown } = {};
    try {
      data = JSON.parse(task.data);
    } catch {
      data = {};
    }
    const role = data.kind === "read" ? "reader" : data.kind === "review" ? (data.qa === true ? "qa" : "reviewer") : "implementer";
    return {
      ids: {
        machineId: machine,
        projectId: task.project_id,
        workstreamId: task.workstream_id,
        taskId: `T${task.n}`,
        threadId: thread,
        role,
        profile: profileOf(data),
      },
      lead: false,
    };
  }
  // A lead's row keeps the profile its session started on; one started before fleetd kept it ran on the default.
  const lead = c
    .query<{ project_id: string; profile: string | null }, [string, string]>(
      `SELECT project_id, COALESCE(profile, (SELECT name FROM profiles WHERE is_default = 1)) AS profile FROM leads
       WHERE machine_id = ?1 AND thread_id = ?2`,
    )
    .get(machine, thread);
  const project =
    lead?.project_id ??
    c.query<{ project_id: string }, [string, string]>("SELECT project_id FROM threads WHERE machine_id = ?1 AND thread_id = ?2").get(machine, thread)
      ?.project_id;
  return {
    ids: {
      machineId: machine,
      ...(project === undefined ? {} : { projectId: project }),
      threadId: thread,
      ...(lead ? { role: "lead" } : {}),
      ...(lead?.profile ? { profile: lead.profile } : {}),
    },
    lead: lead !== null && lead !== undefined,
  };
}

export const threadLane = (machine: string, thread: string) => `thread:${machine}/${thread}`;

/** The orders a lead run served: the newest wake of that lead at or before the run's start. */
function leadRunOrders(c: Database, machine: string, thread: string, run: string, startMs: number): string[] {
  const known = c
    .query<{ workstream_id: string }, [string, string, string]>(
      "SELECT workstream_id FROM time_lead_runs WHERE machine_id = ?1 AND thread_id = ?2 AND run_id = ?3",
    )
    .all(machine, thread, run)
    .map((r) => r.workstream_id);
  if (known.length > 0) return known.filter((w) => w !== "");
  const wake = c
    .query<{ workstreams: string }, [string, string, number, number]>(
      `SELECT workstreams FROM time_wakes WHERE machine_id = ?1 AND thread_id = ?2 AND at_ms <= ?3
         AND at_ms >= ?4 ORDER BY at_ms DESC LIMIT 1`,
    )
    .get(machine, thread, startMs + 2_000, startMs - WAKE_SLACK_MS);
  let ws: string[] = [];
  try {
    ws = wake ? (JSON.parse(wake.workstreams) as string[]) : [];
  } catch {
    ws = [];
  }
  const insert = c.query(
    `INSERT OR IGNORE INTO time_lead_runs (machine_id, thread_id, run_id, workstream_id, n, at_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  if (ws.length === 0) insert.run(machine, thread, run, "", 0, startMs);
  for (const w of ws) insert.run(machine, thread, run, w, ws.length, startMs);
  return ws;
}

/** A span as the node sent it, checked as the contracts would decode it; undefined for one that doesn't. */
export function decodeWire(raw: unknown): SpanWire | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const w = raw as Record<string, unknown>;
  const kind = typeof w.kind === "string" ? parseKind(w.kind) : undefined;
  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  if (typeof w.key !== "string" || !w.key || kind === undefined || typeof w.sessionId !== "string" || !int(w.startMs) || !int(w.endMs)) {
    return undefined;
  }
  return { ...(w as unknown as SpanWire), kind, status: (w.status as SpanStatus | undefined) ?? "ok" };
}

/**
 * Stores a frame only when it continues the node's stored cursor, so the cursor (and the node's delete on ack) never
 * passes rows the hub has not stored. A frame after a gap is refused with a rewind to the cursor.
 */
export function ingestFrame(c: Database, machine: string, offset: number, frame: SpansFrame): Ack {
  const source = `node:${machine}`;
  let at = Math.max(cursor(c, source) ?? 0, 0);
  // A frame from row 1 below the cursor is an outbox that started over: follow it.
  if (frame.fromRid === 1 && frame.toRid < at) {
    c.query("UPDATE time_cursors SET value = 0 WHERE source = ?1").run(source);
    at = 0;
  }
  if (frame.fromRid > at + 1) return { upto: at, rewind: true };
  ingestNode(c, machine, offset, frame.spans.flatMap((s) => decodeWire(s) ?? []));
  const upto = Math.max(at, frame.toRid);
  setCursor(c, source, upto);
  return { upto, rewind: false };
}

export function ingestNode(c: Database, machine: string, offset: number, spans: SpanWire[]): void {
  const whos = new Map<string, Who>();
  const parents: [string, string][] = [];
  const src = `n:${machine}`;
  // Envelopes first, so children find their parent in the same pass.
  const order = [...spans].sort((a, b) => Number(a.parent !== undefined) - Number(b.parent !== undefined) || a.startMs - b.startMs);
  for (const w of order) {
    const session = w.sessionId;
    let found = whos.get(session);
    if (!found) {
      found = who(c, machine, session);
      whos.set(session, found);
    }
    const ids: Ids = { ...found.ids, ...(w.runId === undefined ? {} : { runId: w.runId }) };
    if (w.runId === undefined) delete ids.runId;
    const start = w.startMs + offset;
    const end = w.endMs + offset;
    let extra = w.extra;
    if (Math.abs(offset) > 100) extra = { ...(extra ?? {}), nodeStartMs: w.startMs };
    let shares: Share[] = [];
    if (found.lead && ids.runId !== undefined) {
      const orders = leadRunOrders(c, machine, session, ids.runId, start);
      shares = orders.map((id) => ({ scope: "order", id, of: orders.length }));
    }
    write(
      c,
      {
        src,
        srcKey: w.key,
        kind: w.kind,
        startMs: start,
        endMs: Math.max(end, start),
        ...(w.exclMs === undefined ? {} : { exclMs: w.exclMs }),
        ids,
        lane: threadLane(machine, session),
        ...(w.label === undefined ? {} : { label: w.label }),
        ...(w.exitCode === undefined ? {} : { exitCode: w.exitCode }),
        ...(w.outBytes === undefined ? {} : { outBytes: w.outBytes }),
        status: w.status,
        ...(extra === undefined ? {} : { extra }),
      },
      shares,
    );
    if (w.parent !== undefined) parents.push([w.key, w.parent]);
  }
  linkParents(c, src, parents);
}
