// What git alone records of fleetd's work (crates/fleetd/src/node/landed.rs `landed_log`): the default branch's own
// line with each commit's `Fleetd-Task:` and `Fleetd-Change:` trailers, so the hub can tell the train's merges, merges
// by hand and direct pushes apart for a repo whose host fleetd can't read.
import type { GitCommit, LandedLog } from "../../shared/sessions.ts";
import { LANDED_LOG_MAX } from "../../shared/sessions.ts";
import { GitError, git, gitRemote, refSha, remote } from "../worktree/index.ts";

export const TASK_TRAILER = "Fleetd-Task";
export const CHANGE_TRAILER = "Fleetd-Change";
/** Field, record and value separators in `git log --format`, which no subject holds. */
const FIELD = "\u001f";
const RECORD = "\u001e";
const VALUE = "\u001d";
/** A merge brings in at most this many commits whose trailers are read. */
const MERGED_MAX = "500";
const FETCH_TIMEOUT_MS = 20_000;

const values = (field: string) =>
  field
    .split(VALUE)
    .map((v) => v.trim())
    .filter(Boolean);

const succeeds = (root: string, args: string[]) => git(root, args).then(
  () => true,
  () => false,
);

/** Fetches `branch` from `name` into its remote-tracking ref, leaving FETCH_HEAD (the human's) alone. */
async function fetchBranch(root: string, name: string, branch: string): Promise<void> {
  const args = ["fetch", "--no-tags", "--no-write-fetch-head", name, `+refs/heads/${branch}:refs/remotes/${name}/${branch}`];
  try {
    await gitRemote(root, args, FETCH_TIMEOUT_MS);
  } catch (error) {
    // The human's own fetch racing ours.
    if (!(error as Error).message.includes("cannot lock ref")) throw error;
    await gitRemote(root, args, FETCH_TIMEOUT_MS);
  }
}

/** The default branch `branch` of the checkout at `root`, as its remote has it after a fetch (the last fetched copy
 * when the fetch fails, else the local branch): its first-parent line newest first, back to `stopAt` when that is on
 * it, else the commits made since `sinceMs`, at most LANDED_LOG_MAX. */
export async function landedLog(root: string, branch: string, sinceMs: number, stopAt?: string): Promise<LandedLog> {
  let fetchFailed: string | undefined;
  let read: [rev: string, read: string] | undefined;
  const r = await remote(root);
  if (r) {
    try {
      await fetchBranch(root, r, branch);
    } catch (error) {
      fetchFailed = (error as Error).message;
    }
    if (await refSha(root, `refs/remotes/${r}/${branch}`)) read = [`refs/remotes/${r}/${branch}`, `${r}/${branch}`];
  }
  if (!read && (await refSha(root, `refs/heads/${branch}`))) read = [`refs/heads/${branch}`, branch];
  if (!read) throw new GitError(`${root} has no ${branch}`);
  const [rev, readName] = read;
  const onLine = stopAt !== undefined && (await succeeds(root, ["merge-base", "--is-ancestor", stopAt, rev])) ? stopAt : undefined;
  const format =
    `--format=%H${FIELD}%P${FIELD}%ct${FIELD}%an${FIELD}%s${FIELD}` +
    `%(trailers:key=${CHANGE_TRAILER},valueonly,unfold,separator=%x1d)${FIELD}` +
    `%(trailers:key=${TASK_TRAILER},valueonly,unfold,separator=%x1d)${RECORD}`;
  const args = ["log", "--first-parent", "-n", String(LANDED_LOG_MAX), format];
  if (onLine === undefined) args.push(`--since=${new Date(sinceMs).toISOString()}`);
  args.push(onLine === undefined ? rev : `${onLine}..${rev}`, "--");
  const commits: GitCommit[] = [];
  for (const record of (await git(root, args)).split(RECORD)) {
    const fields = record.replace(/^\n+/, "").split(FIELD);
    if (fields.length !== 7) continue;
    const [sha, parents, at, author, subject, changes, tasks] = fields as [string, string, string, string, string, string, string];
    const c: GitCommit = {
      sha,
      parents: parents.split(/\s+/).filter(Boolean),
      atMs: (Number.parseInt(at.trim(), 10) || 0) * 1000,
      authorName: author,
      subject,
      changes: values(changes),
      tasks: values(tasks),
      mergedTasks: [],
    };
    if (c.parents.length > 1) {
      const merged = await git(root, ["log", "-n", MERGED_MAX, `--format=%(trailers:key=${TASK_TRAILER},valueonly,unfold,separator=%x1d)${VALUE}`, `${c.parents[0]}..${c.sha}`, "--"]);
      for (const task of values(merged)) if (!c.mergedTasks!.includes(task)) c.mergedTasks!.push(task);
    }
    commits.push(c);
  }
  return { read: readName, ...(fetchFailed !== undefined ? { fetchFailed } : {}), commits };
}
