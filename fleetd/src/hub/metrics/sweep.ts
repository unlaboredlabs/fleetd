// The host sweep (crates/fleetd/src/hub/metrics/sweep.rs): every project's repo read through its git host, not only
// repos with a train. It finds each project's origin by asking its node, then per repo reads the PRs merged since its
// cursor (90 days back the first time), the default branch's first-parent commits to find direct pushes, and the
// reviews and comments for the person's touches. Each PR gets the projector's route from the same fields, so the
// train's events and the sweep agree whichever reads it first; a train batch PR counts as its members.
//
// When: every 15 minutes for a repo with a merge in the last 7 days, else hourly, and within a minute of a metrics read
// asking for it. Repos are read one at a time. On a train's repo the train's own minute-by-minute check stays the fast
// path; the sweep fills what it can't see (no train yet, older PRs, other bases, pushes, reviews). A repo on a host
// with no source here is read from git alone instead (no_host.ts), on the same schedule.
import type { Database } from "bun:sqlite";
import type { ActorKind, Change, TrainEventData } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { clip } from "../api/refusals.ts";
import { isGitHubRepo } from "../projects/inspect.ts";
import { repoInspect } from "../projects/discover.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { kindCode } from "../time/kinds.ts";
import { retentionDays } from "../time/store.ts";
import { BACKFILL_MS, type HostAct, type HostActs, read as readActs } from "./host_acts.ts";
import { type GitLog, nodeLog, sweepRepo as sweepGitRepo } from "./no_host.ts";
import { landed } from "./project.ts";
import {
  type GitHostSource,
  hasApi,
  HostError,
  type HostSources,
  hostOf,
  type LandedCommit,
  type MergedPr,
  noSources,
  remoteKey,
  type RepoInfo,
  type RepoRef,
  sourceFor,
} from "./source.ts";
import * as store from "./store.ts";
import type { MergeRow } from "./store.ts";
import { repoProjects } from "./tools.ts";
import { mergedByHand } from "./touches.ts";

/** A metrics read asks for a repo again once its last read is this old. */
export const ON_READ_MS = 60_000;
/** How often a repo with a merge in the last ACTIVE_FOR_MS is read. */
export const ACTIVE_EVERY_MS = 15 * 60_000;
/** How often any other repo is read. */
export const QUIET_EVERY_MS = 60 * 60_000;
export const ACTIVE_FOR_MS = 7 * store.DAY_MS;
/** Each read starts this far before the last one, for host clocks and late updates; rows are idempotent. */
const OVERLAP_MS = 10 * 60_000;
/** A checkout's origin is asked of its node again after a day, or after ten minutes when the node didn't answer. */
const ORIGIN_EVERY_MS = store.DAY_MS;
const ORIGIN_RETRY_MS = 10 * 60_000;
const TICK_MS = 60_000;

/** The sweep's sources and when each repo was last tried. */
export class Sweep {
  /** For a repo on a host with no source: its git log, read on a node with it checked out. Tests swap it. */
  git: GitLog = nodeLog;
  /** Repos a metrics read asked for since the last pass. */
  wanted = new Set<string>();
  readonly tried = new Map<string, number>();
  /** Projects ("<machine>\0<project>") whose node was last asked for their origin, and when. */
  readonly asked = new Map<string, number>();
  /** Wakes the loop between ticks. */
  kick: () => void = () => {};

  constructor(public sources: HostSources) {}

  /** The source for a host as `metric_repos.host` names it, if the hub reads that host; the others are read from git. */
  source(host: string): GitHostSource | undefined {
    return sourceFor(this.sources, host);
  }

  /** A metrics read of `repos`: each is read again if its last read is over a minute old. Doesn't wait. */
  want(repos: Iterable<string>): void {
    for (const r of repos) this.wanted.add(r);
    this.kick();
  }
}

/** The hub's sweep. A hub reads no git host until `start` gives it the real sources (loops.ts), as a test hub's never does. */
export const sweepArea = (hub: Hub): Sweep => hub.area("metrics_sweep", () => new Sweep(noSources()));

/** Whether a repo is due: never tried, asked for by a read a minute on, active and 15 minutes on, or an hour on. */
export function due(lastTryMs: number | undefined, lastMergeMs: number | undefined, wanted: boolean, nowMs: number): boolean {
  if (lastTryMs === undefined) return true;
  const every = wanted
    ? ON_READ_MS
    : lastMergeMs !== undefined && nowMs - lastMergeMs < ACTIVE_FOR_MS
      ? ACTIVE_EVERY_MS
      : QUIET_EVERY_MS;
  return nowMs - lastTryMs >= every;
}

/** Runs a pass now, then each minute and whenever a read asks, until the hub stops. */
export async function run(hub: Hub): Promise<void> {
  const sweep = sweepArea(hub);
  const stop = hub.shutdown.signal;
  while (!stop.aborted) {
    try {
      await pass(hub);
    } catch (error) {
      console.error("metrics: the host sweep failed:", error);
    }
    if (stop.aborted) return;
    // A read that asked during the pass goes again now, as a Notify keeps a wake that came while no one waited.
    if (sweep.wanted.size > 0) continue;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        sweep.kick = () => {};
        stop.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, TICK_MS);
      sweep.kick = done;
      stop.addEventListener("abort", done, { once: true });
    });
  }
}

/** One pass: learn the projects' origins, then read every due repo, one at a time. */
export async function pass(hub: Hub): Promise<void> {
  const now = hub.clock.now();
  await learnOrigins(hub, now);
  const sweep = sweepArea(hub);
  const wanted = sweep.wanted;
  sweep.wanted = new Set();
  let repos: Sweepable[];
  try {
    repos = hub.db.transaction(sweepable);
  } catch (error) {
    return console.error("metrics: repos not listed:", error);
  }
  for (const r of repos) {
    // A host read through its API, on a hub built without its reader (a test or lab hub).
    if (hasApi(r.host) && sweep.source(r.host) === undefined) continue;
    const reads = [sweep.tried.get(r.repo), r.lastOkMs].filter((v): v is number => v !== undefined);
    const last = reads.length ? Math.max(...reads) : undefined;
    if (!due(last, r.lastMergeMs, wanted.has(r.repo), now)) continue;
    sweep.tried.set(r.repo, now);
    const at = hub.clock.now();
    const source = sweep.source(r.host);
    try {
      if (source) await sweepRepo(hub, source, r.repo, at);
      else await sweepGitRepo(hub, r.repo, at);
    } catch (error) {
      console.warn(`metrics: repo ${r.repo} not read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** A repo the sweep may read. */
export type Sweepable = { repo: string; host: string; lastOkMs?: number; lastMergeMs?: number };

/** Every repo the metrics know (projects' origins, trains, Changes), each made known to `metric_repos`. */
export function sweepable(c: Database): Sweepable[] {
  for (const repo of repoProjects(c).keys()) store.seeRepo(c, repo, hostOf(repo));
  return c
    .query<{ repo: string; host: string; ok: number | null; merged: number | null }, []>(
      `SELECT r.repo, r.host, r.last_ok_ms AS ok, (SELECT MAX(merged_ms) FROM metric_merges m WHERE m.repo = r.repo) AS merged
       FROM metric_repos r ORDER BY r.repo`,
    )
    .all()
    .map((r) => ({
      repo: r.repo,
      host: r.host,
      ...(r.ok === null ? {} : { lastOkMs: r.ok }),
      ...(r.merged === null ? {} : { lastMergeMs: r.merged }),
    }));
}

/** Asks each project's node for its checkout's origin, once a day, and forgets projects that are gone. */
export async function learnOrigins(hub: Hub, now: number): Promise<void> {
  let projects: { m: string; p: string; root: string | null }[];
  try {
    const c = hub.db.conn;
    c.query(
      `DELETE FROM metric_project_repos WHERE NOT EXISTS
         (SELECT 1 FROM projects p WHERE p.machine_id = metric_project_repos.machine_id
            AND p.project_id = metric_project_repos.project_id)`,
    ).run();
    projects = c
      .query<{ m: string; p: string; root: string | null }, [number]>(
        `SELECT p.machine_id AS m, p.project_id AS p, json_extract(p.data, '$.workspaceRoot') AS root FROM projects p
         LEFT JOIN metric_project_repos o ON o.machine_id = p.machine_id AND o.project_id = p.project_id
         WHERE o.checked_ms IS NULL OR o.checked_ms < ?1`,
      )
      .all(now - ORIGIN_EVERY_MS);
  } catch (error) {
    return console.error("metrics: projects not listed:", error);
  }
  const asked = sweepArea(hub).asked;
  for (const { m, p, root } of projects) {
    if (root === null) continue;
    const key = `${m}\u0000${p}`;
    const at = asked.get(key);
    if (at !== undefined && now - at < ORIGIN_RETRY_MS) continue;
    asked.set(key, now);
    let facts;
    try {
      facts = await repoInspect(hub, m, root);
    } catch {
      continue;
    }
    const repo = facts.remote === undefined ? undefined : remoteKey(facts.remote);
    if (repo === undefined) continue;
    try {
      hub.db.transaction((c) => {
        store.seeRepo(c, repo, hostOf(repo));
        c.query(
          `INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(machine_id, project_id) DO UPDATE SET repo = excluded.repo, checked_ms = excluded.checked_ms`,
        ).run(m, p, repo, now);
        c.query("UPDATE metric_repos SET default_branch = ?2 WHERE repo = ?1 AND default_branch IS NULL").run(repo, facts.defaultBranch ?? null);
      });
    } catch (error) {
      console.error("metrics: a project's origin not kept:", error);
    }
  }
}

/** What one repo's read found. */
export type Swept = { rows: number; touches: number };

/** A failure's words: the host's own, or the hub's database's. */
const whyOf = (error: unknown) =>
  error instanceof HostError ? error.message : `the hub's database: ${error instanceof Error ? error.message : String(error)}`;

/** Reads one repo from its host and writes what it found; on failure the repo keeps its rows and says why (thrown as a HostError). */
export async function sweepRepo(hub: Hub, source: GitHostSource, remote: string, now: number): Promise<Swept> {
  const step = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const why = whyOf(error);
      failed(hub, remote, why);
      throw new HostError(why);
    }
  };
  const rows = await step(() => readRepo(hub, source, remote, now));
  // The hub reads the host as the person: their own reviews, comments and merges are made by this account.
  const login = await step(() => source.signedIn());
  if (login !== undefined) {
    try {
      hub.db.transaction((c) => store.addIdentity(c, login, hostOf(remote)));
    } catch (error) {
      console.error("metrics: the host's login not kept:", error);
    }
  }
  const acts = personActs(source.acts(), hub.db, now);
  const touches = await step(() => readActs(hub.db, acts, remote, now));
  return { rows, touches };
}

/** Keeps why a repo's read failed; its rows stay. */
export function failed(hub: Hub, remote: string, why: string): void {
  try {
    hub.db.transaction((c) => {
      store.seeRepo(c, remote, hostOf(remote));
      c.query("UPDATE metric_repos SET last_error = ?2 WHERE repo = ?1").run(remote, clip(why, 500));
    });
  } catch (error) {
    console.error("metrics: a repo's read error not kept:", error);
  }
}

/** The landed changes since the repo's cursor, written in one transaction with the cursor's move. */
async function readRepo(hub: Hub, source: GitHostSource, remote: string, now: number): Promise<number> {
  const slash = remote.indexOf("/");
  if (slash < 0) throw new HostError(`${remote} is not host/path`);
  const repo: RepoRef = { remote, path: remote.slice(slash + 1) };
  const cursors = hub.db.conn
    .query<{ cursor: number | null; head: string | null; resume: string | null; floor: number | null }, [string]>(
      `SELECT merged_cursor_ms AS cursor, commits_cursor_sha AS head, merged_resume AS resume, merged_resume_floor AS floor
       FROM metric_repos WHERE repo = ?1`,
    )
    .get(remote);
  const headSeen = cursors?.head ?? undefined;
  const since = cursors?.cursor ?? now - BACKFILL_MS;
  const info = await source.repoInfo(repo);
  const top = await source.mergedSince(repo, since);
  const pulls = [...top.pulls];
  // A read the page cap cut short goes on from where it stopped, down to the oldest point any read still owes, on this
  // pass and the next ones, so the cursor never moves past PRs not read yet.
  const floor = Math.min(cursors?.floor ?? since, since);
  let rest: string | undefined;
  let readTo: number;
  if (top.rest) [rest, readTo] = top.rest;
  else if (cursors?.resume) {
    const more = await source.mergedSince(repo, floor, cursors.resume);
    pulls.push(...more.pulls);
    if (more.rest) [rest, readTo] = more.rest;
    else readTo = floor;
  } else readTo = since;
  const commits = await source.defaultCommits(repo, info.defaultBranch, since, headSeen);
  const out = prRows(hub.db, repo, info, pulls);
  const landedShas = new Set([...pulls.flatMap((p) => p.mergeSha ?? []), ...knownShas(hub.db, remote)]);
  for (const c of landedSince(commits, headSeen, since)) {
    if (landedShas.has(c.sha)) continue;
    const prs = c.prs ?? (await source.prsOfCommit(repo, c.sha));
    if (prs.length === 0) out.push(pushRow(repo, c, ownerOf(hub.db, remote)));
  }
  const head = commits[0]?.sha;
  hub.db.transaction((c) => {
    store.seeRepo(c, remote, hostOf(remote));
    for (const row of out) {
      write(c, row);
      const t = mergedByHand(row);
      if (t) store.upsertTouch(c, t);
    }
    // Merges are known back to where the reads have reached; a cut-short read leaves it partly read.
    c.query(
      `UPDATE metric_repos SET default_branch = ?2, merged_cursor_ms = ?3,
         commits_cursor_sha = COALESCE(?4, commits_cursor_sha), last_ok_ms = ?5, last_error = NULL,
         backfilled_ms = MIN(COALESCE(backfilled_ms, ?6), ?6), merged_resume = ?7,
         merged_resume_floor = CASE WHEN ?7 IS NULL THEN NULL ELSE ?8 END
       WHERE repo = ?1`,
    ).run(remote, info.defaultBranch, now - OVERLAP_MS, head ?? null, now, readTo, rest ?? null, floor);
  });
  return out.length;
}

/** The default branch's own line: from its head, first parents only, as far as the commits read go. */
export function firstParent(commits: LandedCommit[]): LandedCommit[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const out: LandedCommit[] = [];
  const seen = new Set<string>();
  let next = commits[0];
  while (next && !seen.has(next.sha)) {
    seen.add(next.sha);
    out.push(next);
    next = next.firstParent === undefined ? undefined : bySha.get(next.firstParent);
  }
  return out;
}

/**
 * The default branch's commits since the last read: its line back to the head that read saw, whatever their dates (a
 * commit made earlier can be pushed later). With no head seen, or one no longer on the line (a force push), those made
 * since `sinceMs`.
 */
export function landedSince(commits: LandedCommit[], headSeen: string | undefined, sinceMs: number): LandedCommit[] {
  const line = firstParent(commits);
  const i = headSeen === undefined ? -1 : line.findIndex((c) => c.sha.toLowerCase() === headSeen.toLowerCase());
  return i >= 0 ? line.slice(0, i) : line.filter((c) => c.atMs >= sinceMs);
}

/** The commits already known as landed on the repo: merges and squashes the train or a PR left. */
function knownShas(db: HubDb, remote: string): string[] {
  return db.conn
    .query<{ sha: string }, [string]>(
      "SELECT merged_sha AS sha FROM metric_merges WHERE repo = ?1 AND merged_sha IS NOT NULL AND unit_key LIKE 'pr:%'",
    )
    .all(remote)
    .map((r) => r.sha);
}

/** The project a repo's rows belong to when no train or Change says: the first with it checked out. */
function ownerOf(db: HubDb, remote: string): [string, string] | undefined {
  const row = db.conn
    .query<{ m: string; p: string }, [string]>(
      "SELECT machine_id AS m, project_id AS p FROM metric_project_repos WHERE repo = ?1 ORDER BY machine_id, project_id LIMIT 1",
    )
    .get(remote);
  return row ? [row.m, row.p] : undefined;
}

/** The newest Change for a PR, if fleetd ever enqueued it. */
function changeOf(db: HubDb, repo: string, pr: number): Change | undefined {
  const row = db.conn
    .query<{ data: string }, [string, number]>("SELECT data FROM changes WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC LIMIT 1")
    .get(repo.toLowerCase(), pr);
  try {
    return row ? (JSON.parse(row.data) as Change) : undefined;
  } catch {
    return undefined;
  }
}

const actorKind = (k: ActorKind): ActorKind | undefined => (k === "unknown" ? undefined : k);

/**
 * Why a merged PR is not a landed change, beyond the projector's bots: into a base that isn't the repo's default
 * branch, or a merge-back (an upstream's default branch synced in). A branch other PRs merged into, merged into the
 * default branch (stacked PRs, `release` → `main`), is landed: the PRs into it were not, so the work counts once, as the
 * PR that reached the default branch.
 */
export function skipWhy(pr: MergedPr, repoPath: string, info: RepoInfo): "other_base" | "merge_back" | undefined {
  if (pr.base !== info.defaultBranch) return "other_base";
  const head = pr.headRepo?.toLowerCase();
  const sameRepo = head !== undefined && head === repoPath.toLowerCase();
  const upstream = head !== undefined && info.upstream !== undefined && head === info.upstream.toLowerCase();
  return (upstream && pr.headIsDefault) || (sameRepo && pr.head === info.defaultBranch) ? "merge_back" : undefined;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** The rows the merged PRs make: a batch PR's members one each, every other PR as the projector would route it. */
function prRows(db: HubDb, repo: RepoRef, info: RepoInfo, pulls: MergedPr[]): MergeRow[] {
  const fallback = ownerOf(db, repo.remote);
  const lower = repo.path.toLowerCase();
  const trainRepo = isGitHubRepo(lower) ? lower : undefined;
  const out: MergeRow[] = [];
  for (const pr of pulls) {
    const base: TrainEventData = defined({ repo: trainRepo, mergedSha: pr.mergeSha, mergedAt: isoMs(pr.mergedMs), base: pr.base });
    if (pr.batchMembers.length > 0) {
      // The train's batch PR: its members landed in it, and it isn't counted itself.
      for (const n of pr.batchMembers) {
        const change = changeOf(db, repo.path, n);
        const d: TrainEventData = defined({ ...base, prNumber: n, batchPr: pr.number, changeId: change?.changeId, head: change?.branch });
        const row = landed(db, true, d, pr.mergedMs, fallback, undefined);
        if (row) out.push(hostRow(row));
      }
      continue;
    }
    const change = changeOf(db, repo.path, pr.number);
    const train = change?.state === "merged";
    const d: TrainEventData = defined({
      ...base,
      prNumber: pr.number,
      prUrl: pr.url,
      changeId: change?.changeId,
      head: pr.head,
      prCreatedAt: pr.createdMs === undefined ? undefined : isoMs(pr.createdMs),
      authorKind: actorKind(pr.author),
      mergedByKind: actorKind(pr.mergedBy),
      mergedBy: pr.mergedByLogin,
    });
    const landedRow = landed(db, train, d, pr.mergedMs, fallback, info.defaultBranch);
    if (!landedRow) continue;
    const row = hostRow(landedRow);
    if (pr.title !== "") row.title = pr.title;
    else delete row.title;
    if (pr.additions === undefined) delete row.additions;
    else row.additions = pr.additions;
    if (pr.deletions === undefined) delete row.deletions;
    else row.deletions = pr.deletions;
    const why = !train && row.route !== store.SKIPPED ? skipWhy(pr, repo.path, info) : undefined;
    if (why !== undefined) {
      row.route = store.SKIPPED;
      row.skipWhy = why;
    }
    out.push(row);
  }
  return out;
}

const hostRow = (row: MergeRow): MergeRow => ({ ...row, src: "host" });

/** A first-parent commit no PR brought in: pushed straight to the default branch. */
function pushRow(repo: RepoRef, c: LandedCommit, owner: [string, string] | undefined): MergeRow {
  const row: MergeRow = {
    repo: repo.remote,
    unitKey: `commit:${c.sha}`,
    mergedMs: c.atMs,
    mergedSha: c.sha,
    route: c.bot ? store.SKIPPED : "direct",
    authorKind: c.bot ? "bot" : "human",
    url: `https://${repo.remote}/commit/${c.sha}`,
    src: "host",
  };
  if (owner) [row.machineId, row.projectId] = owner;
  if (c.bot) row.skipWhy = "bot";
  if (c.title !== "") row.title = c.title;
  return row;
}

/** Writes a row the sweep made. A PR's row replaces the direct push its commit was taken for before the host linked them. */
export function write(c: Database, row: MergeRow): void {
  if (row.changeId !== undefined) {
    const passed = store.reviewPassed(c, row.changeId);
    const r = { ...row };
    if (passed === undefined) delete r.reviewPassedMs;
    else r.reviewPassedMs = passed;
    store.upsertMerge(c, r);
  } else store.upsertMerge(c, row);
  if (row.mergedSha !== undefined && row.unitKey.startsWith("pr:")) {
    c.query("DELETE FROM metric_merges WHERE repo = ?1 AND unit_key = ?2 AND route IN ('direct', 'skipped')").run(row.repo, `commit:${row.mergedSha}`);
  }
}

/**
 * The person's acts among a host's: fleetd's agents use `gh` under the person's login too, so an act on a fleetd task's
 * PR made during one of that task's runs is the agent's, not the person's.
 */
function personActs(inner: HostActs, db: HubDb, nowMs: number): HostActs {
  return {
    async actsSince(repo, sinceMs) {
      const acts = await inner.actsSince(repo, sinceMs);
      return acts.filter((act) => !agentsAct(db, repo, act, nowMs));
    },
  };
}

/** The task a fleetd branch names: `fleetd/T12-…`, under any prefix (`slot/1/fleetd/T12-…`). */
function branchTask(head: string): number | undefined {
  const at = head.lastIndexOf("fleetd/T");
  const n = at < 0 ? undefined : /^\d+/.exec(head.slice(at + "fleetd/T".length))?.[0];
  return n === undefined ? undefined : Number(n);
}

/**
 * Whether an act on `remote` was made during a run of the fleetd task that wrote its PR: its Change's task, else the
 * task its `fleetd/T<n>` branch names when that task is one of this hub's projects with the repo (task numbers are this
 * hub's own; another fleet sharing the repo has its own `T<n>`). An act between two runs of a continued task is the
 * person's. A run counts:
 *
 * - from its recorded run span, which the node sends when the run ends;
 * - while the task is running, from the start of its current attempt (its latest `task.started`) on;
 * - older than the time area's span retention, where the spans are gone: the task's own start to its end.
 */
export function agentsAct(db: HubDb, remote: string, act: HostAct, nowMs: number): boolean {
  const slash = remote.indexOf("/");
  const path = slash < 0 ? remote : remote.slice(slash + 1);
  const changeTask = changeOf(db, path, act.prNumber)?.taskId;
  let n: number | undefined;
  if (changeTask !== undefined) {
    const digits = changeTask.slice(1);
    n = /^[+-]?\d+$/.test(digits) ? Number(digits) : undefined;
  } else {
    const t = act.head === undefined ? undefined : branchTask(act.head);
    n = t !== undefined && taskOnRepo(db, t, remote, path) ? t : undefined;
  }
  if (n === undefined) return false;
  const taskId = `T${n}`;
  const c = db.conn;
  const inRun = c
    .query<{ v: number }, [string, number, number]>(
      `SELECT EXISTS (SELECT 1 FROM time_spans WHERE task_id = ?1 AND kind = ?2
         AND start_ms <= ?3 AND (end_ms IS NULL OR end_ms >= ?3)) AS v`,
    )
    .get(taskId, kindCode("run"), act.atMs);
  if (inRun?.v) return true;
  const row = c
    .query<{ state: string; started: string | null; ended: string | null }, [number]>(
      "SELECT state, json_extract(data, '$.startedAt') AS started, ended_at AS ended FROM tasks WHERE n = ?1",
    )
    .get(n);
  if (!row) return false;
  const started = row.started === null ? undefined : parseMs(row.started);
  if (row.state === "running") {
    const attempt = c
      .query<{ v: number | null }, [string]>(
        `SELECT MAX(created_ms) AS v FROM events WHERE type = 'task.started'
           AND json_extract(data, '$.data.taskId') = ?1`,
      )
      .get(taskId)?.v;
    const start = attempt ?? started;
    if (start !== undefined && act.atMs >= start) return true;
  }
  const spansFrom = nowMs - retentionDays(c) * store.DAY_MS;
  const end = (row.ended === null ? undefined : parseMs(row.ended)) ?? nowMs;
  return act.atMs < spansFrom && started !== undefined && act.atMs >= started && act.atMs <= end;
}

/** Whether task `n` belongs to a project on this hub that has the repo: checked out, owning its train, or with a Change on it. */
function taskOnRepo(db: HubDb, n: number, remote: string, path: string): boolean {
  const row = db.conn
    .query<{ v: number }, [number, string, string]>(
      `SELECT EXISTS (SELECT 1 FROM tasks t WHERE t.n = ?1 AND (
         EXISTS (SELECT 1 FROM metric_project_repos o WHERE o.repo = ?2
                   AND o.machine_id = t.machine_id AND o.project_id = t.project_id)
         OR EXISTS (SELECT 1 FROM trains r WHERE r.repo = ?3
                      AND r.machine_id = t.machine_id AND r.project_id = t.project_id)
         OR EXISTS (SELECT 1 FROM changes h WHERE h.repo = ?3
                      AND h.machine_id = t.machine_id AND h.project_id = t.project_id))) AS v`,
    )
    .get(n, remote, path.toLowerCase());
  return !!row?.v;
}
