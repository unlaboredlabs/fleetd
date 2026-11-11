// What the train asks of GitHub, through the `gh` CLI on the hub machine: PRs,
// rebasing a PR's branch, batch branches built by merges, patch ids, check runs on a head, the `fleetd/train` commit
// status, the pinned squash merge, and recently merged PRs, to report merges outside it. The train runs no git of its
// own but `git patch-id`.
import type { CiInfo } from "../../shared/contracts.ts";
import { type GhOut, type GhRunner, GhStartError } from "./gh.ts";
import { type FreshLike, freshGithub, parseMs } from "./seams.ts";

export const TRAIN_CONTEXT = "fleetd/train";
export const GH_AUTH_FIX = "run `gh auth login` on the hub machine";
/** How often a read GitHub fails transiently is tried in all, the waits between doubling from `READ_RETRY_FIRST_MS`. */
export const READ_TRIES = 3;
const READ_RETRY_FIRST_MS = 1000;

export type GhErrorKind = "auth" | "missing" | "failed" | "unavailable";

export class GhError extends Error {
  constructor(
    readonly kind: GhErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GhError";
  }

  static failed(message: string): GhError {
    return new GhError("failed", message);
  }
}

export type PullHead = { ref: string; sha: string; repo?: { full_name: string } | null };
export type Label = { name: string };

export type Pull = {
  number: number;
  title: string;
  state: string;
  /** Absent from a PR list, which has `merged_at` only. */
  merged: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  body?: string | null;
  head: PullHead;
  base: { ref: string };
  labels: Label[];
  /** A draft waits on the train until it is marked ready. */
  draft: boolean;
  /** Who merged it: only a PR's detail says. */
  merged_by?: { login: string; type?: string } | null;
  /** Whether it merges cleanly into its base: only a PR's detail says, and null while GitHub still works it out. */
  mergeable?: boolean | null;
  /** GitHub's word for it: `dirty` when it conflicts, `unknown` while GitHub still works it out. */
  mergeable_state?: string | null;
};

/** A pull as serde reads it: the fields with defaults filled. Undefined when a required one is missing. */
export function readPull(v: unknown): Pull | undefined {
  const p = v as Record<string, any> | null;
  if (!p || typeof p.state !== "string" || !p.head || !p.base) return undefined;
  if (typeof p.head.ref !== "string" || typeof p.head.sha !== "string" || typeof p.base.ref !== "string") return undefined;
  return {
    ...p,
    number: typeof p.number === "number" ? p.number : 0,
    title: typeof p.title === "string" ? p.title : "",
    merged: p.merged === true,
    labels: Array.isArray(p.labels) ? p.labels : [],
    draft: p.draft === true,
  } as Pull;
}

/** The label that keeps a PR off the train until someone takes it off. */
export const HOLD_LABEL = "hold";
/** The label the train puts on its batch PR and on the next PRs it will merge. */
export const NEXT_LABEL = "fleetd:next";

export const labelled = (pull: Pull, name: string) => pull.labels.some((l) => l.name.toLowerCase() === name.toLowerCase());
export const held = (pull: Pull) => labelled(pull, HOLD_LABEL);
/** GitHub found it conflicts with its base. Never while GitHub still works it out. */
export const conflicts = (pull: Pull) => pull.mergeable === false || pull.mergeable_state === "dirty";

/** The machine-readable line in a batch PR's body naming each member and the head it was built from. */
export const BATCH_MARKER = "fleetd-batch:";
/** A hidden line on every comment the train posts. */
export const TRAIN_MARK = "<!-- fleetd:train -->";

/** Each member a batch PR's body names on its `fleetd-batch:` line, with the head sha it was built from. */
export function batchHeads(body: string): [number, string | undefined][] {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith(BATCH_MARKER));
  if (line === undefined) return [];
  const out: [number, string | undefined][] = [];
  for (const w of line.slice(BATCH_MARKER.length).split(/\s+/).filter(Boolean)) {
    const bare = w.replace(/^#+/, "");
    const at = bare.indexOf("@");
    const [n, sha] = at < 0 ? [bare, undefined] : [bare.slice(0, at), bare.slice(at + 1).toLowerCase()];
    if (/^[+-]?\d+$/.test(n)) out.push([Number(n), sha]);
  }
  return out;
}

export type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion?: string | null;
  html_url?: string | null;
  /** GitHub's own stamps, whole seconds. */
  started_at?: string | null;
  completed_at?: string | null;
  head_sha?: string | null;
};

/** The workflow run that reported it, from its page (`.../actions/runs/<id>/job/<job>`). */
export function workflowRun(run: CheckRun): number | undefined {
  const url = run.html_url ?? "";
  const at = url.indexOf("/actions/runs/");
  if (at < 0) return undefined;
  const id = url.slice(at + "/actions/runs/".length).split("/")[0] ?? "";
  return /^\d+$/.test(id) ? Number(id) : undefined;
}

/** The Actions job behind it, from its page (`.../job/<job>`). */
export function jobOf(run: CheckRun): number | undefined {
  const url = run.html_url ?? "";
  const at = url.indexOf("/job/");
  if (at < 0) return undefined;
  const id = url.slice(at + 5).split(/[/?#]/)[0] ?? "";
  return /^\d+$/.test(id) ? Number(id) : undefined;
}

export type WorkflowRun = {
  id: number;
  workflow_id: number;
  name?: string | null;
  path?: string | null;
  head_sha: string;
  /** `queued`, `in_progress`, `completed`...; the runs list reads only finished ones. */
  status?: string | null;
  conclusion?: string | null;
  html_url: string;
  updated_at?: string | null;
};

export type RunJob = { name: string; conclusion?: string | null };

/** The latest run of each check in `runs`, first-seen order. */
export function latest(runs: CheckRun[]): CheckRun[] {
  const order: string[] = [];
  const newest = new Map<string, CheckRun>();
  for (const r of runs) {
    const seen = newest.get(r.name);
    if (seen === undefined) {
      order.push(r.name);
      newest.set(r.name, r);
    } else if (supersedes(r, seen)) {
      newest.set(r.name, r);
    }
  }
  return order.map((n) => newest.get(n)!);
}

/**
 * Whether `next` replaces `seen`, a run of the same check: the newer one does, except that a cancelled twin never
 * stands in for a run that is still going, and a skipped twin never stands in for a run that ran.
 */
function supersedes(next: CheckRun, seen: CheckRun): boolean {
  const cancelled = (r: CheckRun) => r.conclusion === "cancelled";
  const skipped = (r: CheckRun) => r.conclusion === "skipped";
  const running = (r: CheckRun) => r.status !== "completed";
  if (cancelled(next) && running(seen)) return false;
  if (cancelled(seen) && running(next)) return true;
  if (skipped(next) !== skipped(seen)) return skipped(seen);
  return next.id > seen.id;
}

/** A commit status on a head, as GitHub's combined status lists it. */
export type CommitStatus = { context: string; state: string; target_url?: string | null };

/** An open PR as the list answers it. */
export type OpenPull = { number: number; draft: boolean; head: PullHead };

export type MergedPull = {
  number: number;
  mergedAt: string;
  mergeSha?: string;
  base: string;
  /** Its branch. */
  head: string;
  /** Opened by a bot account, when GitHub said. */
  authorBot?: boolean;
  createdAt?: string;
};

type ClosedPull = {
  number: number;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base: { ref: string };
  head: { ref: string };
  user?: { type?: string } | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function merged(p: ClosedPull): MergedPull | undefined {
  if (p.merged_at == null) return undefined;
  const m: MergedPull = { number: p.number, mergedAt: p.merged_at, base: p.base.ref, head: p.head.ref };
  if (p.merge_commit_sha != null) m.mergeSha = p.merge_commit_sha;
  if (p.user != null) m.authorBot = p.user.type === "Bot";
  if (p.created_at != null) m.createdAt = p.created_at;
  return m;
}

/**
 * GitHub's squash message from the repo's settings and the PR's commit messages, oldest first. One commit gives its
 * own subject and body; several give the PR's title and a `* ` line per commit, with their `Co-authored-by` trailers
 * gathered once at the end, as GitHub does.
 */
export function squashText(pull: Pull, titleFrom: string, bodyFrom: string, messages: string[]): [string, string] {
  const split = (m: string): [string, string] => {
    const t = m.replaceAll("\r\n", "\n").trim();
    const nl = t.indexOf("\n");
    return nl < 0 ? [t, ""] : [t.slice(0, nl).trim(), t.slice(nl + 1).trim()];
  };
  const one = messages.length === 1 ? split(messages[0]!) : undefined;
  const title = one && titleFrom === "COMMIT_OR_PR_TITLE" ? one[0] : pull.title.trim();
  let body: string;
  if (bodyFrom === "PR_BODY") {
    body = (pull.body ?? "").replaceAll("\r\n", "\n");
  } else if (bodyFrom === "BLANK") {
    body = "";
  } else if (one) {
    body = one[1];
  } else {
    const coAuthor = (l: string) => l.toLowerCase().startsWith("co-authored-by:");
    const coAuthors: string[] = [];
    const lines: string[] = [];
    for (const raw of messages) {
      const m = raw.replaceAll("\r\n", "\n");
      const kept = m
        .trim()
        .split("\n")
        .filter((l) => !coAuthor(l.trim()));
      lines.push(`* ${kept.join("\n").trim()}`);
      for (const l of m.split("\n").map((x) => x.trim()).filter(coAuthor)) {
        if (!coAuthors.some((c) => c.toLowerCase() === l.toLowerCase())) coAuthors.push(l);
      }
    }
    body = lines.join("\n\n");
    if (coAuthors.length > 0) body = `${body}\n\n---------\n\n${coAuthors.join("\n")}`;
  }
  return [`${title} (#${pull.number})`, body];
}

/** Pages of closed PRs `mergedPulls` reads at most per check. */
export const MERGED_PAGES = 2;
const MERGED_PAGE = 100;

export type MergeOutcome = { kind: "merged"; sha: string } | { kind: "refused"; status: number; message: string };
/** What `gh pr update-branch --rebase` did to a PR's branch. */
export type BranchUpdate = "current" | "rebased" | "conflict";
/** What merging a PR's head into the train's batch branch on GitHub did. */
export type BranchMerge = { kind: "merged"; sha: string } | { kind: "nothing" } | { kind: "conflict" };

export const isSha = (s: string) => (s.length === 40 || s.length === 64) && /^[0-9a-f]+$/.test(s);

/** `git patch-id --stable` of `diff`, by the hub's git, which needs no repository for it. */
async function stablePatchId(diff: string): Promise<string> {
  let child;
  try {
    child = Bun.spawn(["git", "patch-id", "--stable"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  } catch (error) {
    throw new Error(`git patch-id could not start on the hub: ${error}`);
  }
  child.stdin.write(diff);
  await child.stdin.end();
  const out = await new Response(child.stdout).text();
  await child.exited;
  // "<patch id> <commit id>", the commit id zeros for a diff read from stdin; nothing for an empty diff.
  const id = out.split(/\s+/).find(Boolean);
  if (id === undefined || !isSha(id)) throw new Error("the diff against its merge base is empty");
  return id;
}

type Reply = { ok: true; value: unknown } | { ok: false; status: number; message: string };

const authHint = (stderr: string) => {
  const s = stderr.toLowerCase();
  return s.includes("gh auth login") || s.includes("not logged in") || s.includes("authentication required");
};

/** `HTTP nnn` in gh's stderr. */
export function httpStatus(stderr: string): number {
  for (const m of stderr.matchAll(/HTTP (\d{3})(?!\d)/g)) return Number(m[1]);
  return 0;
}

/** Whether a failed answer may well be different a moment later: a 5xx, a timeout, or a secondary rate limit. */
export function transient(status: number, message: string): boolean {
  const m = message.toLowerCase();
  if (status >= 500 || status === 429) return true;
  if (status === 403) return m.includes("secondary rate limit");
  if (status === 0) return ["timed out", "timeout", "deadline exceeded"].some((t) => m.includes(t));
  return false;
}

/** `owner/name` of a `repos/<owner>/<name>/...` path, lowercased: the `github:<repo>` freshness source. */
function repoOfPath(path: string): string | undefined {
  if (!path.startsWith("repos/")) return undefined;
  const [owner, name] = path.slice(6).split(/[/?]/);
  return owner !== undefined && name !== undefined ? `${owner}/${name}`.toLowerCase() : undefined;
}

/** `s` percent-encoded for a URL path (`/` kept when `path`) or query value. */
export function encodeUrl(s: string, path: boolean): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c;
    else if (c === "/" && path) out += "/";
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function lastLine(stderr: string): string {
  const last = stderr.trim().split("\n").at(-1) ?? "";
  return [...(last.startsWith("gh: ") ? last.slice(4) : last)].slice(0, 500).join("");
}

const short = (sha: string) => sha.slice(0, 12);

/** The repo's workflows and branch rules as adding a project reads them (projects/inspect.rs, its CI part). */
export function ciFromAnswers(workflows: unknown, branch: unknown, rules: unknown): CiInfo {
  const ci: CiInfo = { requiredChecks: [], workflows: [] };
  const push = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };
  const rows = (workflows as { workflows?: unknown } | null)?.workflows;
  if (Array.isArray(rows)) {
    for (const w of rows as Record<string, unknown>[]) {
      // GitHub's own dynamic workflows (Copilot, Dependabot) are not the repo's CI.
      const dynamic = typeof w.path === "string" && w.path.startsWith("dynamic/");
      if (!dynamic && w.state === "active" && typeof w.name === "string") push(ci.workflows, w.name);
    }
  }
  const contexts = (branch as any)?.protection?.required_status_checks?.contexts;
  if (Array.isArray(contexts)) for (const c of contexts) if (typeof c === "string") push(ci.requiredChecks, c);
  if (Array.isArray(rules)) {
    for (const rule of rules as Record<string, any>[]) {
      if (rule.type !== "required_status_checks") continue;
      const checks = rule.parameters?.required_status_checks;
      if (Array.isArray(checks)) for (const c of checks) if (typeof c?.context === "string") push(ci.requiredChecks, c.context);
    }
  }
  return ci;
}

/** How GitHub merges a PR. */
export type MergeMethod = "squash" | "rebase" | "merge";
const METHODS: MergeMethod[] = ["squash", "rebase", "merge"];

/** What a base's rules ask of a merge beyond its checks. */
export type BaseRules = {
  /** An approving review is required: a count of them, or the code owners'. */
  approval: boolean;
  /** A push to an approved PR may drop its approval. */
  dismissStale: boolean;
  /** How the train merges: a squash where the repo allows one, else a rebase, else a merge commit. */
  method: MergeMethod;
  /** What couldn't be read, each with why: what the train did before it read these rules stands in. */
  unread: string[];
};

/** A base's CI config and its rules. */
export type BaseConfig = CiInfo & { rules: BaseRules };

/**
 * A base's rules from its rulesets (`rules/branches/<base>`), its classic protection (GraphQL's `branchProtectionRule`,
 * null without one) and the repo's settings. An answer left undefined wasn't read.
 */
export function rulesFromAnswers(rules: unknown, classic: unknown, repo: unknown): Omit<BaseRules, "unread"> {
  let approval = false;
  let dismissStale = false;
  const allowed: string[][] = [];
  if (Array.isArray(rules)) {
    for (const rule of rules as Record<string, any>[]) {
      if (rule.type !== "pull_request") continue;
      const p = rule.parameters ?? {};
      if (p.required_approving_review_count > 0 || p.require_code_owner_review === true) approval = true;
      if (p.dismiss_stale_reviews_on_push === true || p.require_last_push_approval === true) dismissStale = true;
      if (Array.isArray(p.allowed_merge_methods)) allowed.push(p.allowed_merge_methods);
    }
  }
  const c = classic as Record<string, any> | null | undefined;
  if (c) {
    // `requiresApprovingReviews` alone is "a pull request is required": its count may be 0, which asks for no approval.
    if ((c.requiresApprovingReviews === true && c.requiredApprovingReviewCount > 0) || c.requiresCodeOwnerReviews === true) approval = true;
    if (c.dismissesStaleReviews === true || c.requireLastPushApproval === true) dismissStale = true;
  }
  const r = repo as Record<string, unknown> | null | undefined;
  if (r) {
    const off = (key: string) => r[key] === false;
    allowed.push(METHODS.filter((m) => !off(m === "merge" ? "allow_merge_commit" : `allow_${m}_merge`)));
  }
  // None allowed is GitHub's to refuse: the train asks for a squash, as before.
  const method = METHODS.find((m) => allowed.every((list) => list.includes(m))) ?? "squash";
  return { approval, dismissStale, method };
}

export type Sleep = (ms: number) => Promise<void>;

const CLASSIC_RULE =
  "query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { " +
  "branchProtectionRule { requiresApprovingReviews requiredApprovingReviewCount requiresCodeOwnerReviews dismissesStaleReviews requireLastPushApproval } } } }";

export class TrainGitHub {
  constructor(
    readonly gh: GhRunner,
    private readonly fresh: FreshLike,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {}

  private reached(path: string): void {
    const repo = repoOfPath(path);
    if (repo !== undefined) this.fresh.touch(freshGithub(repo), this.now());
  }

  private missed(path: string, why: string): void {
    const repo = repoOfPath(path);
    if (repo !== undefined) this.fresh.fail(freshGithub(repo), why);
  }

  /** One `gh` run: gh missing or not logged in is an error of its own kind. */
  private async run(args: string[]): Promise<GhOut> {
    let out: GhOut;
    try {
      out = await this.gh.run(args);
    } catch (error) {
      const spawn = error instanceof GhStartError ? error.message : String((error as Error)?.message ?? error);
      if (spawn === "ENOENT") {
        throw new GhError("missing", `gh is not installed on the hub machine: install the GitHub CLI, then ${GH_AUTH_FIX}`);
      }
      throw GhError.failed(`gh could not start: ${spawn}`);
    }
    if (out.exitCode === 4 || (out.exitCode !== 0 && authHint(out.stderr))) {
      throw new GhError("auth", `gh is not authenticated: ${GH_AUTH_FIX}`);
    }
    return out;
  }

  /** `gh api` with `accept`: the answer's text, or `[status, message]` for a non-2xx answer. */
  async exchange(
    method: string,
    path: string,
    accept: string,
    fields: [string, string][] = [],
  ): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
    const args = ["api", "-X", method, "-H", accept, path];
    for (const [k, v] of fields) {
      // `draft` is a JSON boolean; -f would send the string "true".
      args.push(k === "draft" ? "-F" : "-f", `${k}=${v}`);
    }
    // A read GitHub fails transiently is asked again, `READ_TRIES` times in all; a write could have landed.
    let tries = 1;
    let wait = READ_RETRY_FIRST_MS;
    let reply: { ok: true; text: string } | { ok: false; status: number; message: string } | undefined;
    let thrown: GhError | undefined;
    for (;;) {
      reply = undefined;
      thrown = undefined;
      try {
        const out = await this.run(args);
        if (out.exitCode === 0) {
          reply = { ok: true, text: out.stdout };
        } else {
          // gh prints GitHub's error body on stdout; its message is the plainest reason.
          let message: string | undefined;
          try {
            const m = (JSON.parse(out.stdout) as { message?: unknown }).message;
            if (typeof m === "string") message = m;
          } catch {}
          reply = { ok: false, status: httpStatus(out.stderr), message: message ?? lastLine(out.stderr) };
        }
      } catch (error) {
        if (!(error instanceof GhError)) throw error;
        thrown = error;
      }
      const why =
        reply && !reply.ok && transient(reply.status, reply.message)
          ? reply.message
          : thrown && thrown.kind === "failed" && transient(0, thrown.message)
            ? thrown.message
            : undefined;
      if (why === undefined || method !== "GET" || tries >= READ_TRIES) break;
      console.info(`train: GitHub failed a read of ${path} (try ${tries}): ${why}; asking again`);
      await this.sleep(wait);
      tries++;
      wait *= 2;
    }
    if (reply?.ok) this.reached(path);
    // GitHub answered, just not with what was asked for (404, 405, 409, 422): it was reached.
    else if (reply && reply.status >= 400 && reply.status < 500) this.reached(path);
    else if (reply) this.missed(path, reply.message);
    else if (thrown) this.missed(path, thrown.message);
    if (thrown) {
      if (thrown.kind === "failed" && transient(0, thrown.message)) throw new GhError("unavailable", thrown.message);
      throw thrown;
    }
    return reply!;
  }

  /** `gh api {path} failed: {message}`, unavailable when GitHub failed transiently. */
  private static failed(path: string, status: number, message: string): GhError {
    return new GhError(transient(status, message) ? "unavailable" : "failed", `gh api ${path} failed: ${message}`);
  }

  private async call(method: string, path: string, fields: [string, string][] = []): Promise<Reply> {
    const r = await this.exchange(method, path, "Accept: application/vnd.github+json", fields);
    if (!r.ok) return r;
    try {
      return { ok: true, value: JSON.parse(r.text === "" ? "null" : r.text) };
    } catch {
      throw GhError.failed(`gh api ${path} did not return JSON`);
    }
  }

  private async json<T>(method: string, path: string, fields: [string, string][] = [], check?: (v: unknown) => T | undefined): Promise<T> {
    const r = await this.call(method, path, fields);
    if (!r.ok) throw TrainGitHub.failed(path, r.status, r.message);
    const v = check ? check(r.value) : (r.value as T);
    if (v === undefined) throw GhError.failed(`gh api ${path} returned an unexpected shape`);
    return v;
  }

  /** A GET for callers outside the train: `{ ok: false, status, message }` for a non-2xx answer. */
  async get(path: string): Promise<{ ok: true; value: unknown } | { ok: false; status: number; message: string }> {
    return this.call("GET", path);
  }

  /** A GraphQL query with string `vars`: its `data`, or an error when GitHub answers with errors. */
  async graphql(query: string, vars: [string, string][] = []): Promise<unknown> {
    const r = await this.call("POST", "graphql", [["query", query], ...vars]);
    if (!r.ok) throw TrainGitHub.failed("graphql", r.status, r.message);
    const v = r.value as { data?: unknown; errors?: { message?: string }[] } | null;
    if (v?.errors == null) return v?.data ?? null;
    throw GhError.failed(`gh api graphql failed: ${v.errors[0]?.message ?? "an error"}`);
  }

  pull(repo: string, n: number): Promise<Pull> {
    return this.json("GET", `repos/${repo}/pulls/${n}`, [], readPull);
  }

  /** The latest run of each check on `sha`. */
  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    return latest(await this.allCheckRuns(repo, sha));
  }

  /** The check runs on `sha` as GitHub lists them. */
  async allCheckRuns(repo: string, sha: string): Promise<CheckRun[]> {
    return this.json("GET", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, [], (v) =>
      Array.isArray((v as any)?.check_runs) ? ((v as any).check_runs as CheckRun[]) : undefined,
    );
  }

  /** The finished runs on `base` that a schedule started, newest first: one page of 50. */
  scheduledRuns(repo: string, base: string): Promise<WorkflowRun[]> {
    return this.json("GET", `repos/${repo}/actions/runs?branch=${base}&event=schedule&status=completed&per_page=50`, [], (v) =>
      Array.isArray((v as any)?.workflow_runs) ? ((v as any).workflow_runs as WorkflowRun[]) : undefined,
    );
  }

  /**
   * The workflow runs on commit `sha`, whatever their branch, each its id and the event that started it (`push`,
   * `workflow_dispatch`, `schedule`...): one page of 100.
   */
  async shaRunEvents(repo: string, sha: string): Promise<[number, string][]> {
    const runs = await this.json<{ id: number; event: string }[]>("GET", `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, [], (v) =>
      Array.isArray((v as any)?.workflow_runs) ? ((v as any).workflow_runs as { id: number; event: string }[]) : undefined,
    );
    return runs.map((r) => [r.id, r.event]);
  }

  /** The jobs of a workflow run, each at its latest attempt. */
  runJobs(repo: string, run: number): Promise<RunJob[]> {
    return this.json("GET", `repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`, [], (v) =>
      Array.isArray((v as any)?.jobs) ? ((v as any).jobs as RunJob[]) : undefined,
    );
  }

  /** The commits on `sha` since `from`, oldest first, each its short sha and its title, and how many in all. */
  async commitsSince(repo: string, from: string, sha: string): Promise<{ commits: [string, string][]; total: number }> {
    const c = await this.json<{ commits: { sha: string; commit: { message: string } }[]; total_commits: number }>(
      "GET",
      `repos/${repo}/compare/${from}...${sha}`,
      [],
      (v) => (Array.isArray((v as any)?.commits) ? (v as any) : undefined),
    );
    return { commits: c.commits.map((x) => [short(x.sha), x.commit.message.split("\n")[0] ?? ""]), total: c.total_commits };
  }

  /** The newest commit status of each context on `sha`. */
  statuses(repo: string, sha: string): Promise<CommitStatus[]> {
    return this.json("GET", `repos/${repo}/commits/${sha}/status?per_page=100`, [], (v) =>
      Array.isArray((v as any)?.statuses) ? ((v as any).statuses as CommitStatus[]) : undefined,
    );
  }

  /** Re-runs Actions job `job` and the jobs that need it, and nothing else of its workflow run. */
  async rerunJob(repo: string, job: number): Promise<void> {
    await this.json("POST", `repos/${repo}/actions/jobs/${job}/rerun`, [], (v) => v ?? null);
  }

  /** Workflow run `run`, at its latest attempt. */
  workflowRun(repo: string, run: number): Promise<WorkflowRun> {
    return this.json("GET", `repos/${repo}/actions/runs/${run}`, [], (v) => (typeof (v as any)?.id === "number" ? (v as WorkflowRun) : undefined));
  }

  /** Re-runs every job of finished workflow run `run`, as a new attempt. */
  async rerunRun(repo: string, run: number): Promise<void> {
    await this.json("POST", `repos/${repo}/actions/runs/${run}/rerun`, [], (v) => v ?? null);
  }

  /** The log of Actions job `job`, as text. */
  async jobLog(repo: string, job: number): Promise<string> {
    const r = await this.exchange("GET", `repos/${repo}/actions/jobs/${job}/logs`, "Accept: application/vnd.github+json");
    if (!r.ok) throw GhError.failed(`the log of job ${job}: ${r.message}`);
    return r.text;
  }

  /** Posts `fleetd/train=success` on `sha`. */
  async postTrainStatus(repo: string, sha: string, description: string): Promise<void> {
    const fields: [string, string][] = [
      ["state", "success"],
      ["context", TRAIN_CONTEXT],
      ["description", [...description].slice(0, 140).join("")],
    ];
    await this.json("POST", `repos/${repo}/statuses/${sha}`, fields, (v) => v ?? null);
  }

  /**
   * Merges by `method` pinned to `sha`; `message` is the squash commit's title and body when GitHub's default won't do.
   * A merge commit keeps GitHub's title and takes the body; a rebase lands the PR's own commits, with no message.
   */
  async merge(repo: string, n: number, sha: string, message?: [string, string], method: MergeMethod = "squash"): Promise<MergeOutcome> {
    const fields: [string, string][] = [
      ["merge_method", method],
      ["sha", sha],
    ];
    if (message && method === "squash") fields.push(["commit_title", message[0]]);
    if (message && method !== "rebase") fields.push(["commit_message", message[1]]);
    const r = await this.call("PUT", `repos/${repo}/pulls/${n}/merge`, fields);
    if (!r.ok) {
      if (r.status === 405 || r.status === 409) return { kind: "refused", status: r.status, message: r.message };
      throw GhError.failed(`merging ${repo}#${n} failed: ${r.message}`);
    }
    const m = r.value as { sha?: unknown; merged?: unknown } | null;
    if (typeof m?.sha !== "string" || typeof m.merged !== "boolean") {
      throw GhError.failed(`merging ${repo}#${n} returned an unexpected shape`);
    }
    return m.merged ? { kind: "merged", sha: m.sha } : { kind: "refused", status: 405, message: "GitHub did not merge it" };
  }

  /** The squash message GitHub writes for `pull` by the repo's settings: its title and body. */
  async squashMessage(repo: string, pull: Pull): Promise<[string, string]> {
    const settings = await this.json<Record<string, unknown>>("GET", `repos/${repo}`, [], (v) => (v && typeof v === "object" ? (v as any) : undefined));
    const titleFrom = typeof settings.squash_merge_commit_title === "string" ? settings.squash_merge_commit_title : "COMMIT_OR_PR_TITLE";
    const bodyFrom = typeof settings.squash_merge_commit_message === "string" ? settings.squash_merge_commit_message : "COMMIT_MESSAGES";
    const messages: string[] = [];
    if (titleFrom === "COMMIT_OR_PR_TITLE" || bodyFrom === "COMMIT_MESSAGES") {
      // GitHub lists at most 250 commits of a PR.
      for (let page = 1; page <= 3; page++) {
        const commits = await this.json<{ commit: { message: string } }[]>(
          "GET",
          `repos/${repo}/pulls/${pull.number}/commits?per_page=100&page=${page}`,
          [],
          (v) => (Array.isArray(v) ? v : undefined),
        );
        messages.push(...commits.map((c) => c.commit.message));
        if (commits.length < 100) break;
      }
    }
    return squashText(pull, titleFrom, bodyFrom, messages);
  }

  /**
   * Rebases the PR's branch onto its base on GitHub (`gh pr update-branch --rebase`); with `rebase` false GitHub merges
   * the base into it instead, which rewrites none of its commits.
   */
  async updateBranch(repo: string, n: number, rebase = true): Promise<BranchUpdate> {
    const path = `repos/${repo}/pulls/${n}`;
    let out: GhOut;
    try {
      out = await this.run(["pr", "update-branch", String(n), ...(rebase ? ["--rebase"] : []), "--repo", repo]);
    } catch (error) {
      this.missed(path, (error as Error).message);
      throw error;
    }
    const conflict = out.stderr.toLowerCase().includes("conflict");
    if (out.exitCode !== 0 && !conflict) {
      const why = lastLine(out.stderr);
      this.missed(path, why);
      throw GhError.failed(`rebasing ${repo}#${n} on GitHub failed: ${why}`);
    }
    this.reached(path);
    return out.exitCode !== 0 ? "conflict" : out.stdout.includes("PR branch updated") ? "rebased" : "current";
  }

  /** Where `branch` points now. */
  async branchSha(repo: string, branch: string): Promise<string> {
    const r = await this.json<{ object: { sha: string } }>("GET", `repos/${repo}/git/ref/heads/${branch}`, [], (v) =>
      typeof (v as any)?.object?.sha === "string" ? (v as any) : undefined,
    );
    return r.object.sha.toLowerCase();
  }

  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.json("POST", `repos/${repo}/git/refs`, [
      ["ref", `refs/heads/${branch}`],
      ["sha", sha],
    ], (v) => v ?? null);
  }

  /** Merges `sha` into `branch` on GitHub, a merge commit with `message`. */
  async mergeInto(repo: string, branch: string, sha: string, message: string): Promise<BranchMerge> {
    const r = await this.call("POST", `repos/${repo}/merges`, [
      ["base", branch],
      ["head", sha],
      ["commit_message", message],
    ]);
    if (r.ok) {
      if (r.value === null) return { kind: "nothing" };
      const s = (r.value as { sha?: unknown }).sha;
      if (typeof s !== "string") throw GhError.failed(`merging into ${branch} returned no sha`);
      return { kind: "merged", sha: s.toLowerCase() };
    }
    if (r.status === 409) return { kind: "conflict" };
    throw GhError.failed(`merging ${short(sha)} into ${branch} failed: ${r.message}`);
  }

  /** The patch id of `sha` against its merge base with `base`, the diff from GitHub. */
  async patchId(repo: string, base: string, sha: string): Promise<string> {
    if (!isSha(sha)) throw GhError.failed(`not a full commit SHA: ${[...sha].slice(0, 80).join("")}`);
    return this.patchIdFrom(repo, await this.branchSha(repo, base), sha);
  }

  /** The patch id of `sha` against its merge base with the commit `from`. */
  async patchIdFrom(repo: string, from: string, sha: string): Promise<string> {
    const at = `${repo}@${short(sha)}`;
    const diff = await this.diff(repo, from, sha);
    try {
      return await stablePatchId(diff);
    } catch (error) {
      throw GhError.failed(`the patch id of ${at}: ${(error as Error).message}`);
    }
  }

  /** The diff of `sha` against its merge base with the commit `from`, as GitHub shows it. */
  async diff(repo: string, from: string, sha: string): Promise<string> {
    const r = await this.exchange("GET", `repos/${repo}/compare/${from}...${sha}`, "Accept: application/vnd.github.diff");
    if (!r.ok) throw GhError.failed(`the diff of ${repo}@${short(sha)}: ${r.message}`);
    return r.text;
  }

  /** The patch id of the commit `sha` alone: its diff against its first parent. */
  async commitPatchId(repo: string, sha: string): Promise<string> {
    const at = `${repo}@${short(sha)}`;
    const r = await this.exchange("GET", `repos/${repo}/commits/${sha}`, "Accept: application/vnd.github.diff");
    if (!r.ok) throw GhError.failed(`the diff of ${at}: ${r.message}`);
    try {
      return await stablePatchId(r.text);
    } catch (error) {
      throw GhError.failed(`the patch id of ${at}: ${(error as Error).message}`);
    }
  }

  /** The commits `sha` has on its merge base with `from`, oldest first, and that merge base; undefined when partial. */
  async range(repo: string, from: string, sha: string): Promise<{ base: string; commits: string[] } | undefined> {
    const c = await this.json<{ merge_base_commit: { sha: string }; commits: { sha: string }[]; total_commits: number }>(
      "GET",
      `repos/${repo}/compare/${from}...${sha}`,
      [],
      (v) => (Array.isArray((v as any)?.commits) && (v as any).merge_base_commit ? (v as any) : undefined),
    );
    if (c.commits.length !== c.total_commits) return undefined;
    return { base: c.merge_base_commit.sha.toLowerCase(), commits: c.commits.map((x) => x.sha.toLowerCase()) };
  }

  /** Comments on the PR with why (marked as the train's), then closes it. */
  async close(repo: string, n: number, comment: string): Promise<void> {
    await this.json("POST", `repos/${repo}/issues/${n}/comments`, [["body", `${comment}\n\n${TRAIN_MARK}`]], (v) => v ?? null);
    await this.json("PATCH", `repos/${repo}/pulls/${n}`, [["state", "closed"]], (v) => v ?? null);
  }

  /** Opens a PR from `head` into `base`, or, when one is already open, retitles it. Its number. */
  async openPull(repo: string, head: string, base: string, title: string, body: string, draft: boolean): Promise<number> {
    const open = await this.openPullFor(repo, head);
    if (open !== undefined) {
      await this.editPull(repo, open, [
        ["title", title],
        ["body", body],
      ]);
      return open;
    }
    const opened = await this.json<{ number: number }>(
      "POST",
      `repos/${repo}/pulls`,
      [
        ["head", head],
        ["base", base],
        ["title", title],
        ["body", body],
        ["draft", draft ? "true" : "false"],
      ],
      (v) => (typeof (v as any)?.number === "number" ? (v as any) : undefined),
    );
    return opened.number;
  }

  /** The open PR whose head is `branch` of `repo`, if any. */
  async openPullFor(repo: string, branch: string): Promise<number | undefined> {
    return (await this.pullsFor(repo, branch, "open"))[0]?.number;
  }

  /** PRs whose head is `branch` of `repo`, in `state`, newest first. */
  pullsFor(repo: string, branch: string, state: string): Promise<Pull[]> {
    const owner = repo.split("/")[0] ?? "";
    return this.json("GET", `repos/${repo}/pulls?head=${owner}:${branch}&state=${state}&per_page=10`, [], (v) =>
      Array.isArray(v) ? (v.map(readPull).filter(Boolean) as Pull[]) : undefined,
    );
  }

  /** PATCHes the PR: title, body, base or state. */
  async editPull(repo: string, n: number, fields: [string, string][]): Promise<void> {
    await this.json("PATCH", `repos/${repo}/pulls/${n}`, fields, (v) => v ?? null);
  }

  /** The repo's branches whose names start with `prefix`. */
  async matchingBranches(repo: string, prefix: string): Promise<string[]> {
    const refs = await this.json<{ ref: string }[]>("GET", `repos/${repo}/git/matching-refs/heads/${prefix}?per_page=100`, [], (v) =>
      Array.isArray(v) ? v : undefined,
    );
    return refs.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => r.ref.slice("refs/heads/".length));
  }

  /** Deletes a branch of the train's own; one already gone counts as deleted. */
  async deleteBranch(repo: string, branch: string): Promise<void> {
    const r = await this.call("DELETE", `repos/${repo}/git/refs/heads/${branch}`);
    if (!r.ok && r.status !== 404 && r.status !== 422) throw GhError.failed(`deleting ${branch} on ${repo} failed: ${r.message}`);
  }

  /** Creates the repo's label `name`; one the repo already has counts as created. */
  async createLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    const r = await this.call("POST", `repos/${repo}/labels`, [
      ["name", name],
      ["color", color],
      ["description", description],
    ]);
    if (!r.ok && r.status !== 422) throw GhError.failed(`creating the label ${name} on ${repo} failed: ${r.message}`);
  }

  async addLabel(repo: string, n: number, name: string): Promise<void> {
    await this.json("POST", `repos/${repo}/issues/${n}/labels`, [["labels[]", name]], (v) => v ?? null);
  }

  /** Takes `name` off the PR; one without it counts as done. */
  async removeLabel(repo: string, n: number, name: string): Promise<void> {
    const r = await this.call("DELETE", `repos/${repo}/issues/${n}/labels/${name.replaceAll(":", "%3A")}`);
    if (!r.ok && r.status !== 404) throw GhError.failed(`taking the label off ${repo}#${n} failed: ${r.message}`);
  }

  /** Each workflow file in `.github/workflows` on `branch`, by path, with its text. */
  async workflowFiles(repo: string, branch: string): Promise<[string, string][]> {
    const at = encodeUrl(branch, false);
    const r = await this.call("GET", `repos/${repo}/contents/.github/workflows?ref=${at}`);
    if (!r.ok) {
      if (r.status === 404) return [];
      throw GhError.failed(`the workflows of ${repo}: ${r.message}`);
    }
    if (!Array.isArray(r.value)) throw GhError.failed(`the workflows of ${repo} came in an unexpected shape`);
    const files: [string, string][] = [];
    for (const e of r.value as { path: string; type: string }[]) {
      if (e.type !== "file" || !(e.path.endsWith(".yml") || e.path.endsWith(".yaml"))) continue;
      const t = await this.exchange("GET", `repos/${repo}/contents/${encodeUrl(e.path, true)}?ref=${at}`, "Accept: application/vnd.github.raw");
      if (!t.ok) throw GhError.failed(`${e.path}: ${t.message}`);
      files.push([e.path, t.text]);
    }
    return files;
  }

  /** The text of the file `path` on `branch`; undefined when it has none. */
  async file(repo: string, path: string, branch: string): Promise<string | undefined> {
    const at = encodeUrl(branch, false);
    const r = await this.exchange("GET", `repos/${repo}/contents/${encodeUrl(path, true)}?ref=${at}`, "Accept: application/vnd.github.raw");
    if (r.ok) return r.text;
    if (r.status === 404) return undefined;
    throw GhError.failed(`${path} on ${branch}: ${r.message}`);
  }

  /** The names of the files in the directory `dir` on `branch`; none when it has no such directory. */
  async fileNames(repo: string, rawDir: string, branch: string): Promise<string[]> {
    const at = encodeUrl(branch, false);
    const dir = rawDir.replace(/\/+$/, "");
    const r = await this.call("GET", `repos/${repo}/contents/${encodeUrl(dir, true)}?ref=${at}`);
    if (!r.ok) {
      if (r.status === 404) return [];
      throw GhError.failed(`${dir} on ${branch}: ${r.message}`);
    }
    if (!Array.isArray(r.value)) throw GhError.failed(`${dir} on ${branch} is not a directory`);
    return (r.value as { name: string; type: string }[]).filter((e) => e.type === "file").map((e) => e.name);
  }

  /** The paths a PR adds, by GitHub's list of its files (up to 3,000). */
  async addedFiles(repo: string, n: number): Promise<string[]> {
    const added: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const files = await this.json<{ filename: string; status: string }[]>(
        "GET",
        `repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`,
        [],
        (v) => (Array.isArray(v) ? v : undefined),
      );
      added.push(...files.filter((f) => f.status === "added").map((f) => f.filename));
      if (files.length < 100) break;
    }
    return added;
  }

  /** The repo's open PRs that carry the label `name` (one page). */
  async labelledPulls(repo: string, name: string): Promise<number[]> {
    const issues = await this.json<{ number: number; pull_request?: unknown }[]>(
      "GET",
      `repos/${repo}/issues?state=open&labels=${name}&per_page=100`,
      [],
      (v) => (Array.isArray(v) ? v : undefined),
    );
    return issues.filter((i) => i.pull_request != null).map((i) => i.number);
  }

  /** The repo's default branch. */
  async defaultBranch(repo: string): Promise<string> {
    const r = await this.json<{ default_branch: string }>("GET", `repos/${repo}`, [], (v) =>
      typeof (v as any)?.default_branch === "string" ? (v as any) : undefined,
    );
    return r.default_branch;
  }

  /** The repo's open PRs, newest first (one page). */
  openPulls(repo: string): Promise<OpenPull[]> {
    return this.json("GET", `repos/${repo}/pulls?state=open&sort=created&direction=desc&per_page=100`, [], (v) =>
      Array.isArray(v) ? (v as any[]).map((p) => ({ number: p.number, draft: p.draft === true, head: p.head })) : undefined,
    );
  }

  /** Closed PRs that were merged, most recently updated first, paged until one was last updated before `sinceMs`. */
  async mergedPulls(repo: string, sinceMs: number): Promise<MergedPull[]> {
    const out: MergedPull[] = [];
    for (let page = 1; page <= MERGED_PAGES; page++) {
      const pulls = await this.json<ClosedPull[]>(
        "GET",
        `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${MERGED_PAGE}&page=${page}`,
        [],
        (v) => (Array.isArray(v) ? v : undefined),
      );
      const full = pulls.length === MERGED_PAGE;
      const last = pulls.at(-1);
      const lastAt = last?.updated_at ? parseMs(last.updated_at) : undefined;
      const passed = last === undefined || lastAt === undefined || lastAt < sinceMs;
      for (const p of pulls) {
        const m = merged(p);
        if (m) out.push(m);
      }
      if (!full || passed) break;
    }
    return out;
  }

  /** The merged PRs a commit came from. */
  async mergedPullsOf(repo: string, sha: string): Promise<MergedPull[]> {
    const pulls = await this.json<ClosedPull[]>("GET", `repos/${repo}/commits/${sha}/pulls`, [], (v) => (Array.isArray(v) ? v : undefined));
    return pulls.map(merged).filter((m): m is MergedPull => m !== undefined);
  }

  /**
   * GitHub's own answer on PR `n`'s reviews: `APPROVED`, `REVIEW_REQUIRED` or `CHANGES_REQUESTED`; undefined where
   * its base requires none, and (seen on a ruleset, 2026-11) while a conversation its base wants resolved is open: a
   * merge is then refused for that rule, whatever its approvals.
   */
  async reviewDecision(repo: string, n: number): Promise<string | undefined> {
    const [owner, name] = repo.split("/") as [string, string];
    const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequest(number: ${n}) { reviewDecision } } }`;
    const data = (await this.graphql(query, [["owner", owner], ["name", name]])) as { repository?: { pullRequest?: { reviewDecision?: unknown } | null } | null } | null;
    const pull = data?.repository?.pullRequest;
    if (pull == null) throw GhError.failed(`the reviews of ${repo}#${n} were not answered`);
    return typeof pull.reviewDecision === "string" ? pull.reviewDecision : undefined;
  }

  /**
   * The repo's workflows, the checks `branch` requires and its rules. A read of the workflows or the required checks
   * failing is an error, never "no CI"; one of the rules' own reads failing is named in `rules.unread`.
   */
  async ciConfig(repo: string, branch: string): Promise<BaseConfig> {
    const obj = (v: unknown) => (v !== null && typeof v === "object" ? v : undefined);
    const workflows = await this.json("GET", `repos/${repo}/actions/workflows?per_page=100`, [], obj);
    const protection = await this.json("GET", `repos/${repo}/branches/${branch}`, [], obj);
    const rules = await this.json("GET", `repos/${repo}/rules/branches/${branch}`, [], obj);
    const unread: string[] = [];
    const soft = async <T>(what: string, read: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await read();
      } catch (error) {
        unread.push(`${what}: ${(error as Error).message}`);
        return undefined;
      }
    };
    const classic = await soft("its branch protection", async () => {
      const [owner, name] = repo.split("/") as [string, string];
      const data = (await this.graphql(CLASSIC_RULE, [["owner", owner], ["name", name], ["ref", `refs/heads/${branch}`]])) as any;
      return (data?.repository?.ref?.branchProtectionRule ?? null) as unknown;
    });
    const settings = await soft("the repo's merge methods", () => this.json("GET", `repos/${repo}`, [], obj));
    return { ...ciFromAnswers(workflows, protection, rules), rules: { ...rulesFromAnswers(rules, classic, settings), unread } };
  }
}
