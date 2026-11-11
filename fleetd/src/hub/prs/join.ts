// The pure part of the PR views: GitHub's answers and the hub's records joined
// into rows, checks and reviews rolled up, and a file's patch split into numbered lines.
import type {
  AgentRole,
  Change,
  ChangeReview,
  ChecksState,
  ChecksSummary,
  DiffLine,
  DiffLineKind,
  PrAuthor,
  PrCheck,
  PrFile,
  PrFileStatus,
  PrQueue,
  PrRow,
  PrState,
  ReviewState,
  ReviewSummary,
  Task,
} from "../../shared/contracts.ts";
import { redact } from "../../shared/redact.ts";
import { TRAIN_CONTEXT } from "../train/github.ts";
import { TERMINAL_STATES } from "../train/records.ts";
import { clip, isoMs, parseMs } from "../train/seams.ts";
import type { GhCheck, GhFile, GhPull } from "./github.ts";

/** One file's diff line is cut past this many characters (contracts `PR_DIFF_LINE_MAX`). */
export const PR_DIFF_LINE_MAX = 400;

/** What the rows need from the hub's records, read once per answer. */
export type RowCtx = {
  tasksById: Map<string, Task>;
  /** Write tasks by their branch, for PRs opened from a task's branch before it was queued. */
  tasksByBranch: Map<string, Task>;
  /** Per repo (lowercase): how many PRs wait in its queue. */
  queues: Map<string, number>;
};

export function rowCtx(tasks: Task[]): RowCtx {
  const tasksById = new Map<string, Task>();
  const tasksByBranch = new Map<string, Task>();
  for (const t of tasks) {
    if (!tasksById.has(t.taskId)) tasksById.set(t.taskId, t);
    if (t.branch !== undefined) tasksByBranch.set(t.branch, t);
  }
  return { tasksById, tasksByBranch, queues: new Map() };
}

/** `normalize_iso`: an RFC 3339 time in the hub's own form, anything else as it came. */
export function normalizeIso(text: string): string {
  const ms = parseMs(text);
  return ms === undefined ? text : isoMs(ms);
}

/** The first `max` UTF-16 units, never splitting a character (`js_take`). */
export const jsTake = clip;

/** A task's role on a board (orders/phase.rs `role`). */
export function roleOf(task: Task): AgentRole {
  if (task.kind === "write") return "implementer";
  if (task.kind === "read") return "reader";
  return task.qa === true ? "qa" : "reviewer";
}

/** A check's state, or undefined for fleetd's own statuses. */
export function checkState(c: GhCheck): [string, ChecksState] | undefined {
  const name = (c.name ?? c.context ?? "").trim();
  if (name === "" || name === TRAIN_CONTEXT) return undefined;
  let state: ChecksState;
  if (c.__typename === "StatusContext" || (c.state != null && c.status == null)) {
    const s = (c.state ?? "").toUpperCase();
    state = s === "SUCCESS" ? "passing" : s === "FAILURE" || s === "ERROR" ? "failing" : "pending";
  } else if ((c.status ?? "").toLowerCase() !== "completed") {
    state = "pending";
  } else {
    const s = (c.conclusion ?? "").toUpperCase();
    state = s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED" ? "passing" : s === "" ? "pending" : "failing";
  }
  return [name, state];
}

export function checksSummary(checks: GhCheck[]): ChecksSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    const s = checkState(c)?.[1];
    if (s === undefined) continue;
    if (s === "passing") passed++;
    else if (s === "failing") failed++;
    else pending++;
  }
  const state: ChecksState = failed > 0 ? "failing" : pending > 0 ? "pending" : passed > 0 ? "passing" : "none";
  return { state, passed, failed, pending };
}

const optText = (s: string | null | undefined, max: number) =>
  s != null && s.trim() !== "" ? jsTake(s, max) : undefined;

export function check(c: GhCheck): PrCheck | undefined {
  const cs = checkState(c);
  if (!cs) return undefined;
  const [name, state] = cs;
  const out: PrCheck = { name: jsTake(name, 200), state };
  const conclusion = optText((c.conclusion ?? c.state)?.toLowerCase(), 200);
  if (conclusion !== undefined) out.conclusion = conclusion;
  const url = optText(c.detailsUrl ?? c.targetUrl, 2000);
  if (url !== undefined) out.url = url;
  if (c.startedAt) out.startedAt = normalizeIso(c.startedAt);
  if (c.completedAt && !c.completedAt.startsWith("0001")) out.completedAt = normalizeIso(c.completedAt);
  return out;
}

/** A Change's review is of its current patch (or of its head, before the patch id is known). */
const ofCurrentPatch = (change: Change, r: ChangeReview) =>
  change.patchId !== undefined ? r.patchId === change.patchId : r.prHeadSha === change.headSha;

/** A verdict counts for the PR's current change: as the Change records it when it does, else of the current head. */
export function isCurrent(change: Change, taskId: string, sha: string): boolean {
  const r = change.reviews.find((r) => r.taskId === taskId && r.prHeadSha === sha);
  return r ? ofCurrentPatch(change, r) : change.headSha === sha;
}

export function reviewSummary(change: Change | undefined, needed: number, decision: string | null | undefined): ReviewSummary {
  const fromGithub = (): ReviewState => {
    switch (decision ?? "") {
      case "APPROVED":
        return "approved";
      case "CHANGES_REQUESTED":
        return "changes_requested";
      case "REVIEW_REQUIRED":
        return "pending";
      default:
        return "none";
    }
  };
  if (!change) return { state: fromGithub(), done: 0, needed: 0 };
  const current = change.reviews.filter((r) => ofCurrentPatch(change, r));
  const done = current.filter((r) => r.blocking === 0).length;
  const blocked = current.some((r) => r.blocking > 0);
  const state: ReviewState = blocked
    ? "changes_requested"
    : needed > 0 && done >= needed
      ? "approved"
      : needed > 0
        ? "pending"
        : fromGithub();
  return { state, done, needed: Math.max(needed, 0) };
}

/** The agent behind a task, as the PR views name it. */
export function agentOf(task: Task, role: AgentRole): PrAuthor {
  const out: PrAuthor = { laneId: task.taskId, taskId: task.taskId, role, title: jsTake(task.title, 80), profile: task.profile };
  if (task.threadRef !== undefined) out.threadRef = task.threadRef;
  return out;
}

export function author(task: Task | undefined, login: string | undefined): PrAuthor {
  const out: PrAuthor = task ? agentOf(task, roleOf(task)) : {};
  const l = optText(login, 100000);
  if (l !== undefined) out.login = l;
  return out;
}

/** How a ready Change's `lastError` starts while the train holds it back (train/batch.ts). */
const HELD = "held: ";

export function queue(change: Change, length: number): PrQueue {
  const held = change.state === "needs_rebase" || change.state === "ci_failed" || change.state === "refused";
  const out: PrQueue = { changeId: change.changeId, state: change.state, length };
  if (change.position !== undefined) out.position = change.position;
  if (held && change.lastError !== undefined) out.reason = clip(redact(change.lastError), 2000);
  // A ready PR the train holds back says why: its label, a person's approval it waits for, no CI.
  else if (change.state === "ready" && change.lastError?.startsWith(HELD)) out.reason = clip(redact(change.lastError.slice(HELD.length)), 2000);
  return out;
}

function ghState(pull: GhPull): PrState {
  const s = pull.state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return pull.isDraft ? "draft" : "open";
}

function changeState(change: Change): PrState {
  if (change.state === "merged") return "merged";
  if (change.state === "refused" || change.state === "abandoned") return "closed";
  return "open";
}

export const isOpen = (state: PrState) => state === "open" || state === "draft";

/** One row from GitHub's PR (when GitHub was reached) and fleetd's Change for it (when fleetd lands it). */
export function row(repo: string, pull: GhPull | undefined, change: Change | undefined, ctx: RowCtx): PrRow | undefined {
  const number = pull?.number ?? change?.prNumber;
  if (number === undefined || number < 1) return undefined;
  const url = change?.prUrl ?? `https://github.com/${repo}/pull/${number}`;
  let task = change?.taskId !== undefined ? ctx.tasksById.get(change.taskId) : undefined;
  if (!task) {
    const branch = pull?.headRefName ?? change?.branch;
    if (branch !== undefined) task = ctx.tasksByBranch.get(branch);
  }
  const title = pull && pull.title.trim() !== "" ? pull.title : (task?.title ?? `PR #${number}`);
  // Every PR the train lands needs one clean review of its current patch.
  const needed = change ? 1 : 0;
  const length = ctx.queues.get(repo.toLowerCase()) ?? 0;
  const stamp = (gh: string | undefined, ours: string | undefined) => (gh ? normalizeIso(gh) : (ours ?? ""));
  const out: PrRow = {
    repo,
    number,
    url,
    title: jsTake(title, 300),
    state: pull ? ghState(pull) : change ? changeState(change) : "open",
    review: reviewSummary(change, needed, pull?.reviewDecision),
    author: author(task, pull?.author?.login),
    createdAt: stamp(pull?.createdAt, change?.createdAt),
    updatedAt: stamp(pull?.updatedAt, change?.updatedAt),
  };
  if (pull) out.checks = checksSummary(pull.statusCheckRollup);
  if (change) out.queue = queue(change, length);
  const branch = pull && pull.headRefName !== "" ? pull.headRefName : change?.branch;
  if (branch !== undefined && branch !== "") out.branch = branch;
  const ws = change?.workstreamId ?? task?.workstreamId;
  if (ws !== undefined) out.workstreamId = ws;
  const merged = pull?.mergedAt ? normalizeIso(pull.mergedAt) : change?.state === "merged" ? change.updatedAt : undefined;
  if (merged !== undefined) out.mergedAt = merged;
  return out;
}

/** Where a row sorts in the list, the greater first: open, then most recently updated, then by number and repo. */
export type RowKey = [boolean, string, number, string];

export const rowKey = (r: PrRow): RowKey => [isOpen(r.state), r.updatedAt, r.number, r.repo.toLowerCase()];

/** The key GitHub's PR would sort at, as far as its list says. */
export const pullKey = (repo: string, pull: GhPull): RowKey => [isOpen(ghState(pull)), normalizeIso(pull.updatedAt), pull.number, repo.toLowerCase()];

/** Rust's tuple order: negative when `a` sorts before `b`. */
export function compareKeys(a: RowKey, b: RowKey): number {
  if (a[0] !== b[0]) return a[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] - b[2];
  if (a[3] !== b[3]) return a[3] < b[3] ? -1 : 1;
  return 0;
}

/**
 * A project's rows: GitHub's open PRs and those closed since `closedSince` on its repos, joined with fleetd's Changes
 * (newest first), plus Changes GitHub's lists didn't carry that are still open or recently ended. Open first, then
 * most recently updated; at most `max`.
 */
export function rows(pulls: [string, GhPull][], changes: Change[], closedSince: string, ctx: RowCtx, max: number): { rows: PrRow[]; truncated: boolean } {
  const newest = new Map<string, Change>();
  for (const c of changes) {
    const k = `${c.repo.toLowerCase()}#${c.prNumber}`;
    if (!newest.has(k)) newest.set(k, c);
  }
  const seen = new Set<string>();
  const out: PrRow[] = [];
  for (const [repo, pull] of pulls) {
    const k = `${repo.toLowerCase()}#${pull.number}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ended = pull.mergedAt ?? pull.closedAt ?? pull.updatedAt;
    if (!isOpen(ghState(pull)) && normalizeIso(ended) < closedSince) continue;
    const r = row(repo, pull, newest.get(k), ctx);
    if (r) out.push(r);
  }
  for (const [k, change] of newest) {
    if (seen.has(k)) continue;
    const open = !TERMINAL_STATES.includes(change.state);
    if (open || change.updatedAt >= closedSince) {
      const r = row(change.repo, undefined, change, ctx);
      if (r) out.push(r);
    }
  }
  out.sort((a, b) => compareKeys(rowKey(b), rowKey(a)));
  return { rows: out.slice(0, max), truncated: out.length > max };
}

/** A `pr_list` cursor: the key of the last row of its page. */
export const cursorOf = (k: RowKey) => `${k[0] ? "o" : "c"}|${k[1]}|${k[2]}|${k[3]}`;

export function keyOfCursor(cursor: string): RowKey | undefined {
  const parts = cursor.split("|");
  if (parts.length < 4) return undefined;
  const [open, at, n] = parts as [string, string, string];
  const rest = parts.slice(3).join("|");
  if (open !== "o" && open !== "c") return undefined;
  if (!/^[+-]?\d+$/.test(n)) return undefined;
  return [open === "o", at, Number(n), rest];
}

export function fileStatus(status: string): PrFileStatus {
  return (["added", "removed", "renamed", "copied", "unchanged", "changed"] as string[]).includes(status)
    ? (status as PrFileStatus)
    : "modified";
}

export function file(f: GhFile): PrFile | undefined {
  if (f.filename === "") return undefined;
  const out: PrFile = {
    path: jsTake(f.filename, 1000),
    status: fileStatus(f.status),
    additions: Math.max(f.additions, 0),
    deletions: Math.max(f.deletions, 0),
  };
  const prev = optText(f.previous_filename, 1000);
  if (prev !== undefined) out.previousPath = prev;
  if (f.patch != null) out.diffLines = diffLines(f.patch).length;
  return out;
}

/** "@@ -12,7 +14,9 @@ fn main": the old and new start lines and the trailing context. */
function hunk(line: string): [number, number, string] | undefined {
  if (!line.startsWith("@@ -")) return undefined;
  const rest = line.slice(4);
  const at = rest.indexOf(" @@");
  const [ranges, context] = at < 0 ? [rest, ""] : [rest.slice(0, at), rest.slice(at + 3)];
  const plus = ranges.indexOf(" +");
  if (plus < 0) return undefined;
  const start = (r: string) => {
    const s = r.split(",")[0] ?? "";
    return /^[+-]?\d+$/.test(s) ? Number(s) : undefined;
  };
  const o = start(ranges.slice(0, plus));
  const n = start(ranges.slice(plus + 2));
  return o === undefined || n === undefined ? undefined : [o, n, context.trimStart()];
}

/** A unified patch as numbered lines, secrets replaced and long lines cut. */
export function diffLines(patch: string): DiffLine[] {
  let old = 0;
  let next = 0;
  const out: DiffLine[] = [];
  const push = (kind: DiffLineKind, raw: string, o?: number, n?: number) => {
    const text = redact(raw);
    const cut = jsTake(text, PR_DIFF_LINE_MAX);
    const line: DiffLine = { kind, text: cut };
    if (cut.length < text.length) line.cut = true;
    if (o !== undefined) line.old = Math.max(o, 0);
    if (n !== undefined) line.new = Math.max(n, 0);
    out.push(line);
  };
  // Rust's `str::lines`: split on \n, a trailing \r dropped, no last empty line.
  const lines = patch.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const h = hunk(line);
    if (h) {
      [old, next] = h;
      push("hunk", h[2], h[0], h[1]);
    } else if (line.startsWith("+")) {
      push("add", line.slice(1), undefined, next);
      next++;
    } else if (line.startsWith("-")) {
      push("del", line.slice(1), old, undefined);
      old++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" describes the line before it.
    } else {
      push("context", line.startsWith(" ") ? line.slice(1) : line, old, next);
      old++;
      next++;
    }
  }
  return out;
}
