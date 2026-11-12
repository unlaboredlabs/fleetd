// How a node's spans and the hub's events become time spans, without the database (ingest.ts and project.ts store
// them): a node span as its frame carries it and checked, the gap span, lanes and profiles, a queue wait's kind, the
// order an event's summary names, and a closing span's extra.
import type { HubEvent, SpanExtra, SpanKind, SpanStatus } from "../../shared/contracts.ts";
import { parseKind } from "./kinds.ts";
import type { Ids, NewSpan } from "./spans.ts";

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

/** A stored task's profile; a row without one is high, as the hub reads it (ProfileName::legacy). */
export const profileOf = (task: { profile?: unknown }) => (typeof task.profile === "string" ? task.profile : "high");

export const threadLane = (machine: string, thread: string) => `thread:${machine}/${thread}`;

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

export function queueKind(kind: string | undefined, reason: string | undefined): SpanKind {
  const k = kind ?? reason ?? "";
  if (k.startsWith("lease")) return "queue.lease";
  if (k.includes("offline")) return "queue.offline";
  if (k.includes("usage")) return "queue.usage";
  return "queue.slot";
}

export function requestsLane(ids: Ids): string {
  if (ids.workstreamId !== undefined) return `requests:${ids.workstreamId}`;
  if (ids.machineId !== undefined && ids.projectId !== undefined) return `requests:${ids.machineId}/${ids.projectId}`;
  return "requests:fleet";
}

export function workstreamFromSummary(e: HubEvent): string | undefined {
  const i = e.summary.indexOf(" W");
  if (i < 0) return undefined;
  const id = /^[A-Za-z0-9]*/.exec(e.summary.slice(i + 1))?.[0] ?? "";
  return id.length > 1 && /^[0-9]+$/.test(id.slice(1)) ? id : undefined;
}

/** A closing event's extra over the open span's: who decided or answered, and its key, replace the old ones. */
export function mergeExtra(old: SpanExtra | undefined, extra: SpanExtra | undefined): SpanExtra | undefined {
  let merged = extra ?? old;
  if (old && extra) {
    merged = { ...old };
    if (extra.decidedBy !== undefined) merged.decidedBy = extra.decidedBy;
    if (extra.answeredBy !== undefined) merged.answeredBy = extra.answeredBy;
    if (extra.key !== undefined) merged.key = extra.key;
  }
  return merged;
}
