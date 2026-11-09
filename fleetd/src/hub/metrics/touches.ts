// The person's touches on fleetd's own surfaces, folded out of the event log by the projector
// (crates/fleetd/src/hub/metrics/touches.rs): their chat messages, inline answers, steers, decisions, orders submitted
// directly, merges by hand (keyed on the merger's login) and the minutes the app was in use.
import type { ChatMessage, HubEvent, Workstream } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { parseMs } from "../store/time.ts";
import * as human from "./human.ts";
import type { MergeRow, TouchRow } from "./store.ts";

/** The answers to a request that are the person's act. */
const ANSWERED = new Set(["approved", "denied", "stored"]);

type Data = Record<string, unknown>;
const isObject = (v: unknown): v is Data => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (d: unknown, key: string) => (isObject(d) && typeof d[key] === "string" ? (d[key] as string) : undefined);

/** "W12" → 12; -1 for anything else, which matches no row. */
export function number(id: string): number {
  const n = /^.(\d+)$/.exec(id)?.[1];
  return n === undefined ? -1 : Number(n);
}

function touch(kind: string, src: string, srcKey: string, atMs: number, creditMs: number, more: Partial<TouchRow> = {}): TouchRow {
  return { src, srcKey, kind, atMs, creditMs, estimated: false, outside: false, ...more };
}

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The touch one event records, if it is the person's act. */
export function ofEvent(db: HubDb, e: HubEvent): TouchRow | undefined {
  const at = parseMs(e.at) ?? 0;
  const machineId = e.machineId;
  const projectId = e.projectId;
  const d = e.data;
  switch (e.type) {
    case "chat.message":
      return isObject(d) ? chat(db, d) : undefined;
    case "request.updated": {
      const id = str(d, "requestId");
      const state = str(d, "state");
      const by = str(d, "by");
      if (id === undefined || state === undefined || by === undefined || !by.startsWith("human:")) return undefined;
      if (!ANSWERED.has(state)) return undefined;
      // One answer is one touch; an answer time after this event is a later answer, after the request opened again.
      const a = answeredMs(db, id);
      const answered = a !== undefined && a <= at ? a : at;
      return touch("item.answered", "request", `${id}@${answered}`, answered, human.ITEM_MS, defined({
        machineId,
        projectId,
        workstreamId: str(d, "workstreamId"),
        keyId: by.slice("human:".length),
      }));
    }
    case "steer.queued": {
      if (!isObject(d) || typeof d.steerId !== "string" || typeof d.workstreamId !== "string") return undefined;
      const by = d.by;
      if (!isObject(by) || by.kind !== "human" || typeof by.keyName !== "string") return undefined;
      const owner = orderProject(db, d.workstreamId);
      return touch("steer", "steer", d.steerId, at, human.STEER_MS, defined({
        machineId: owner?.[0],
        projectId: owner?.[1],
        workstreamId: d.workstreamId,
        keyId: by.keyName,
      }));
    }
    case "decision.recorded": {
      const id = str(d, "decisionId");
      if (id === undefined || str(d, "source") !== "human") return undefined;
      const scope = isObject(d) ? d.scope : undefined;
      return touch("decision", "decision", id, at, human.DECISION_MS, defined({ machineId, projectId, workstreamId: str(scope, "workstreamId") }));
    }
    case "workstream.created": {
      const id = str(d, "workstreamId");
      const w = id === undefined ? undefined : workstream(db, id);
      return w ? order(w) : undefined;
    }
    case "app.presence": {
      if (!isObject(d) || typeof d.fromMs !== "number" || typeof d.toMs !== "number") return undefined;
      const { fromMs: from, toMs: to } = d;
      if (!(to > from) || projectId === undefined) return undefined;
      return touch("app.use", "app", String(e.seq), from, to - from, defined({
        machineId,
        projectId,
        endMs: to,
        keyId: typeof d.by === "string" ? d.by : undefined,
      }));
    }
    default:
      return undefined;
  }
}

/** A chat message the person wrote. A message too long for its event is read from the chat. */
function chat(db: HubDb, d: Data): TouchRow | undefined {
  if (d.author !== "human" || typeof d.messageId !== "string") return undefined;
  let m = isObject(d.message) ? (d.message as unknown as ChatMessage) : undefined;
  if (!m) {
    const row = db.conn.query<{ data: string }, [number]>("SELECT data FROM chat_messages WHERE n = ?1").get(number(d.messageId));
    try {
      m = row ? (JSON.parse(row.data) as ChatMessage) : undefined;
    } catch {
      m = undefined;
    }
  }
  if (!m || m.history !== undefined || m.item !== undefined) return undefined;
  const at = parseMs(m.createdAt);
  if (at === undefined) return undefined;
  return touch("chat.message", "chat", m.messageId, at, human.typedMs([...m.text].length), defined({
    machineId: m.projectRef.machineId,
    projectId: m.projectRef.projectId,
    keyId: m.by,
  }));
}

/** An order the person submitted directly; one the lead opened is the lead's act. */
function order(w: Workstream): TouchRow | undefined {
  const direct = w.source.channel === "app" || w.source.channel === "mcp";
  if (!direct || w.source.by !== "human") return undefined;
  const at = parseMs(w.source.at);
  if (at === undefined) return undefined;
  return touch("order.submitted", "order", w.workstreamId, at, human.typedMs([...w.source.text].length), {
    machineId: w.projectRef.machineId,
    projectId: w.projectRef.projectId,
    workstreamId: w.workstreamId,
  });
}

/** A human account merged a PR by hand: keyed on the merger's login, so it counts only when that is the person's. */
export function mergedByHand(m: MergeRow): TouchRow | undefined {
  if (m.mergedByKind !== "human" || (m.route !== "fleetd_by_hand" && m.route !== "outside")) return undefined;
  return touch("merge.by_hand", "merge", `${m.repo}#${m.unitKey}`, m.mergedMs, human.MERGE_BY_HAND_MS, defined({
    machineId: m.machineId,
    projectId: m.projectId,
    repo: m.repo,
    workstreamId: m.workstreamId,
    prNumber: m.prNumber,
    keyId: m.mergedBy,
    outside: m.route === "outside",
  }));
}

export function workstream(db: HubDb, id: string): Workstream | undefined {
  const row = db.conn.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?1").get(number(id));
  try {
    return row ? (JSON.parse(row.data) as Workstream) : undefined;
  } catch {
    return undefined;
  }
}

/** When a request was last answered, from its record. */
function answeredMs(db: HubDb, id: string): number | undefined {
  const row = db.conn
    .query<{ at: string | null }, [number]>("SELECT json_extract(data, '$.answeredAt') AS at FROM requests WHERE n = ?1")
    .get(number(id));
  return row?.at ? parseMs(row.at) : undefined;
}

function orderProject(db: HubDb, id: string): [string, string] | undefined {
  const row = db.conn
    .query<{ machine_id: string; project_id: string }, [number]>("SELECT machine_id, project_id FROM workstreams WHERE n = ?1")
    .get(number(id));
  return row ? [row.machine_id, row.project_id] : undefined;
}
