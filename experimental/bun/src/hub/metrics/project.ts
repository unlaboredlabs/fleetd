// Landed changes folded out of the event log (crates/fleetd/src/hub/metrics/project.rs): it walks the log in seq order
// from `time_cursors('metrics:events')` and wakes on each append; a replay writes the same rows.
//
// - `pr.merged`: a `train` row, timed from its order's request.
// - `pr.merged_outside`: `fleetd_by_hand` when fleetd wrote it (a Change, or a `fleetd/` head), else `outside`; a
//   bot's PR, or one into another base, is kept as skipped.
// - `change.state`: the first move to `ready` is when its review passed.
// - `workstream.created`: the order's request time, for rows that landed before it was known.
// - the person's acts, merges by hand and app use, as touches (touches.ts).
import type { Database } from "bun:sqlite";
import type { Change, HubEvent, HubEventType, TrainEventData } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { getRequested } from "../leads/requested.ts";
import type { HubDb } from "../store/db.ts";
import { type EventLog, events } from "../store/events.ts";
import { parseMs } from "../store/time.ts";
import { cursor as readCursor, setCursor } from "../time/store.ts";
import * as store from "./store.ts";
import type { MergeRow, TouchRow } from "./store.ts";
import { mergedByHand, number, ofEvent, workstream } from "./touches.ts";

const CURSOR = "metrics:events";
const TYPES: HubEventType[] = [
  "pr.merged",
  "pr.merged_outside",
  "change.state",
  "workstream.created",
  "chat.message",
  "request.updated",
  "steer.queued",
  "decision.recorded",
  "app.presence",
];
/** The branches fleetd's write tasks push: `fleetd/T<n>-…`. */
const FLEETD_BRANCH = "fleetd/";

/** One event's effect on the tables. */
type Fold =
  | { kind: "merge"; row: MergeRow }
  | { kind: "review"; changeId: string; atMs: number }
  | { kind: "requested"; workstreamId: string; atMs: number; basis: string }
  | { kind: "touch"; row: TouchRow };

/** Projects one page after `cursor`: the cursor to resume from, and whether more pages are ready. */
export function step(db: HubDb, log: EventLog, cursor: number): [number, boolean] {
  const page = log.page(cursor, TYPES);
  if (page.events.length === 0 && page.cursor === cursor) return [cursor, page.more];
  const folds: Fold[] = [];
  for (const e of page.events) {
    const fold = resolve(db, e);
    if (fold?.kind === "merge") {
      const t = mergedByHand(fold.row);
      if (t) folds.push({ kind: "touch", row: t });
    }
    if (fold) folds.push(fold);
    const t = ofEvent(db, e);
    if (t) folds.push({ kind: "touch", row: t });
  }
  const first = page.events[0];
  const firstMs = first ? parseMs(first.at) : undefined;
  db.transaction((c) => {
    if (cursor === 0) knownSince(c, firstMs);
    for (const fold of folds) write(c, fold);
    // A catch-up beside the loop may have saved a later cursor: never move it back.
    const saved = readCursor(c, CURSOR) ?? 0;
    setCursor(c, CURSOR, Math.max(page.cursor, saved));
  });
  return [page.cursor, page.more];
}

/** Folds one page past the stored cursor now, for a reader that must not lag the event that woke it. */
export function catchUp(hub: Hub): void {
  step(hub.db, events(hub), readCursor(hub.db.conn, CURSOR) ?? 0);
}

/** Runs the projector until the hub stops: every page now, then again after each append. */
export function run(hub: Hub): void {
  const log = events(hub);
  let cursor = readCursor(hub.db.conn, CURSOR) ?? 0;
  // One pass at a time: an append during a pass's yield is folded by that pass's next page, or by one more pass.
  let busy = false;
  let again = false;
  const pass = async () => {
    try {
      do {
        again = false;
        for (;;) {
          if (hub.shutdown.signal.aborted) return;
          const [next, more] = step(hub.db, log, cursor);
          cursor = next;
          if (!more) break;
          // A long backlog is folded a page at a time, the hub serving between pages (Rust folds on a worker thread).
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (again);
    } catch (error) {
      console.error("metrics: events not projected:", error);
      const retry = setTimeout(wake, 5000);
      hub.shutdown.signal.addEventListener("abort", () => clearTimeout(retry), { once: true });
    } finally {
      busy = false;
    }
  };
  // Appends in one tick are folded together, after the appender's transaction.
  const wake = () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    queueMicrotask(() => void pass());
  };
  const unsubscribe = log.subscribe(wake);
  hub.shutdown.signal.addEventListener("abort", unsubscribe, { once: true });
  wake();
}

/** Merges are known from the oldest event the projector's first pass found (the log keeps 30 days). */
function knownSince(c: Database, firstMs: number | undefined): void {
  const oldest = c.query<{ v: number | null }, []>("SELECT MIN(created_ms) AS v FROM events").get()?.v ?? undefined;
  const ms = oldest ?? firstMs;
  if (ms !== undefined) c.query("INSERT OR IGNORE INTO time_cursors (source, value) VALUES (?1, ?2)").run(store.KNOWN_SINCE, ms);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function resolve(db: HubDb, e: HubEvent): Fold | undefined {
  const at = parseMs(e.at) ?? 0;
  switch (e.type) {
    case "pr.merged":
    case "pr.merged_outside": {
      if (!isObject(e.data)) return undefined;
      const d = e.data as TrainEventData;
      const fallback: [string, string] | undefined =
        e.machineId !== undefined && e.projectId !== undefined ? [e.machineId, e.projectId] : undefined;
      const def = d.repo === undefined ? undefined : defaultBranch(db, store.githubRemote(d.repo));
      const row = landed(db, e.type === "pr.merged", d, at, fallback, def);
      return row ? { kind: "merge", row } : undefined;
    }
    case "change.state": {
      const d = e.data;
      return isObject(d) && d.to === "ready" && typeof d.changeId === "string" ? { kind: "review", changeId: d.changeId, atMs: at } : undefined;
    }
    case "workstream.created": {
      const id = isObject(e.data) && typeof e.data.workstreamId === "string" ? e.data.workstreamId : undefined;
      const w = id === undefined ? undefined : workstream(db, id);
      if (!w) return undefined;
      const r = getRequested(db, w);
      return { kind: "requested", workstreamId: w.workstreamId, atMs: r.atMs, basis: r.basis };
    }
    default:
      return undefined;
  }
}

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * The row a merge makes, whoever reports it: the train's `pr.merged`, its `pr.merged_outside`, or the host sweep.
 * `at` stands in for a missing `mergedAt`, and `fallback` owns it when no train or Change does. A merge without the
 * train counts only into `defaultBranch`; one into any other base is skipped as such.
 */
export function landed(
  db: HubDb,
  train: boolean,
  d: TrainEventData,
  at: number,
  fallback: [string, string] | undefined,
  defaultBranchName: string | undefined,
): MergeRow | undefined {
  if (d.repo === undefined || d.prNumber === undefined) return undefined;
  const repo = d.repo;
  const pr = d.prNumber;
  const ch = d.changeId === undefined ? undefined : change(db, d.changeId);
  // A fleetd branch names its task: `fleetd/T12-…`.
  const headTask = d.head?.startsWith(FLEETD_BRANCH) ? /^T(\d+)/.exec(d.head.slice(FLEETD_BRANCH.length))?.[1] : undefined;
  const fleetd = ch !== undefined || d.changeId !== undefined || (d.head?.startsWith(FLEETD_BRANCH) ?? false);
  const taskId = d.taskId ?? ch?.taskId ?? (headTask === undefined ? undefined : `T${headTask}`);
  let workstreamId: string | undefined = d.workstreamId ?? ch?.workstreamId;
  if (workstreamId === undefined && taskId !== undefined && fleetd) workstreamId = taskWorkstream(db, taskId);
  let route: string;
  let skipWhy: string | undefined;
  if (train) route = "train";
  else if (d.authorKind === "bot") [route, skipWhy] = [store.SKIPPED, "bot"];
  else if (d.base !== undefined && defaultBranchName !== undefined && d.base !== defaultBranchName) {
    [route, skipWhy] = [store.SKIPPED, "other_base"];
  } else route = fleetd ? "fleetd_by_hand" : "outside";
  const ours = fleetd || train;
  const w = ours && workstreamId !== undefined ? workstream(db, workstreamId) : undefined;
  const requested = w ? getRequested(db, w) : undefined;
  const remote = store.githubRemote(repo);
  // The project that owns it: the train's owner, else its Change's, else the reporter's.
  const owner = trainOwner(db, repo) ?? (ch ? ([ch.projectRef.machineId, ch.projectRef.projectId] as [string, string]) : undefined) ?? fallback;
  const mergedAt = d.mergedAt === undefined ? undefined : parseMs(d.mergedAt);
  const prCreated = d.prCreatedAt === undefined ? undefined : parseMs(d.prCreatedAt);
  return defined<MergeRow>({
    repo: remote,
    unitKey: `pr:${pr}`,
    machineId: owner?.[0],
    projectId: owner?.[1],
    prNumber: pr,
    mergedMs: mergedAt ?? at,
    mergedSha: d.mergedSha?.toLowerCase() ?? ch?.mergedSha,
    route,
    skipWhy,
    workstreamId: ours ? workstreamId : undefined,
    taskId: ours ? taskId : undefined,
    changeId: d.changeId,
    batchPr: d.batchPr,
    requestedMs: requested?.atMs,
    requestedBasis: requested?.basis,
    prCreatedMs: prCreated,
    // A Change is made when its PR is enqueued, right after the task opens it.
    firstPrMs: ch ? parseMs(ch.createdAt) : undefined,
    authorKind: d.authorKind,
    mergedByKind: train ? "train" : d.mergedByKind,
    mergedBy: train ? undefined : d.mergedBy,
    url: d.prUrl ?? ch?.prUrl ?? `https://${remote}/pull/${pr}`,
    src: "event",
  });
}

function write(c: Database, fold: Fold): void {
  switch (fold.kind) {
    case "merge": {
      const m = { ...fold.row };
      if (m.changeId !== undefined) {
        const passed = store.reviewPassed(c, m.changeId);
        if (passed === undefined) delete m.reviewPassedMs;
        else m.reviewPassedMs = passed;
      }
      store.seeRepo(c, m.repo, "github");
      store.upsertMerge(c, m);
      return;
    }
    case "review":
      return store.stampReview(c, fold.changeId, fold.atMs);
    case "requested":
      return store.setRequested(c, fold.workstreamId, fold.atMs, fold.basis);
    case "touch":
      return store.upsertTouch(c, fold.row);
  }
}

export function change(db: HubDb, id: string): Change | undefined {
  const row = db.conn.query<{ data: string }, [number]>("SELECT data FROM changes WHERE n = ?1").get(number(id));
  try {
    return row ? (JSON.parse(row.data) as Change) : undefined;
  } catch {
    return undefined;
  }
}

export function taskWorkstream(db: HubDb, task: string): string | undefined {
  return db.conn.query<{ w: string | null }, [number]>("SELECT workstream_id AS w FROM tasks WHERE n = ?1").get(number(task))?.w ?? undefined;
}

/** A repo's default branch, once the sweep or a project's node said. */
function defaultBranch(db: HubDb, remote: string): string | undefined {
  return (
    db.conn.query<{ b: string | null }, [string]>("SELECT default_branch AS b FROM metric_repos WHERE repo = ?1").get(remote)?.b ??
    undefined
  );
}

function trainOwner(db: HubDb, repo: string): [string, string] | undefined {
  const row = db.conn
    .query<{ machine_id: string; project_id: string }, [string]>("SELECT machine_id, project_id FROM trains WHERE repo = ?1")
    .get(repo.toLowerCase());
  return row ? [row.machine_id, row.project_id] : undefined;
}
