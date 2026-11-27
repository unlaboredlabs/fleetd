// What the workspace keeps of a finished agent, its pure parts (no SQLite, no node): the bounds, its kept steps cut to
// them and paged as agent_work pages, and the git commands its files and commits are read with, and their parsers.
// steps_kept.ts stores the steps; Tasks.keep (index.ts) reads all of it at the agent's end.
import type { TaskCommit, TaskFile, WorkStep } from "../../shared/contracts.ts";
import { fitPage } from "../agents/paging.ts";

/** The newest steps an ended thread keeps. */
export const KEPT_STEPS = 200;
/** The most bytes of JSON they take. */
export const KEPT_MAX_BYTES = 512 * 1024;
/** How long after its end a thread's steps stay. */
export const KEPT_FOR_MS = 30 * 86_400_000;
/** The most commits a result lists (TaskResult.commits). */
export const KEPT_COMMITS = 20;
/** The most files a result lists (TaskResult.files). */
export const KEPT_FILES = 200;

/** The steps to keep of `newestFirst`, oldest first: the newest KEPT_STEPS within KEPT_MAX_BYTES. */
export const keptSteps = (newestFirst: readonly WorkStep[]): WorkStep[] => fitPage(newestFirst.slice(0, KEPT_STEPS), KEPT_MAX_BYTES)[0];

/**
 * agent_work's page of kept steps (oldest first): the `limit` newest strictly older than `before`, and whether older
 * ones are left, the way a live page reads.
 */
export function keptPage(steps: readonly WorkStep[], before: [string, string] | undefined, limit: number): [WorkStep[], boolean] {
  const older = before === undefined ? steps : steps.filter((s) => s.at < before[0] || (s.at === before[0] && s.id < before[1]));
  const page = older.slice(Math.max(0, older.length - limit));
  return [page, older.length > page.length];
}

/**
 * The changed files' command for `paths`, run in the worktree: from where its branch left `base.ref` to the worktree
 * now, renames followed. `base.sha` (the start's commit) when there is no ref to meet.
 */
export const filesArgv = (base: { ref?: string; sha: string }, paths: readonly string[]): string[] => [
  ...(base.ref !== undefined && base.ref !== "" ? ["git", "diff", "--numstat", "-M", "--merge-base", base.ref] : ["git", "diff", "--numstat", "-M", base.sha]),
  "--",
  ...paths,
];

/**
 * The changed paths (the node's `changes`, every one) in batches whose numstat lines fit in `room` characters of a
 * command's output, which keeps only its last OUTPUT_TAIL_MAX: one command for them all would lose the first files of
 * a big change. A line is counted as twice its path (a rename names both) and its two counts. The first KEPT_FILES.
 */
export function pathBatches(paths: readonly string[], room: number): string[][] {
  const out: string[][] = [];
  let batch: string[] = [];
  let used = 0;
  for (const path of paths.slice(0, KEPT_FILES)) {
    const cost = 2 * path.length + 24;
    if (batch.length > 0 && used + cost > room) {
      out.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(path);
    used += cost;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** The branch's own commits' command (as the handoff reads them): none a remote has on another branch, newest first. */
export const commitsArgv = (branch: string): string[] => [
  "git",
  "log",
  "--format=%h%x09%<(72,trunc)%s",
  "-n",
  String(KEPT_COMMITS),
  "HEAD",
  "--not",
  `--exclude=*/${branch}`,
  "--remotes",
];

/**
 * The lines of a command's output tail: a tail of `max` units or more may have lost its first line's start, so that
 * line goes.
 */
function whole(tail: string, max: number): string[] {
  const lines = tail.split("\n").filter((l) => l.trim() !== "");
  return tail.length >= max ? lines.slice(1) : lines;
}

/** `git diff --numstat -M` as files; a rename's `a => b` (or `dir/{a => b}/f`) as its new path. */
export function filesOf(numstat: string, tailMax: number): TaskFile[] {
  return whole(numstat, tailMax).flatMap((line) => {
    const [add = "", del = "", ...rest] = line.split("\t");
    const raw = rest.join("\t");
    if (raw === "") return [];
    const path = raw.includes("{") ? raw.replace(/\{[^{}]*? => ([^{}]*)\}/u, "$1").replace(/\/\//gu, "/") : (raw.split(" => ").at(-1) ?? raw);
    const n = (s: string) => (/^\d+$/u.test(s) ? Number(s) : 0);
    return [{ path, additions: n(add), deletions: n(del) }];
  }).slice(0, KEPT_FILES);
}

/** commitsArgv's output as commits, newest first. */
export function commitsOf(log: string, tailMax: number): TaskCommit[] {
  return whole(log, tailMax).flatMap((line) => {
    const tab = line.indexOf("\t");
    const sha = (tab < 0 ? line : line.slice(0, tab)).trim();
    return /^[0-9a-f]{4,40}$/u.test(sha) ? [{ sha, subject: tab < 0 ? "" : line.slice(tab + 1).trim() }] : [];
  }).slice(0, KEPT_COMMITS);
}
