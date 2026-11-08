// The host sweep (crates/fleetd/src/hub/metrics/sweep.rs): every project's repo read through its git host, not only
// repos with a train. It learns each project's origin from its node, then per repo reads the PRs merged since its
// cursor (90 days back the first time), the default branch's first-parent commits for direct pushes, and the reviews
// and comments for the person's touches. Each PR gets the projector's route from the same fields, so the train's events
// and the sweep agree whichever reads first; a train batch PR counts as its members.
//
// When: every 15 minutes for a repo with a merge in the last 7 days, else hourly, and within a minute of a metrics read
// asking for it. Repos are read one at a time. A repo on a host with no reader is read from git alone (no_host.ts).
import type { Database } from "bun:sqlite";
import type { Change, TrainEventData } from "../../shared/contracts.ts";
import type { RepoFacts } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { githubApps } from "../github_app/index.ts";
import { AppGh } from "../github_app/gh.ts";
import type { HubDb } from "../store/db.ts";
import { parseMs } from "../store/time.ts";
import { kindCode } from "../time/kinds.ts";
import { retentionDays } from "../time/store.ts";
import { GitHubSource } from "./github.ts";
import * as hostActs from "./host_acts.ts";
import { type GitLog, failed, nodeLog, sweepRepo as sweepFromGit } from "./no_host.ts";
import { landed } from "./project.ts";
import { type GitHostSource, hasApi, type HostSources, hostOf, type LandedCommit, type MergedPr, remoteKey, type RepoInfo, type RepoRef } from "./source.ts";
import * as store from "./store.ts";
import type { MergeRow } from "./store.ts";
import { repoProjects } from "./tools.ts";
import { mergedByHand } from "./touches.ts";

/** A metrics read asks for a repo again once its last read is this old. */
export const ON_READ_MS = 60_000;
export const ACTIVE_EVERY_MS = 15 * 60_000;
export const QUIET_EVERY_MS = 60 * 60_000;
export const ACTIVE_FOR_MS = 7 * store.DAY_MS;
/** Each read starts this far before the last one, for host clocks and late updates; rows are idempotent. */
const OVERLAP_MS = 10 * 60_000;
const ORIGIN_EVERY_MS = store.DAY_MS;
const ORIGIN_RETRY_MS = 10 * 60_000;
export const TICK_MS = 60_000;
const SCAN_TIMEOUT_MS = 10_000;

/** The sweep's readers and when each repo was last tried. */
export class Sweep {
  /** GitHub through the hub's `gh`, as the App where it is installed; tests set fakes, or none. */
  sources: HostSources;
  /** For a repo on a host with no reader: its git log, read on a node with it checked out. */
  git: GitLog = nodeLog;
  private wanted = new Set<string>();
  readonly tried = new Map<string, number>();
  readonly asked = new Map<string, number>();
  private kick: (() => void) | undefined;

  constructor(hub: Hub) {
    this.sources = { github: new GitHubSource(new AppGh(githubApps(hub))) };
  }

  source(host: string): GitHostSource | undefined {
    return host === "github" ? this.sources.github : undefined;
  }

  /** A metrics read of `repos`: each is read again if its last read is over a minute old. Doesn't wait. */
  want(repos: string[]): void {
    for (const r of repos) this.wanted.add(r);
    this.kick?.();
  }

  takeWanted(): Set<string> {
    const w = this.wanted;
    this.wanted = new Set();
    return w;
  }

  /** Runs a pass now and after each tick or want, one at a time, until the hub stops. */
  run(hub: Hub): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const go = async () => {
      if (hub.shutdown.signal.aborted) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      clearTimeout(timer);
      try {
        await pass(hub);
      } catch (error) {
        console.error("metrics: the host sweep failed:", error);
      } finally {
        running = false;
      }
      if (hub.shutdown.signal.aborted) return;
      if (again) {
        again = false;
        void go();
      } else timer = setTimeout(go, TICK_MS);
    };
    this.kick = () => void go();
    hub.shutdown.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    void go();
  }
}

export const metricsSweep = (hub: Hub) => hub.area("metrics_sweep", (h) => new Sweep(h));

/** Whether a repo is due: never tried, asked for by a read a minute on, active and 15 minutes on, or an hour on. */
export function due(lastTryMs: number | undefined, lastMergeMs: number | undefined, wanted: boolean, nowMs: number): boolean {
  if (lastTryMs === undefined) return true;
  const every = wanted ? ON_READ_MS : lastMergeMs !== undefined && nowMs - lastMergeMs < ACTIVE_FOR_MS ? ACTIVE_EVERY_MS : QUIET_EVERY_MS;
  return nowMs - lastTryMs >= every;
}

/** One pass: learn the projects' origins, then read every due repo, one at a time. */
export async function pass(hub: Hub): Promise<void> {
  const now = hub.clock.now();
  await learnOrigins(hub, now);
  const sweep = metricsSweep(hub);
  const wanted = sweep.takeWanted();
  let repos: Sweepable[];
  try {
    repos = hub.db.transaction((c) => sweepable(c));
  } catch (error) {
    console.error("metrics: repos not listed:", error);
    return;
  }
  for (const r of repos) {
    // A host read through its API, on a hub built without its reader (a test or lab hub).
    if (hasApi(r.host) && !sweep.source(r.host)) continue;
    const tried = sweep.tried.get(r.repo);
    const last = tried === undefined ? r.lastOkMs : r.lastOkMs === undefined ? tried : Math.max(tried, r.lastOkMs);
    if (!due(last, r.lastMergeMs, wanted.has(r.repo), now)) continue;
    sweep.tried.set(r.repo, now);
    const at = hub.clock.now();
    const source = sweep.source(r.host);
    try {
      if (source) await sweepRepo(hub, source, r.repo, at);
      else await sweepFromGit(hub, sweep.git, r.repo, at, write);
    } catch (error) {
      console.warn(`metrics: ${r.repo} not read: ${(error as Error).message}`);
    }
  }
}

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
    .map((r) => ({ repo: r.repo, host: r.host, ...(r.ok === null ? {} : { lastOkMs: r.ok }), ...(r.merged === null ? {} : { lastMergeMs: r.merged }) }));
}

/** Asks each project's node for its checkout's origin, once a day, and forgets projects that are gone. */
export async function learnOrigins(hub: Hub, now: number): Promise<void> {
  let projects: { m: string; p: string; root: string | null }[];
  try {
    projects = hub.db.transaction((c) => {
      c.query(
        `DELETE FROM metric_project_repos WHERE NOT EXISTS
           (SELECT 1 FROM projects p WHERE p.machine_id = metric_project_repos.machine_id
              AND p.project_id = metric_project_repos.project_id)`,
      ).run();
      return c
        .query<{ m: string; p: string; root: string | null }, [number]>(
          `SELECT p.machine_id AS m, p.project_id AS p, json_extract(p.data, '$.workspaceRoot') AS root FROM projects p
           LEFT JOIN metric_project_repos o ON o.machine_id = p.machine_id AND o.project_id = p.project_id
           WHERE o.checked_ms IS NULL OR o.checked_ms < ?1`,
        )
        .all(now - ORIGIN_EVERY_MS);
    });
  } catch (error) {
    console.error("metrics: projects not listed:", error);
    return;
  }
  const sweep = metricsSweep(hub);
  for (const { m, p, root } of projects) {
    if (root === null) continue;
    const key = `${m}/${p}`;
    const at = sweep.asked.get(key);
    if (at !== undefined && now - at < ORIGIN_RETRY_MS) continue;
    sweep.asked.set(key, now);
    let facts: RepoFacts;
    try {
      const out = await executors(hub).call(m, "read", { op: "repo_inspect", path: root }, SCAN_TIMEOUT_MS);
      if (out.kind !== "repo_facts") continue;
      facts = out;
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

/** Reads one repo from its host and writes what it found; on failure the repo keeps its rows and says why. */
export async function sweepRepo(hub: Hub, source: GitHostSource, remote: string, now: number): Promise<Swept> {
  try {
    const rows = await readRepo(hub, source, remote, now);
    // The hub reads the host as the person: their own reviews, comments and merges are made by this account.
    const login = await source.signedIn();
    if (login !== undefined) hub.db.transaction((c) => store.addIdentity(c, login, hostOf(remote)));
    const acts = personActs(source.acts(), hub.db, now);
    const touches = await hostActs.read(hub.db, acts, remote, now);
    return { rows, touches };
  } catch (error) {
    failed(hub, remote, (error as Error).message);
    throw error;
  }
}

/** The landed changes since the repo's cursor, written in one transaction with the cursor's move. */
async function readRepo(hub: Hub, source: GitHostSource, remote: string, now: number): Promise<number> {
  const slash = remote.indexOf("/");
  if (slash < 0) throw new Error(`${remote} is not host/path`);
  const repo: RepoRef = { remote, path: remote.slice(slash + 1) };
  const cur = hub.db.conn
    .query<{ cursor: number | null; head: string | null; resume: string | null; floor: number | null }, [string]>(
      `SELECT merged_cursor_ms AS cursor, commits_cursor_sha AS head, merged_resume AS resume, merged_resume_floor AS floor
       FROM metric_repos WHERE repo = ?1`,
    )
    .get(remote);
  const since = cur?.cursor ?? now - hostActs.BACKFILL_MS;
  const info = await source.repoInfo(repo);
  const top = await source.mergedSince(repo, since, undefined);
  const pulls = [...top.pulls];
  // A read the page cap cut short goes on from where it stopped, down to the oldest point any read still owes.
  const floor = Math.min(cur?.floor ?? since, since);
  let rest: string | undefined;
  let readTo: number;
  if (top.rest) [rest, readTo] = top.rest;
  else if (cur?.resume) {
    const more = await source.mergedSince(repo, floor, cur.resume);
    pulls.push(...more.pulls);
    if (more.rest) [rest, readTo] = more.rest;
    else readTo = floor;
  } else readTo = since;
  const headSeen = cur?.head ?? undefined;
  const commits = await source.defaultCommits(repo, info.defaultBranch, since, headSeen);
  const rows = prRows(hub.db, repo, info, pulls);
  const landedShas = new Set<string>([...pulls.flatMap((p) => p.mergeSha ?? []), ...knownShas(hub.db, remote)]);
  for (const c of landedSince(commits, headSeen, since)) {
    if (landedShas.has(c.sha)) continue;
    const prs = c.prs ?? (await source.prsOfCommit(repo, c.sha));
    if (prs.length === 0) rows.push(pushRow(repo, c, ownerOf(hub.db, remote)));
  }
  const head = commits[0]?.sha;
  hub.db.transaction((c) => {
    store.seeRepo(c, remote, hostOf(remote));
    for (const row of rows) {
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
  return rows.length;
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
 * The default branch's commits since the last read: its line back to the head that read saw, whatever their dates.
 * With no head seen, or one no longer on the line (a force push), those made since `sinceMs`.
 */
export function landedSince(commits: LandedCommit[], headSeen: string | undefined, sinceMs: number): LandedCommit[] {
  const line = firstParent(commits);
  const i = headSeen === undefined ? -1 : line.findIndex((c) => c.sha.toLowerCase() === headSeen.toLowerCase());
  return i >= 0 ? line.slice(0, i) : line.filter((c) => c.atMs >= sinceMs);
}

/** The commits already known as landed on the repo: merges and squashes the train or a PR left. */
function knownShas(db: HubDb, remote: string): string[] {
  return db.conn
    .query<{ s: string }, [string]>("SELECT merged_sha AS s FROM metric_merges WHERE repo = ?1 AND merged_sha IS NOT NULL AND unit_key LIKE 'pr:%'")
    .all(remote)
    .map((r) => r.s);
}

/** The project a repo's rows belong to when no train or Change says: the first with it checked out. */
function ownerOf(db: HubDb, remote: string): [string, string] | undefined {
  const r = db.conn
    .query<{ m: string; p: string }, [string]>(
      "SELECT machine_id AS m, project_id AS p FROM metric_project_repos WHERE repo = ?1 ORDER BY machine_id, project_id LIMIT 1",
    )
    .get(remote);
  return r ? [r.m, r.p] : undefined;
}

/** The newest Change for a PR, if fleetd ever enqueued it. */
function changeOf(db: HubDb, repo: string, pr: number): Change | undefined {
  const r = db.conn
    .query<{ data: string }, [string, number]>("SELECT data FROM changes WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC LIMIT 1")
    .get(repo.toLowerCase(), pr);
  try {
    return r ? (JSON.parse(r.data) as Change) : undefined;
  } catch {
    return undefined;
  }
}

/** Why a merged PR is not a landed change beyond the projector's bots: another base, or a merge-back. */
export function skipWhy(pr: MergedPr, repoPath: string, info: RepoInfo): "other_base" | "merge_back" | undefined {
  if (pr.base !== info.defaultBranch) return "other_base";
  const sameRepo = pr.headRepo !== undefined && pr.headRepo.toLowerCase() === repoPath.toLowerCase();
  const upstream = pr.headRepo !== undefined && info.upstream !== undefined && pr.headRepo.toLowerCase() === info.upstream.toLowerCase();
  return (upstream && pr.headIsDefault) || (sameRepo && pr.head === info.defaultBranch) ? "merge_back" : undefined;
}

const hostRow = (row: MergeRow | undefined): MergeRow | undefined => (row ? { ...row, src: "host" } : undefined);
const actor = (k: string) => (k === "unknown" ? undefined : (k as TrainEventData["authorKind"]));
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The rows the merged PRs make: a batch PR's members one each, every other PR as the projector would route it. */
function prRows(db: HubDb, repo: RepoRef, info: RepoInfo, pulls: MergedPr[]): MergeRow[] {
  const fallback = ownerOf(db, repo.remote);
  const trainRepo = GITHUB_REPO.test(repo.path) ? repo.path.toLowerCase() : undefined;
  const out: MergeRow[] = [];
  for (const pr of pulls) {
    const base: TrainEventData = {
      ...(trainRepo ? { repo: trainRepo } : {}),
      ...(pr.mergeSha ? { mergedSha: pr.mergeSha } : {}),
      mergedAt: new Date(pr.mergedMs).toISOString(),
      base: pr.base,
    };
    if (pr.batchMembers.length > 0) {
      // The train's batch PR: its members landed in it, and it isn't counted itself.
      for (const member of pr.batchMembers) {
        const change = changeOf(db, repo.path, member);
        const d: TrainEventData = {
          ...base,
          prNumber: member,
          batchPr: pr.number,
          ...(change ? { changeId: change.changeId, head: change.branch } : {}),
        };
        const row = hostRow(landed(db, true, d, pr.mergedMs, fallback, undefined));
        if (row) out.push(row);
      }
      continue;
    }
    const change = changeOf(db, repo.path, pr.number);
    const train = change?.state === "merged";
    const d: TrainEventData = {
      ...base,
      prNumber: pr.number,
      ...(pr.url ? { prUrl: pr.url } : {}),
      ...(change ? { changeId: change.changeId } : {}),
      head: pr.head,
      ...(pr.createdMs === undefined ? {} : { prCreatedAt: new Date(pr.createdMs).toISOString() }),
      ...(actor(pr.author) ? { authorKind: actor(pr.author) } : {}),
      ...(actor(pr.mergedBy) ? { mergedByKind: actor(pr.mergedBy) } : {}),
      ...(pr.mergedByLogin ? { mergedBy: pr.mergedByLogin } : {}),
    };
    const row = hostRow(landed(db, train, d, pr.mergedMs, fallback, info.defaultBranch));
    if (!row) continue;
    if (pr.title !== "") row.title = pr.title;
    else delete row.title;
    if (pr.additions === undefined) delete row.additions;
    else row.additions = pr.additions;
    if (pr.deletions === undefined) delete row.deletions;
    else row.deletions = pr.deletions;
    const why = !train && row.route !== store.SKIPPED ? skipWhy(pr, repo.path, info) : undefined;
    if (why) {
      row.route = store.SKIPPED;
      row.skipWhy = why;
    }
    out.push(row);
  }
  return out;
}

/** A first-parent commit no PR brought in: pushed straight to the default branch. */
function pushRow(repo: RepoRef, c: LandedCommit, owner?: [string, string]): MergeRow {
  return {
    repo: repo.remote,
    unitKey: `commit:${c.sha}`,
    ...(owner ? { machineId: owner[0], projectId: owner[1] } : {}),
    mergedMs: c.atMs,
    mergedSha: c.sha,
    route: c.bot ? store.SKIPPED : "direct",
    ...(c.bot ? { skipWhy: "bot" } : {}),
    authorKind: c.bot ? "bot" : "human",
    ...(c.title !== "" ? { title: c.title } : {}),
    url: `https://${repo.remote}/commit/${c.sha}`,
    src: "host",
  };
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

/** The person's acts among a host's: an act on a fleetd task's PR made during one of that task's runs is the agent's. */
function personActs(inner: hostActs.HostActs, db: HubDb, nowMs: number): hostActs.HostActs {
  return {
    async actsSince(repo, sinceMs) {
      const acts = await inner.actsSince(repo, sinceMs);
      return acts.filter((a) => !agentsAct(db, repo, a, nowMs));
    },
  };
}

/** The task a fleetd branch names: `fleetd/T12-…`, under any prefix (`slot/1/fleetd/T12-…`). */
function branchTask(head: string): number | undefined {
  const at = head.lastIndexOf("fleetd/T");
  if (at < 0) return undefined;
  const d = /^\d+/.exec(head.slice(at + "fleetd/T".length))?.[0];
  return d === undefined ? undefined : Number(d);
}


/**
 * Whether an act on `remote` was made during a run of the fleetd task that wrote its PR: from its run span; while the
 * task runs, from its current attempt on; older than the span retention, the task's start to its end.
 */
export function agentsAct(db: HubDb, remote: string, act: hostActs.HostAct, nowMs: number): boolean {
  const slash = remote.indexOf("/");
  const path = slash < 0 ? remote : remote.slice(slash + 1);
  const changeTask = changeOf(db, path, act.prNumber)?.taskId;
  let n: number | undefined;
  if (changeTask !== undefined) {
    const d = /^T(\d+)$/.exec(changeTask)?.[1];
    n = d === undefined ? undefined : Number(d);
  } else {
    const t = act.head === undefined ? undefined : branchTask(act.head);
    if (t !== undefined && taskOnRepo(db, t, remote, path)) n = t;
  }
  if (n === undefined) return false;
  const taskId = `T${n}`;
  const c = db.conn;
  const inRun = c
    .query<{ v: number }, [string, number, number]>(
      `SELECT EXISTS (SELECT 1 FROM time_spans WHERE task_id = ?1 AND kind = ?2
         AND start_ms <= ?3 AND (end_ms IS NULL OR end_ms >= ?3)) AS v`,
    )
    .get(taskId, kindCode("run"), act.atMs)?.v;
  if (inRun) return true;
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
        "SELECT MAX(created_ms) AS v FROM events WHERE type = 'task.started' AND json_extract(data, '$.data.taskId') = ?1",
      )
      .get(taskId)?.v ?? undefined;
    const from = attempt ?? started;
    if (from !== undefined && act.atMs >= from) return true;
  }
  const spansFrom = nowMs - retentionDays(c) * store.DAY_MS;
  const end = row.ended === null ? nowMs : (parseMs(row.ended) ?? nowMs);
  return act.atMs < spansFrom && started !== undefined && act.atMs >= started && act.atMs <= end;
}

/** Whether task `n` belongs to a project on this hub that has the repo: checked out, owning its train, or a Change. */
function taskOnRepo(db: HubDb, n: number, remote: string, path: string): boolean {
  return (
    db.conn
      .query<{ v: number }, [number, string, string]>(
        `SELECT EXISTS (SELECT 1 FROM tasks t WHERE t.n = ?1 AND (
           EXISTS (SELECT 1 FROM metric_project_repos o WHERE o.repo = ?2
                     AND o.machine_id = t.machine_id AND o.project_id = t.project_id)
           OR EXISTS (SELECT 1 FROM trains r WHERE r.repo = ?3
                        AND r.machine_id = t.machine_id AND r.project_id = t.project_id)
           OR EXISTS (SELECT 1 FROM changes h WHERE h.repo = ?3
                        AND h.machine_id = t.machine_id AND h.project_id = t.project_id))) AS v`,
      )
      .get(n, remote, path.toLowerCase())?.v === 1
  );
}
