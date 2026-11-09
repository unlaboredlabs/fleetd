// `metrics_get` (crates/fleetd/src/hub/metrics/tools.rs). A project's view covers its repos (the trains it owns, its
// Changes' repos and the merges it owns), with every landed change on them; the fleet's covers every repo a caller can
// read on some machine, each counted once. The two big reads (landed changes and touches) run on the read worker,
// each answering in one JSON text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { GitHost, MetricsCoverage, MetricsGetOutput, RepoCoverage, RepoStale } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { cursor as readCursor } from "../time/store.ts";
import * as compute from "./compute.ts";
import { Identities, attributed, REVIEW_MAX_MS } from "./human.ts";
import * as store from "./store.ts";
import { sweepArea } from "./sweep.ts";
import { clock, zone } from "./zone.ts";

/** Landed changes listed per read, newest first. */
export const MAX_MERGES = 1000;
const MAX_REPOS = 200;

/** What fleetd can't see of the person's time, for the info sheet. */
const INVISIBLE = [
  "Thinking and planning away from the keyboard, meetings and chat outside fleetd.",
  "Time in an editor or IDE, or a Claude Code session not registered with fleetd.",
  "Reading on the git host's website without leaving a review or comment.",
  "How long a review took: git hosts keep only when it was submitted.",
  "Work on machines with no fleetd node, or on a phone.",
  "Typing in your own Claude Code sessions: fleetd doesn't read their transcripts.",
  "Reading in the app, until the app reports when it is in use.",
];

/** What a repo read from git alone can't say (no_host.rs UNKNOWN). */
export const GIT_UNKNOWN = [
  "Who merged each change: git doesn't record it.",
  "Whether a commit with no fleetd trailer was pushed straight or squash-merged from a PR on the host: it reads as pushed straight.",
  "fleetd's work you merged by hand, when its commits carry no Fleetd-Task trailer and the merge doesn't name its fleetd/T… branch: it reads as merged outside fleetd or pushed straight.",
  "Reviews and comments on the host, so your minutes on them.",
  "When each PR was opened, so PR open to merged.",
  "Bot accounts, except commits whose author ends in [bot].",
  "Lines changed.",
];

/** Hosts the sweep has a source for; any other is read from git alone (source/mod.rs has_api). */
const HAS_API = new Set(["github"]);

const NEXT =
  "Your minutes count what fleetd sees (chat, approvals, steers, decisions, orders, and reviews and comments on the git host made by your own login); coverage.invisible lists what it can't. A repo read from git alone lists in coverage.repos[].unknown what git can't say, such as who merged. Each repo is read again within a minute of this read.";

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

function msOf(t: string): number {
  const ms = parseMs(t);
  if (ms === undefined) throw invalid(`${t} is not an ISO time`);
  return ms;
}

/**
 * Every repo the metrics know, with the projects that have it: the trains they own, their Changes' repos, the merges
 * they own and their checkouts' origins.
 */
export function repoProjects(c: Database): compute.Projects {
  const out: compute.Projects = new Map();
  const rows = c
    .query<{ repo: string; m: string | null; p: string | null; github: number }, []>(
      `SELECT repo, machine_id AS m, project_id AS p, 1 AS github FROM trains
       UNION SELECT DISTINCT repo, machine_id, project_id, 1 FROM changes
       UNION SELECT DISTINCT repo, machine_id, project_id, 0 FROM metric_merges WHERE machine_id IS NOT NULL
       UNION SELECT repo, machine_id, project_id, 0 FROM metric_project_repos
       UNION SELECT repo, NULL, NULL, 0 FROM metric_repos`,
    )
    .all();
  for (const row of rows) {
    const repo = row.github ? store.githubRemote(row.repo) : row.repo;
    let refs = out.get(repo);
    if (!refs) out.set(repo, (refs = new Set()));
    if (row.m !== null && row.p !== null) refs.add(compute.pairKey(row.m, row.p));
  }
  return out;
}

const HOSTS: Record<string, GitHost> = {
  github: "github",
  gitlab: "gitlab",
  gitea: "gitea",
  bitbucket: "bitbucket",
  azure_devops: "azure_devops",
  git: "git",
};

const HOST_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  bitbucket: "Bitbucket",
  azure_devops: "Azure DevOps",
};

/** The status area's freshness of a source, peeked (D355): as its view shows it. */
type FreshView = { asOfMs?: number; stale?: { sinceMs: number; reason: string } };
type Fresh = { view(source: string, nowMs: number): FreshView | undefined };

const line200 = (s: string) => compute.line(compute.headUtf16(s, 200), 200);

/** What each repo's figures were read from, and the repos whose reads are failing. */
function coverage(hub: Hub, repos: string[], stored: store.RepoRow[], knownSince: number | undefined, now: number, tz: string): MetricsCoverage {
  const fresh = hub.peek<Fresh>("status_fresh");
  const covered: RepoCoverage[] = [];
  const stale: RepoStale[] = [];
  const byRepo = new Map(stored.map((r) => [r.repo, r]));
  for (const repo of repos.slice(0, MAX_REPOS)) {
    if (!compute.isRemoteRepo(repo)) continue;
    const row = byRepo.get(repo);
    // A train's repo is read by the train's GitHub calls.
    const trainRepo = store.trainRepo(repo);
    const seen = trainRepo === undefined ? undefined : fresh?.view(`github:${trainRepo}`, now);
    const storedHost: GitHost | undefined = row ? HOSTS[row.host] : seen ? "github" : undefined;
    if (storedHost === undefined) continue;
    // A host the sweep has no source for is read from git alone, and says what that can't know.
    const fromGit = row !== undefined && !HAS_API.has(row.host);
    const host: GitHost = fromGit ? "git" : storedHost;
    const reads = [seen?.asOfMs, row?.lastOkMs].filter((v): v is number => v !== undefined);
    const lastRead = reads.length ? Math.max(...reads) : undefined;
    const failing: [number | undefined, string] | undefined = seen?.stale
      ? [seen.stale.sinceMs, seen.stale.reason]
      : row?.lastError !== undefined
        ? [lastRead, row.lastError]
        : undefined;
    if (failing) {
      const name = HOST_NAMES[host] ?? "Its git log";
      const [sinceMs, why] = failing;
      const reason = sinceMs === undefined ? `${name} not read yet: ${why}` : `${name} not read since ${clock(sinceMs, now, tz)}: ${why}`;
      stale.push({ repo, since: isoMs(sinceMs ?? now), reason: line200(reason) ?? "Not read from its git host" });
    }
    const branch = row?.defaultBranch !== undefined ? compute.line(row.defaultBranch, 255) : undefined;
    const known = row?.backfilledMs ?? knownSince;
    covered.push({
      repo,
      host,
      ...(branch === undefined ? {} : { defaultBranch: branch }),
      ...(lastRead === undefined ? {} : { lastRead: isoMs(lastRead) }),
      ...(known === undefined ? {} : { knownSince: isoMs(known) }),
      ...(row?.partlyRead ? { partlyRead: true } : {}),
      ...(fromGit ? { unknown: GIT_UNKNOWN.flatMap((l) => line200(l) ?? []) } : {}),
    });
  }
  return { repos: covered, stale, invisible: INVISIBLE.flatMap((l) => line200(l) ?? []) };
}

/** The commit identity `fleetd init` wrote to `<home>/setup.json`, if any. */
function setupEmail(home: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(home, "setup.json"), "utf8")) as { gitIdentity?: { email?: unknown } };
    return typeof v.gitIdentity?.email === "string" ? v.gitIdentity.email : undefined;
  } catch {
    return undefined;
  }
}

const readsEverywhere = (caller: Caller) => caller.revokedAt === undefined && caller.grants.some((g) => g.machines === "*");

export async function metricsGet(hub: Hub, caller: Caller, input: import("../../shared/contracts.ts").MetricsGetInput): Promise<MetricsGetOutput> {
  const p = input.projectRef;
  if (p) requireRole(caller, "read", p.machineId);
  const now = hub.clock.now();
  const tz = zone(input.tz);
  const until = Math.min(input.until === undefined ? now : msOf(input.until), now);
  let since = msOf(input.since);
  if (since >= until) throw invalid("since must be before until, and before now.", "Pass a since in the past, e.g. 30 days ago.");
  since = compute.clampSince(since, until, tz);
  const prevSince = compute.clampSince(since - (until - since), since, tz);
  const c = hub.db.conn;
  // The person's identities: those recorded (the host's signed-in login) and the commit identity setup wrote.
  const email = setupEmail(hub.config.home);
  const ids = new Identities([...store.identities(c), ...(email === undefined ? [] : [email])]);
  const projects = repoProjects(c);
  const everywhere = readsEverywhere(caller);
  for (const [repo, refs] of projects) {
    const keep = p
      ? refs.has(compute.pairKey(p.machineId, p.projectId))
      : everywhere || [...refs].some((k) => allows(caller, "read", compute.pairOf(k)[0]));
    if (!keep) projects.delete(repo);
  }
  const repos = [...projects.keys()].sort();
  // A read asks the sweep for these repos' latest; it answers with what is stored now.
  sweepArea(hub).want(repos);
  // The big reads, off the event loop: landed changes of both periods, and touches up to a review's credit past
  // `until` (one recorded then may have started before it).
  const [mergeSql, mergeParams] = store.mergesSql(prevSince, until, repos);
  const [touchSql, touchParams] = store.touchesSql(prevSince, until + REVIEW_MAX_MS);
  const [mergeAnswer, touchAnswer] = await Promise.all([
    hub.db.read<{ j: string }>(store.asJson(mergeSql, store.MERGE_COLUMN_LIST), mergeParams),
    hub.db.read<{ j: string }>(store.asJson(touchSql, store.TOUCH_COLUMN_LIST), touchParams),
  ]);
  const rows = store.fromJson(mergeAnswer).map(store.mergeOfValues);
  const touches = store.fromJson(touchAnswer).map(store.touchOfValues).filter((t) => {
    const onRepo = t.repo !== undefined && projects.has(t.repo);
    if (onRepo) return attributed(t, ids);
    const project = t.machineId !== undefined && t.projectId !== undefined;
    const kept = p
      ? project && t.machineId === p.machineId && t.projectId === p.projectId
      : project
        ? allows(caller, "read", t.machineId!)
        : everywhere;
    return kept && attributed(t, ids);
  });
  const knownSince = readCursor(c, store.KNOWN_SINCE);
  const stored = store.repos(c);
  const cur = rows.filter((r) => r.mergedMs >= since);
  const prevRows = rows.filter((r) => r.mergedMs < since);
  const days = compute.days(since, until, tz);
  const prevDays = compute.days(prevSince, since, tz);
  const curPeriod: compute.Period = { rows: cur, touches, days };
  const prevPeriod: compute.Period = { rows: prevRows, touches, days: prevDays };
  // The previous period counts only when every repo's merges were known that far back.
  const byRepo = new Map(stored.map((s) => [s.repo, s]));
  let knownFrom: number | undefined = Number.MIN_SAFE_INTEGER;
  for (const r of repos) {
    const k = byRepo.get(r)?.backfilledMs ?? knownSince;
    if (k === undefined) {
      knownFrom = undefined;
      break;
    }
    knownFrom = Math.max(knownFrom, k);
  }
  const prevKnown = knownFrom !== undefined && knownFrom <= prevSince;
  const onPrs = compute.prTouches(touches);
  const items = cur.flatMap((r) => compute.mergeItem(r, onPrs) ?? []);
  const out: MetricsGetOutput = {
    since: isoMs(since),
    until: isoMs(until),
    tiles: compute.tiles(curPeriod, prevKnown ? prevPeriod : undefined),
    days: compute.dayList(curPeriod),
    merges: items.slice(0, MAX_MERGES),
    mergesTotal: items.length,
    ...(p ? {} : { repos: compute.repoRows(curPeriod, projects).slice(0, MAX_REPOS) }),
    coverage: coverage(hub, repos, stored, knownSince, now, tz),
    ...(input.compare ? { compare: { since: isoMs(prevSince), until: isoMs(since), days: compute.dayList(prevPeriod) } } : {}),
    next: NEXT,
    ...(items.length > MAX_MERGES ? { truncated: true } : {}),
  };
  return out;
}

export function register(tools: Registry): void {
  tools.add("metrics_get", metricsGet);
}
