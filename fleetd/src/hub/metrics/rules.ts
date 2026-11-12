// The metrics' rules, pure: when the host sweep reads a repo again, how the default branch's line and a merged PR
// are read, how git alone routes a commit, the merge-by-hand touch, and the words a read's coverage says. The hub's
// modules hold the reads and writes around them; the hosted service takes the same rules from the package.
import type { GitHost } from "../../shared/contracts.ts";
import { branchTask } from "../../shared/text.ts";
import * as human from "./human.ts";
import { DAY_MS, type MergeRow, type TouchRow } from "./rows.ts";
import type { LandedCommit, MergedPr, RepoInfo } from "./source.ts";

// ---- The host sweep (sweep.ts).

/** A metrics read asks for a repo again once its last read is this old. */
export const ON_READ_MS = 60_000;
/** How often a repo with a merge in the last ACTIVE_FOR_MS is read. */
export const ACTIVE_EVERY_MS = 15 * 60_000;
/** How often any other repo is read. */
export const QUIET_EVERY_MS = 60 * 60_000;
export const ACTIVE_FOR_MS = 7 * DAY_MS;
/** Each read starts this far before the last one, for host clocks and late updates; rows are idempotent. */
export const OVERLAP_MS = 10 * 60_000;
/** A checkout's origin is asked of its node again after a day, or after ten minutes when the node didn't answer. */
export const ORIGIN_EVERY_MS = DAY_MS;
export const ORIGIN_RETRY_MS = 10 * 60_000;
/** The first read of a repo goes this far back. */
export const BACKFILL_MS = 90 * DAY_MS;

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

/** The task a fleetd branch names: `fleetd/T12-…`, under any prefix (`slot/1/fleetd/T12-…`). */
export function headTask(head: string): number | undefined {
  const at = head.lastIndexOf("fleetd/T");
  const n = at < 0 ? undefined : /^\d+/.exec(head.slice(at + "fleetd/T".length))?.[0];
  return n === undefined ? undefined : Number(n);
}

// ---- A repo read from git alone (no_host.ts).

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

// ---- Touches (touches.ts).

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

// ---- What a read covers (tools.ts).

/** Landed changes listed per read, newest first. */
export const MAX_MERGES = 1000;
export const MAX_REPOS = 200;

/** What fleetd can't see of the person's time, for the info sheet. */
export const INVISIBLE = [
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
export const HAS_API = new Set(["github"]);

export const NEXT =
  "Your minutes count what fleetd sees (chat, approvals, steers, decisions, orders, and reviews and comments on the git host made by your own login); coverage.invisible lists what it can't. A repo read from git alone lists in coverage.repos[].unknown what git can't say, such as who merged. Each repo is read again within a minute of this read.";

export const HOSTS: Record<string, GitHost> = {
  github: "github",
  gitlab: "gitlab",
  gitea: "gitea",
  bitbucket: "bitbucket",
  azure_devops: "azure_devops",
  git: "git",
};

export const HOST_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  bitbucket: "Bitbucket",
  azure_devops: "Azure DevOps",
};
