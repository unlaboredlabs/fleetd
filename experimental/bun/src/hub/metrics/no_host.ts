// A repo on a host fleetd can't read through an API: its landed changes come from git alone, the default branch's
// first-parent line as a node with it checked out reads it (crates/fleetd/src/hub/metrics/no_host.rs). Each commit is
// one landed change, routed by what git keeps: a `Fleetd-Change:` trailer or a Merged Change's sha is `train`; a merge
// of fleetd's work, or a commit with a `Fleetd-Task:` trailer, is `fleetd_by_hand`; any other merge `outside`; any
// other commit `direct`. A run of one task's commits in a row is one change; a merge of the default branch into itself
// is skipped as a merge-back.
import type { Change } from "../../shared/contracts.ts";
import { CAP_LANDED_LOG } from "../../shared/node_link.ts";
import type { GitCommit, LandedLog } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { getRequested } from "../leads/requested.ts";
import { link } from "../link/index.ts";
import type { HubDb } from "../store/db.ts";
import { parseMs } from "../store/time.ts";
import { BACKFILL_MS } from "./host_acts.ts";
import { change as changeOf, taskWorkstream } from "./project.ts";
import { hostOf } from "./source.ts";
import * as store from "./store.ts";
import type { MergeRow } from "./store.ts";
import { workstream } from "./touches.ts";

const LANDED_LOG_TIMEOUT_MS = 60_000;

/** Reads a checkout's landed log: a node's in the hub, a fake's in tests. */
export interface GitLog {
  canRead(hub: Hub, machine: string): boolean;
  read(hub: Hub, at: [string, string], branch: string, sinceMs: number, stopAt?: string): Promise<LandedLog>;
}

/** Asks the project's node. */
export const nodeLog: GitLog = {
  canRead: (hub, machine) => executors(hub).isConnected(machine) && link(hub).can(machine, CAP_LANDED_LOG),
  async read(hub, [machineId, projectId], branch, sinceMs, stopAt) {
    const out = await executors(hub).call(
      machineId,
      "read",
      { op: "landed_log", projectId, branch, sinceMs: Math.max(sinceMs, 0), ...(stopAt === undefined ? {} : { stopAt }) },
      LANDED_LOG_TIMEOUT_MS,
    );
    if (out.kind !== "landed_log") throw new Error(`${machineId}'s node sent no landed log`);
    const { kind: _kind, ...log } = out;
    return log as LandedLog;
  },
};

/** At most 500 characters, the last one an ellipsis when cut (api::clip). */
export const clip500 = (t: string) => ([...t].length > 500 ? `${[...t].slice(0, 499).join("")}…` : t);

/** Keeps why a repo's read failed; its rows stay. */
export function failed(hub: Hub, remote: string, why: string): void {
  try {
    hub.db.transaction((c) => {
      store.seeRepo(c, remote, hostOf(remote));
      c.query("UPDATE metric_repos SET last_error = ?2 WHERE repo = ?1").run(remote, clip500(why));
    });
  } catch (error) {
    console.error("metrics: a repo's read error not kept:", error);
  }
}

/** Reads one repo from git on a checkout of it and writes what it found; on failure it keeps its rows and says why. */
export async function sweepRepo(hub: Hub, log: GitLog, remote: string, now: number, write: (c: import("bun:sqlite").Database, row: MergeRow) => void): Promise<number> {
  try {
    return await readRepo(hub, log, remote, now, write);
  } catch (error) {
    failed(hub, remote, (error as Error).message);
    throw error;
  }
}

async function readRepo(hub: Hub, log: GitLog, remote: string, now: number, write: (c: import("bun:sqlite").Database, row: MergeRow) => void): Promise<number> {
  const c = hub.db.conn;
  const repo = c
    .query<{ b: string | null; cur: number | null; head: string | null }, [string]>(
      "SELECT default_branch AS b, merged_cursor_ms AS cur, commits_cursor_sha AS head FROM metric_repos WHERE repo = ?1",
    )
    .get(remote);
  const checkouts = c
    .query<{ m: string; p: string }, [string]>(
      "SELECT machine_id AS m, project_id AS p FROM metric_project_repos WHERE repo = ?1 ORDER BY machine_id, project_id",
    )
    .all(remote);
  const branch = repo?.b ?? undefined;
  if (branch === undefined) throw new Error("its default branch isn't known yet: no node has said");
  const at = checkouts.find((x) => log.canRead(hub, x.m));
  if (!at) throw new Error("no machine with it checked out is connected to read its git log");
  const since = repo?.cur ?? now - BACKFILL_MS;
  const landed = await log.read(hub, [at.m, at.p], branch, since, repo?.head ?? undefined);
  const out = rows(hub.db, remote, branch, [at.m, at.p], landed.commits);
  const head = landed.commits[0]?.sha;
  hub.db.transaction((tx) => {
    store.seeRepo(tx, remote, hostOf(remote));
    for (const row of out) write(tx, row);
    // A failed fetch read the last fetched copy: its rows count, but the repo isn't read as of now.
    const error = landed.fetchFailed === undefined ? null : clip500(`git fetch failed: ${landed.fetchFailed}`);
    tx.query(
      `UPDATE metric_repos SET default_branch = ?2, merged_cursor_ms = ?3,
         commits_cursor_sha = COALESCE(?4, commits_cursor_sha),
         last_ok_ms = CASE WHEN ?6 IS NULL THEN ?5 ELSE last_ok_ms END, last_error = ?6,
         backfilled_ms = COALESCE(backfilled_ms, ?7)
       WHERE repo = ?1`,
    ).run(remote, branch, now, head ?? null, now, error, since);
  });
  return out.length;
}

/** The Changes the train merged, by their merge sha: one each, or a batch's members. */
function mergedBySha(db: HubDb): Map<string, Change[]> {
  const out = new Map<string, Change[]>();
  for (const r of db.conn
    .query<{ sha: string; data: string }, []>(
      `SELECT lower(json_extract(data, '$.mergedSha')) AS sha, data FROM changes
       WHERE state = 'merged' AND json_extract(data, '$.mergedSha') IS NOT NULL ORDER BY n`,
    )
    .all()) {
    try {
      const c = JSON.parse(r.data) as Change;
      const list = out.get(r.sha) ?? [];
      list.push(c);
      out.set(r.sha, list);
    } catch {
      // A row this build can't read.
    }
  }
  return out;
}

const numbered = (w: string, prefix: string) => w.startsWith(prefix) && /^[1-9][0-9]*$/.test(w.slice(1));

/** A `Fleetd-Change` trailer's parts: "X12 (T45, W9)" → ["X12", "T45", "W9"]. */
export function changeTrailer(value: string): [string, string | undefined, string | undefined] | undefined {
  const words = value.split(/[\s(),]+/u).filter((w) => w !== "");
  const id = words[0];
  if (id === undefined || !numbered(id, "X")) return undefined;
  let task: string | undefined;
  let ws: string | undefined;
  for (const w of words.slice(1)) {
    if (numbered(w, "T")) task ??= w;
    else if (numbered(w, "W")) ws ??= w;
  }
  return [id, task, ws];
}

/** The PR a merge commit's subject names: "Merge pull request #12 from …" (GitHub), "… (#12) from …" (Gitea). */
export function subjectPr(subject: string): number | undefined {
  const digits = (t: string) => {
    const d = /^\d+/.exec(t)?.[0];
    const v = d === undefined ? undefined : Number(d);
    return v !== undefined && v > 0 ? v : undefined;
  };
  if (subject.startsWith("Merge pull request #")) return digits(subject.slice("Merge pull request #".length));
  const at = subject.lastIndexOf("(#");
  if (at < 0) return undefined;
  const rest = subject.slice(at + 2);
  const v = digits(rest);
  return v !== undefined && rest.replace(/^\d+/, "").startsWith(")") ? v : undefined;
}

/** node::landed::branch_task: `fleetd/T12-…` → "T12". */
export function branchTask(branch: string): string | undefined {
  if (!branch.startsWith("fleetd/T")) return undefined;
  const d = /^\d+/.exec(branch.slice("fleetd/T".length))?.[0];
  return d !== undefined && !d.startsWith("0") ? `T${d}` : undefined;
}

/** The fleetd branch a merge commit's subject names. */
export function subjectTask(subject: string): string | undefined {
  const at = subject.indexOf("fleetd/");
  return at < 0 ? undefined : branchTask(subject.slice(at));
}

/** A merge of the default branch into itself: `git pull` on it. */
export const isSync = (subject: string, branch: string) =>
  subject.startsWith(`Merge branch '${branch}' of `) || (subject.startsWith("Merge remote-tracking branch '") && subject.includes(`/${branch}'`));

function baseRow(remote: string, c: GitCommit, owner?: [string, string]): MergeRow {
  return {
    repo: remote,
    unitKey: `commit:${c.sha}`,
    ...(owner ? { machineId: owner[0], projectId: owner[1] } : {}),
    mergedMs: c.atMs,
    mergedSha: c.sha.toLowerCase(),
    ...(c.subject !== "" ? { title: c.subject } : {}),
    route: "",
    src: "git",
  };
}

/** Fills a fleetd row's order: its workstream and when it was asked for. */
function withOrder(db: HubDb, row: MergeRow, ws?: string): void {
  const w = ws ?? (row.taskId === undefined ? undefined : taskWorkstream(db, row.taskId));
  const order = w === undefined ? undefined : workstream(db, w);
  if (order) {
    const r = getRequested(db, order);
    row.requestedMs = r.atMs;
    row.requestedBasis = r.basis;
  }
  if (w === undefined) delete row.workstreamId;
  else row.workstreamId = w;
}

/** The train's row for one Change a commit landed. */
function trainRow(db: HubDb, base: MergeRow, id: string, change: Change | undefined, task?: string, ws?: string): MergeRow {
  const row: MergeRow = {
    ...base,
    unitKey: change ? `pr:${change.prNumber}` : `change:${id}`,
    route: "train",
    changeId: id,
    mergedByKind: "train",
  };
  if (change) {
    row.prNumber = change.prNumber;
    row.url = change.prUrl;
    const first = parseMs(change.createdAt);
    if (first !== undefined) row.firstPrMs = first;
    row.machineId = change.projectRef.machineId;
    row.projectId = change.projectRef.projectId;
  }
  const t = change?.taskId ?? task;
  if (t !== undefined) row.taskId = t;
  withOrder(db, row, change?.workstreamId ?? ws);
  return row;
}

/** The rows the default branch's line makes, newest first, as the module's rules route them. */
export function rows(db: HubDb, remote: string, branch: string, owner: [string, string] | undefined, commits: GitCommit[]): MergeRow[] {
  const out: MergeRow[] = [];
  // The tasks of the last commit when it was one of a task's by hand: the commits after it in a row are the same rebase.
  let run: string | undefined;
  const landed = mergedBySha(db);
  for (const c of commits) {
    const base = baseRow(remote, c, owner);
    const merge = c.parents.length > 1;
    const byTrailer = (c.changes ?? []).flatMap((v) => {
      const t = changeTrailer(v);
      return t ? [t] : [];
    });
    if (byTrailer.length > 0) {
      run = undefined;
      for (const [id, task, ws] of byTrailer) {
        out.push(trainRow(db, base, id, changeOf(db, id), task, ws));
      }
      continue;
    }
    const sha = c.sha.toLowerCase();
    const merged = landed.get(sha);
    if (merged) {
      landed.delete(sha);
      run = undefined;
      for (const change of merged) out.push(trainRow(db, base, change.changeId, change));
      continue;
    }
    const tasks = c.tasks ?? [];
    const key = JSON.stringify(tasks);
    if (!merge && tasks.length > 0 && run === key) continue;
    run = undefined;
    const row = base;
    if (c.authorName.endsWith("[bot]")) {
      row.route = store.SKIPPED;
      row.skipWhy = "bot";
      row.authorKind = "bot";
    } else if (merge && isSync(c.subject, branch)) {
      row.route = store.SKIPPED;
      row.skipWhy = "merge_back";
    } else {
      const task = merge ? (c.mergedTasks?.[0] ?? subjectTask(c.subject) ?? tasks[0]) : tasks[0];
      const pr = merge ? subjectPr(c.subject) : undefined;
      if (pr !== undefined) row.prNumber = pr;
      row.route = task !== undefined ? "fleetd_by_hand" : merge ? "outside" : "direct";
      if (task !== undefined) {
        row.taskId = task;
        withOrder(db, row);
        if (!merge) run = key;
      }
    }
    out.push(row);
  }
  return out;
}
