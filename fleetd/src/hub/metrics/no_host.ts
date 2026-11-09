// A repo on a host fleetd can't read through an API (a bare ssh remote, a self-hosted Gitea with no token):
// its landed changes come from git alone, the default branch's first-parent
// line as a node with it checked out reads it (`landed_log`). Each commit on that line is one landed change, routed by
// what git keeps:
//
// - a `Fleetd-Change:` trailer (the train's squash), or the merge sha of a Merged Change: `train`, one per Change;
// - a merge commit that brought in commits with a `Fleetd-Task:` trailer, or merged a `fleetd/T…` branch, or any other
//   commit carrying that trailer (a squash or rebase by hand): `fleetd_by_hand`;
// - any other merge commit: `outside`, a PR merged by hand;
// - any other commit: `direct`, pushed straight. A PR squash-merged on the host reads so too: git can't tell.
//
// A run of commits of one task in a row is one change (a rebase merge). A merge of the default branch into itself (a
// `git pull`) is skipped as a merge-back. Agents' commits carry `Fleetd-Task` only in a repo that already has
// `extensions.worktreeConfig` on (node trailer hooks); elsewhere fleetd's work merged by hand is found only where a
// merge names its `fleetd/T…` branch. Who merged, reviews, bots, PR open times and fleetd's work merged by hand that git
// doesn't name can't be known this way, and the coverage says so (tools.ts GIT_UNKNOWN).
import type { Change } from "../../shared/contracts.ts";
import { CAP_LANDED_LOG } from "../../shared/node_link.ts";
import type { GitCommit, LandedLog } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { clip } from "../api/refusals.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import { getRequested } from "../leads/requested.ts";
import { link } from "../link/index.ts";
import type { HubDb } from "../store/db.ts";
import { parseMs } from "../store/time.ts";
import { branchTask } from "../../node/worktree/hooks.ts";
import { BACKFILL_MS } from "./host_acts.ts";
import { change as changeOf, taskWorkstream } from "./project.ts";
import { hostOf } from "./source.ts";
import * as store from "./store.ts";
import type { MergeRow } from "./store.ts";
import { failed, sweepArea, write } from "./sweep.ts";
import { workstream as workstreamOf } from "./touches.ts";

/** How long a node has to read a checkout's landed log (executor/repos.rs LANDED_LOG_TIMEOUT). */
const LANDED_LOG_TIMEOUT_MS = 60_000;

/** A project's checkout: machine, project. */
export type At = [string, string];

/** Reads a checkout's landed log: a node's in the hub, a local checkout's in tests. It throws why it couldn't. */
export interface GitLog {
  /** Whether `machine` can be asked now. */
  canRead(hub: Hub, machine: string): boolean;
  read(hub: Hub, at: At, branch: string, sinceMs: number, stopAt: string | undefined): Promise<LandedLog>;
}

/** Asks the project's node. */
export const nodeLog: GitLog = {
  canRead: (hub, machine) => executors(hub).isConnected(machine) && link(hub).can(machine, CAP_LANDED_LOG),
  async read(hub, [m, p], branch, sinceMs, stopAt) {
    if (branch === "") throw ExecutorError.failed(m, "read", "branch is empty");
    if (stopAt === "") throw ExecutorError.failed(m, "read", "stop at is empty");
    const call = { op: "landed_log" as const, projectId: p, branch, sinceMs: Math.max(sinceMs, 0), ...(stopAt === undefined ? {} : { stopAt }) };
    const out = await executors(hub).call(m, "read", call, LANDED_LOG_TIMEOUT_MS);
    if (out.kind !== "landed_log") throw ExecutorError.failed(m, "read", "the node sent no landed log");
    const { kind: _kind, ...log } = out;
    return log;
  },
};

class Unread extends Error {}

/** Reads one repo from git on a checkout of it and writes what it found; on failure the repo keeps its rows and says why. */
export async function sweepRepo(hub: Hub, remote: string, now: number): Promise<number> {
  try {
    return await readRepo(hub, remote, now);
  } catch (error) {
    const why = error instanceof Unread ? error.message : `the hub's database: ${whyOf(error)}`;
    failed(hub, remote, why);
    throw new Unread(why);
  }
}

/** What a failure said. */
const whyOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readRepo(hub: Hub, remote: string, now: number): Promise<number> {
  const c = hub.db.conn;
  const repo = c
    .query<{ b: string | null; cursor: number | null; head: string | null }, [string]>(
      "SELECT default_branch AS b, merged_cursor_ms AS cursor, commits_cursor_sha AS head FROM metric_repos WHERE repo = ?1",
    )
    .get(remote);
  const checkouts = c
    .query<{ m: string; p: string }, [string]>(
      "SELECT machine_id AS m, project_id AS p FROM metric_project_repos WHERE repo = ?1 ORDER BY machine_id, project_id",
    )
    .all(remote);
  const branch = repo?.b ?? undefined;
  if (branch === undefined) throw new Unread("its default branch isn't known yet: no node has said");
  const reader = sweepArea(hub).git;
  const found = checkouts.find((r) => reader.canRead(hub, r.m));
  if (!found) throw new Unread("no machine with it checked out is connected to read its git log");
  const at: At = [found.m, found.p];
  const since = repo?.cursor ?? now - BACKFILL_MS;
  let log: LandedLog;
  try {
    log = await reader.read(hub, at, branch, since, repo?.head ?? undefined);
  } catch (error) {
    throw new Unread(whyOf(error));
  }
  const out = rows(hub.db, remote, branch, at, log.commits);
  const head = log.commits[0]?.sha;
  hub.db.transaction((c) => {
    store.seeRepo(c, remote, hostOf(remote));
    for (const row of out) write(c, row);
    // A failed fetch read the last fetched copy: its rows count, but the repo isn't read as of now.
    const error = log.fetchFailed === undefined ? null : clip(`git fetch failed: ${log.fetchFailed}`, 500);
    c.query(
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
  const rows = db.conn
    .query<{ sha: string; data: string }, []>(
      `SELECT lower(json_extract(data, '$.mergedSha')) AS sha, data FROM changes
       WHERE state = 'merged' AND json_extract(data, '$.mergedSha') IS NOT NULL ORDER BY n`,
    )
    .all();
  for (const { sha, data } of rows) {
    let change: Change;
    try {
      change = JSON.parse(data) as Change;
    } catch {
      continue;
    }
    let list = out.get(sha);
    if (!list) out.set(sha, (list = []));
    list.push(change);
  }
  return out;
}

const numbered = (word: string, prefix: string) => word.startsWith(prefix) && /^[1-9][0-9]*$/.test(word.slice(prefix.length));

/** A `Fleetd-Change` trailer's parts: "X12 (T45, W9)" → ["X12", "T45", "W9"]. */
export function changeTrailer(value: string): [id: string, task: string | undefined, workstream: string | undefined] | undefined {
  const words = value.split(/[\s(),]+/).filter(Boolean);
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

/**
 * The PR a merge commit's subject names: "Merge pull request #12 from …" (GitHub), "Merge pull request 'Fix' (#12) from
 * …" (Gitea).
 */
export function subjectPr(subject: string): number | undefined {
  const digits = (s: string) => {
    const n = /^\d+/.exec(s)?.[0];
    return n === undefined || Number(n) <= 0 ? undefined : Number(n);
  };
  const github = "Merge pull request #";
  if (subject.startsWith(github)) return digits(subject.slice(github.length));
  const open = subject.lastIndexOf("(#");
  if (open < 0) return undefined;
  const rest = subject.slice(open + 2);
  const n = digits(rest);
  return n !== undefined && rest.replace(/^\d+/, "").startsWith(")") ? n : undefined;
}

/** The fleetd branch a merge commit's subject names: "Merge pull request #12 from acme/fleetd/T45-x", "Merge branch 'fleetd/T45-x'". */
export function subjectTask(subject: string): string | undefined {
  const at = subject.indexOf("fleetd/");
  return at < 0 ? undefined : branchTask(subject.slice(at));
}

/** A merge of the default branch into itself: `git pull` on it, "Merge branch 'main' of host:repo". */
export const isSync = (subject: string, branch: string) =>
  subject.startsWith(`Merge branch '${branch}' of `) || (subject.startsWith("Merge remote-tracking branch '") && subject.includes(`/${branch}'`));

/** The route-free fields every row from git has. */
function baseRow(remote: string, c: GitCommit, owner: At | undefined): MergeRow {
  const row: MergeRow = { repo: remote, unitKey: `commit:${c.sha}`, mergedMs: c.atMs, mergedSha: c.sha.toLowerCase(), route: "", src: "git" };
  if (owner) [row.machineId, row.projectId] = owner;
  if (c.subject !== "") row.title = c.subject;
  return row;
}

/** Fills a fleetd row's order: its workstream and when it was asked for. */
function withOrder(db: HubDb, row: MergeRow, ws: string | undefined): void {
  const w = ws ?? (row.taskId === undefined ? undefined : taskWorkstream(db, row.taskId));
  const found = w === undefined ? undefined : workstreamOf(db, w);
  if (found) {
    const r = getRequested(db, found);
    row.requestedMs = r.atMs;
    row.requestedBasis = r.basis;
  }
  if (w === undefined) delete row.workstreamId;
  else row.workstreamId = w;
}

/** The train's row for one Change a commit landed. */
function trainRow(db: HubDb, base: MergeRow, id: string, change: Change | undefined, task: string | undefined, ws: string | undefined): MergeRow {
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
    const created = parseMs(change.createdAt);
    if (created !== undefined) row.firstPrMs = created;
    row.machineId = change.projectRef.machineId;
    row.projectId = change.projectRef.projectId;
  }
  const t = change?.taskId ?? task;
  if (t !== undefined) row.taskId = t;
  withOrder(db, row, change?.workstreamId ?? ws);
  return row;
}

/** The rows the default branch's line makes, newest first, as the module's rules route them. */
export function rows(db: HubDb, remote: string, branch: string, owner: At | undefined, commits: GitCommit[]): MergeRow[] {
  const out: MergeRow[] = [];
  // The tasks of the last commit when it was one of a task's by hand: the commits after it in a row are the same rebase.
  let run: string | undefined;
  const landed = mergedBySha(db);
  for (const c of commits) {
    const base = baseRow(remote, c, owner);
    const merge = c.parents.length > 1;
    const tasks = c.tasks ?? [];
    const byTrailer = (c.changes ?? []).map(changeTrailer).filter((t) => t !== undefined);
    if (byTrailer.length > 0) {
      run = undefined;
      for (const [id, task, ws] of byTrailer) out.push(trainRow(db, base, id, changeOf(db, id), task, ws));
      continue;
    }
    const sha = c.sha.toLowerCase();
    const merged = landed.get(sha);
    if (merged) {
      landed.delete(sha);
      run = undefined;
      for (const change of merged) out.push(trainRow(db, base, change.changeId, change, undefined, undefined));
      continue;
    }
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
        withOrder(db, row, undefined);
        if (!merge) run = key;
      }
    }
    out.push(row);
  }
  return out;
}
