// The train over a fake `gh` that answers like GitHub would from a real bare git "origin" in a temp dir:
// it rebases a PR's branch, merges heads into a batch branch, serves diffs, and
// runs CI (red iff the head has a file FAIL). An author's clone pushes to it, and a fake host stands in for tasks,
// workstreams, events and wakes. Never GitHub itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HubDb } from "../src/hub/store/db.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import type { EventView, NodeRun, ReviewSpawn, TaskView, TimeSink, TrainHost, WorkstreamView } from "../src/hub/train/host.ts";
import { type ReviewGate, Train, type TrainOptions, type Verdict } from "../src/hub/train/service.ts";
import type { Change, ProjectRef } from "../src/shared/contracts.ts";

export const REPO = "acme/storefront";
export const PROJECT: ProjectRef = { machineId: "devbox", projectId: "storefront" };
export const WS = "W1";

const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/tmp",
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};

export function gitOut(cwd: string, args: string[]): string | undefined {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

export function git(cwd: string, args: string[]): string {
  const out = gitOut(cwd, args);
  if (out === undefined) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return out;
}

export type FakePull = {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  mergeSha?: string;
  mergedAt?: string;
  labels: string[];
  draft: boolean;
  comments: string[];
  mergeable?: boolean;
  headRepo?: string;
  /** A person approved it; a rebase drops it where the base dismisses stale approvals. */
  approved?: boolean;
  changesRequested?: boolean;
  /** It has an open conversation, on a base whose ruleset wants each resolved. */
  conversation?: boolean;
};

/** The approving review a base requires. */
export type FakeApprovals = { classic?: boolean; dismissStale?: boolean; codeOwners?: boolean };

const ok = (body: unknown): GhOut => ({ exitCode: 0, stdout: JSON.stringify(body), stderr: "" });
export const httpError = (status: number, message: string): GhOut => ({
  exitCode: 1,
  stdout: JSON.stringify({ message, status: String(status) }),
  stderr: `gh: ${message} (HTTP ${status})\n`,
});

/** GitHub as the train sees it, answered from the origin repo. */
export class FakeGh implements GhRunner {
  readonly pulls = new Map<number, FakePull>();
  readonly statuses: [string, string, string][] = [];
  /** What happened on GitHub, in order: `merge #<n>`, `status <context> <state> <sha>`, `rebase #<n>`, `close #<n>`. */
  readonly log: string[] = [];
  readonly calls: string[][] = [];
  readonly labels: string[] = [];
  /** The checks main requires through a ruleset. */
  required: string[] = [];
  /** No workflows: the repo has no CI. */
  noCi = false;
  /** Main requires an approving review: through a ruleset, or classic branch protection. */
  approvals?: FakeApprovals;
  /** The merge methods the repo's settings allow. */
  methods: string[] = ["squash", "rebase", "merge"];
  /** The merge methods main's ruleset allows, when it names them. */
  ruleMethods?: string[];
  /** What GitHub doesn't show the train: `classic` (branch protection) and `decision` (a PR's reviews), refused; `methods`, the repo's merge methods, left out of its answer. */
  unreadable: string[] = [];
  /** When set, the commit statuses every head has, [context, state], as another CI provider reports them. */
  provider?: (sha: string) => [string, string][];
  /** Scripted answers to the next merge calls, before the fake merges for real. */
  mergeReplies: GhOut[] = [];
  /** When set, the check runs of every head. */
  runs?: (sha: string) => unknown[];
  /** The Actions jobs the train asked GitHub to re-run, in order. */
  readonly reruns: number[] = [];
  /** Each workflow run, by id, as `actions/runs/<id>` answers it. */
  readonly workflowRuns = new Map<number, unknown>();
  /** The workflow runs the train asked GitHub to re-run whole, in order. */
  readonly runReruns: number[] = [];
  /** The workflow runs a person or a schedule started, [run id, event]: on every commit. Every other run is a push. */
  readonly runEvents: [number, string][] = [];

  constructor(
    readonly origin: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  headOf(branch: string): string | undefined {
    return gitOut(this.origin, ["rev-parse", `refs/heads/${branch}`]);
  }

  pullJson(n: number, p: FakePull): Record<string, unknown> {
    return {
      number: n,
      title: p.title,
      state: p.state,
      merged: p.merged,
      merge_commit_sha: p.mergeSha ?? null,
      merged_at: p.mergedAt ?? null,
      body: p.body,
      head: { ref: p.branch, sha: this.headOf(p.branch) ?? "0".repeat(40), repo: { full_name: p.headRepo ?? p.repo } },
      base: { ref: p.base },
      labels: p.labels.map((name) => ({ name })),
      draft: p.draft,
      user: { login: "ada-lovelace", type: "User" },
      created_at: "2026-10-16T09:00:00Z",
      updated_at: "2026-10-17T12:00:00Z",
      merged_by: p.merged ? { login: "ada-lovelace", type: "User" } : null,
      mergeable: p.mergeable ?? null,
      mergeable_state: p.mergeable === true ? "clean" : p.mergeable === false ? "dirty" : "unknown",
    };
  }

  /** A failed job the train re-ran fails again: a newer run of it (its id + 1000), unless a newer one is there. */
  private failingAgain(runs: Record<string, unknown>[]): Record<string, unknown>[] {
    const again = runs
      .filter((r) => r.conclusion === "failure" && this.reruns.includes(r.id as number))
      .filter((r) => !runs.some((o) => o.name === r.name && (o.id as number) > (r.id as number)))
      .map((r) => ({ ...r, id: (r.id as number) + 1000 }));
    return [...runs, ...again];
  }

  private red(sha: string): boolean {
    return gitOut(this.origin, ["cat-file", "-e", `${sha}:FAIL`]) !== undefined;
  }

  /** `git merge-tree` of `ours` and `theirs` as a commit with `parents`: undefined on a conflict. */
  private merged(ours: string, theirs: string, parents: string[], message: string): string | undefined {
    const tree = gitOut(this.origin, ["merge-tree", "--write-tree", ours, theirs]);
    if (tree === undefined) return undefined;
    return git(this.origin, ["commit-tree", tree.split("\n")[0]!, ...parents.flatMap((p) => ["-p", p]), "-m", message]);
  }

  /** `gh pr update-branch`: a rebase onto the base, or without `--rebase` the base merged into the branch. */
  private updateBranch(n: number, rebase: boolean): GhOut {
    const p = this.pulls.get(n);
    if (!p) return httpError(404, "Not Found");
    const head = this.headOf(p.branch)!;
    const onto = this.headOf(p.base)!;
    if (gitOut(this.origin, ["merge-base", "--is-ancestor", onto, head]) !== undefined) {
      return { exitCode: 0, stdout: "✓ PR branch already up-to-date\n", stderr: "" };
    }
    const updated = rebase ? this.merged(onto, head, [onto], `change ${p.branch}`) : this.merged(head, onto, [head, onto], `Merge branch '${p.base}' into ${p.branch}`);
    if (updated === undefined) return { exitCode: 1, stdout: "", stderr: "X Cannot update PR branch due to conflicts\n" };
    git(this.origin, ["update-ref", `refs/heads/${p.branch}`, updated]);
    // A rebase rewrites the PR's commits: a base that dismisses stale approvals drops them. A merge of the base doesn't.
    if (rebase && this.approvals?.dismissStale) p.approved = false;
    this.log.push(rebase ? `rebase #${n}` : `update #${n}`);
    return { exitCode: 0, stdout: "✓ PR branch updated\n", stderr: "" };
  }

  /**
   * GitHub's own answer on a PR's reviews: null where its base requires none, and while a conversation its base wants
   * resolved is open (as GitHub answered on the lab repo, 2026-11-11).
   */
  private reviewDecision(p: FakePull): string | null {
    if (!this.approvals || p.conversation) return null;
    return p.changesRequested ? "CHANGES_REQUESTED" : p.approved ? "APPROVED" : "REVIEW_REQUIRED";
  }

  private merge(n: number, p: FakePull, fields: Map<string, string>): GhOut {
    const sha = fields.get("sha") ?? "";
    const title = fields.get("commit_title");
    const body = fields.get("commit_message");
    const message = title !== undefined ? (body !== undefined ? `${title}\n\n${body}` : title) : `squash #${n}`;
    if (this.headOf(p.branch) !== sha) return httpError(409, "Head branch was modified. Review and try the merge again.");
    if (!this.statuses.some(([s, c, st]) => s === sha && c === "fleetd/train" && st === "success")) {
      return httpError(405, 'Required status check "fleetd/train" is expected.');
    }
    const method = fields.get("merge_method") ?? "merge";
    const allowed = this.methods.filter((m) => this.ruleMethods?.includes(m) ?? true);
    if (!allowed.includes(method)) {
      const named = method === "squash" ? "Squash merges" : method === "rebase" ? "Rebase merges" : "Merge commits";
      return httpError(405, `${named} are not allowed on this repository.`);
    }
    // GitHub's answers on the lab repo, 2026-11-11: a ruleset's refusal names the open conversation alone.
    if (p.conversation) return httpError(405, "Repository rule violations found\n\nA conversation must be resolved before this pull request can be merged.\n\n");
    const decision = this.reviewDecision(p);
    if (decision === "CHANGES_REQUESTED") return httpError(405, "Changes were requested by a reviewer with write access.");
    if (decision === "REVIEW_REQUIRED") return httpError(405, "Repository rule violations found\n\nAt least 1 approving review is required by reviewers with write access.\n\n");
    const main = this.headOf(p.base)!;
    if (git(this.origin, ["merge-base", main, sha]) !== main) return httpError(405, "Base branch was modified. Review and try the merge again.");
    let landed: string;
    if (method === "squash") landed = git(this.origin, ["commit-tree", `${sha}^{tree}`, "-p", main, "-m", message]);
    else if (method === "rebase") landed = sha;
    else landed = git(this.origin, ["commit-tree", `${sha}^{tree}`, "-p", main, "-p", sha, "-m", `${title ?? `Merge pull request #${n} from ${p.branch}`}\n\n${body ?? p.title}`]);
    git(this.origin, ["update-ref", `refs/heads/${p.base}`, landed]);
    p.merged = true;
    p.state = "closed";
    p.mergeSha = landed;
    p.mergedAt = new Date(this.now()).toISOString();
    this.log.push(method === "squash" ? `merge #${n}` : `merge #${n} by ${method}`);
    return ok({ sha: landed, merged: true, message: "Pull Request successfully merged" });
  }

  async run(args: string[]): Promise<GhOut> {
    this.calls.push(args);
    return this.answer(args);
  }

  answer(args: string[]): GhOut {
    if (args[0] === "pr" && args[1] === "update-branch") return this.updateBranch(Number(args[2]), args.includes("--rebase"));
    const fields = new Map<string, string>();
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-f" || args[i] === "-F") {
        const f = args[i + 1]!;
        const eq = f.indexOf("=");
        if (eq > 0) fields.set(f.slice(0, eq), f.slice(eq + 1));
      }
    }
    if (args.includes("graphql")) {
      const query = fields.get("query") ?? "";
      const refused = httpError(403, "Resource not accessible by personal access token");
      if (query.includes("branchProtectionRule")) {
        if (this.unreadable.includes("classic")) return refused;
        const a = this.approvals;
        const rule = a?.classic
          ? { requiresApprovingReviews: true, requiresCodeOwnerReviews: a.codeOwners === true, dismissesStaleReviews: a.dismissStale === true, requireLastPushApproval: false }
          : null;
        return ok({ data: { repository: { ref: { branchProtectionRule: rule } } } });
      }
      if (query.includes("reviewDecision")) {
        if (this.unreadable.includes("decision")) return refused;
        const p = this.pulls.get(Number(query.match(/pullRequest\(number: (\d+)\)/)?.[1]));
        return ok({ data: { repository: { pullRequest: p ? { reviewDecision: this.reviewDecision(p) } : null } } });
      }
      // The reverts' histories: none, so no PR undoes the base.
      return ok({ data: { repository: { object: {} } } });
    }
    const method = args[args.indexOf("-X") + 1] ?? "GET";
    const target = args.find((a) => a.startsWith("repos/")) ?? "";
    const diff = args.some((a) => a.includes("github.diff"));
    const [path, query = ""] = target.split("?") as [string, string?];
    const parts = path.split("/").slice(3);
    const asked = path.split("/").slice(1, 3).join("/");
    const inRepo = (p: FakePull) => p.repo.toLowerCase() === asked.toLowerCase();
    const q = (k: string) => query.split("&").find((kv) => kv.startsWith(`${k}=`))?.slice(k.length + 1);
    const [a, b, c] = parts;
    const pullsOf = (f: (p: FakePull) => boolean) =>
      ok([...this.pulls].filter(([, p]) => f(p) && inRepo(p)).sort(([x], [y]) => y - x).map(([n, p]) => this.pullJson(n, p)));
    if (parts.length === 0 && method === "GET") {
      if (this.unreadable.includes("methods")) return ok({ default_branch: "main" });
      const allows = (m: string) => this.methods.includes(m);
      return ok({ default_branch: "main", allow_squash_merge: allows("squash"), allow_rebase_merge: allows("rebase"), allow_merge_commit: allows("merge") });
    }
    if (a === "pulls" && parts.length === 1 && method === "GET") {
      const head = q("head")?.split(":")[1];
      const state = q("state") ?? "open";
      return pullsOf((p) => (state === "all" || p.state === state) && (head === undefined || p.branch === head));
    }
    if (a === "pulls" && parts.length === 1 && method === "POST") {
      const n = 100 + this.pulls.size;
      this.pulls.set(n, {
        repo: REPO,
        branch: fields.get("head") ?? "",
        base: fields.get("base") ?? "",
        title: fields.get("title") ?? "",
        body: fields.get("body") ?? "",
        state: "open",
        merged: false,
        labels: [],
        draft: args.some((x, i) => args[i - 1] === "-F" && x === "draft=true"),
        comments: [],
      });
      return ok({ number: n });
    }
    if (a === "pulls" && parts.length === 2 && method === "PATCH") {
      const p = this.pulls.get(Number(b));
      if (!p) return httpError(404, "Not Found");
      for (const [k, v] of fields) {
        if (k === "state") {
          p.state = v;
          this.log.push(`close #${b}`);
        } else if (k === "base") p.base = v;
        else if (k === "title") p.title = v;
        else if (k === "body") p.body = v;
      }
      return ok({});
    }
    if (a === "pulls" && parts.length === 2 && method === "GET") {
      const p = this.pulls.get(Number(b));
      return p ? ok(this.pullJson(Number(b), p)) : httpError(404, "Not Found");
    }
    if (a === "pulls" && c === "merge" && method === "PUT") {
      const scripted = this.mergeReplies.shift();
      if (scripted) {
        this.log.push(`refused #${b}`);
        return scripted;
      }
      const p = this.pulls.get(Number(b));
      return p ? this.merge(Number(b), p, fields) : httpError(404, "Not Found");
    }
    if (a === "pulls" && c === "commits") {
      const p = this.pulls.get(Number(b));
      if (!p) return httpError(404, "Not Found");
      if (q("page") !== "1") return ok([]);
      const log = git(this.origin, ["log", "--reverse", "--format=%B%x1e", `${p.base}..${p.branch}`]);
      return ok(
        log
          .split("\u001e")
          .map((m) => m.trim())
          .filter(Boolean)
          .map((message) => ({ commit: { message } })),
      );
    }
    if (a === "pulls" && c === "files") {
      const p = this.pulls.get(Number(b));
      if (!p) return httpError(404, "Not Found");
      if (q("page") !== "1") return ok([]);
      const files = git(this.origin, ["diff", "--name-status", "--no-renames", `refs/heads/${p.base}...refs/heads/${p.branch}`]);
      return ok(
        files
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [status, filename] = l.split("\t") as [string, string];
            return { filename, status: status === "A" ? "added" : "modified" };
          }),
      );
    }
    if (a === "issues" && c === "comments" && method === "POST") {
      const p = this.pulls.get(Number(b));
      if (!p) return httpError(404, "Not Found");
      p.comments.push(fields.get("body") ?? "");
      return ok({});
    }
    if (a === "issues" && parts.length === 1) {
      const label = q("labels");
      return ok([...this.pulls].filter(([, p]) => p.state === "open" && p.labels.includes(label ?? "")).map(([n]) => ({ number: n, pull_request: {} })));
    }
    if (a === "issues" && c === "labels" && method === "POST") {
      const p = this.pulls.get(Number(b));
      if (!p) return httpError(404, "Not Found");
      const label = fields.get("labels[]") ?? "";
      if (!p.labels.includes(label)) p.labels.push(label);
      this.log.push(`label #${b}`);
      return ok([{ name: label }]);
    }
    if (a === "issues" && c === "labels" && method === "DELETE") {
      const p = this.pulls.get(Number(b));
      const name = (parts[3] ?? "").replaceAll("%3A", ":");
      if (!p || !p.labels.includes(name)) return httpError(404, "Label does not exist");
      p.labels = p.labels.filter((l) => l !== name);
      this.log.push(`unlabel #${b}`);
      return ok([]);
    }
    if (a === "labels" && method === "POST") {
      const name = fields.get("name") ?? "";
      if (this.labels.includes(name)) return httpError(422, "Validation Failed");
      this.labels.push(name);
      return ok({});
    }
    if (a === "git" && b === "refs" && parts.length === 2 && method === "POST") {
      const name = fields.get("ref") ?? "";
      if (gitOut(this.origin, ["rev-parse", "--verify", name]) !== undefined) return httpError(422, "Reference already exists");
      git(this.origin, ["update-ref", name, fields.get("sha") ?? ""]);
      return ok({ ref: name });
    }
    if (a === "git" && b === "refs" && c === "heads" && method === "DELETE") {
      const branch = parts.slice(3).join("/");
      gitOut(this.origin, ["update-ref", "-d", `refs/heads/${branch}`]);
      // GitHub closes a PR whose head branch is deleted.
      for (const p of this.pulls.values()) if (p.branch === branch && p.state === "open") p.state = "closed";
      return ok(null);
    }
    if (a === "git" && b === "ref" && c === "heads") {
      const sha = this.headOf(parts.slice(3).join("/"));
      return sha ? ok({ object: { sha } }) : httpError(404, "Not Found");
    }
    if (a === "git" && b === "matching-refs") {
      const prefix = parts.slice(3).join("/");
      const refs = git(this.origin, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
      return ok(refs.split("\n").filter((r) => r.startsWith(`refs/heads/${prefix}`)).map((ref) => ({ ref })));
    }
    if (a === "merges" && method === "POST") {
      const branch = fields.get("base") ?? "";
      const head = fields.get("head") ?? "";
      const onto = this.headOf(branch);
      if (!onto) return httpError(404, "Base does not exist");
      if (gitOut(this.origin, ["merge-base", "--is-ancestor", head, onto]) !== undefined) return ok(null);
      const sha = this.merged(onto, head, [onto, head], fields.get("commit_message") ?? "merge");
      if (sha === undefined) return httpError(409, "Merge conflict");
      git(this.origin, ["update-ref", `refs/heads/${branch}`, sha]);
      return ok({ sha });
    }
    if (a === "compare" && diff) return { exitCode: 0, stdout: `${git(this.origin, ["diff", parts.slice(1).join("/")])}\n`, stderr: "" };
    if (a === "compare") {
      const [from, head] = parts.slice(1).join("/").split("...") as [string, string];
      const base = git(this.origin, ["merge-base", from, head]);
      const list = git(this.origin, ["rev-list", "--reverse", `${base}..${head}`])
        .split("\n")
        .filter(Boolean)
        .map((sha) => ({ sha, commit: { message: git(this.origin, ["log", "-1", "--format=%B", sha]) } }));
      const committed = (sha: string) => ({ sha: git(this.origin, ["rev-parse", sha]), commit: { committer: { date: git(this.origin, ["log", "-1", "--format=%cI", sha]) } } });
      return ok({ base_commit: committed(from), merge_base_commit: { ...committed(base), sha: base }, total_commits: list.length, commits: list, files: [] });
    }
    if (a === "commits" && c === "check-runs") {
      if (this.runs) {
        // GitHub names the commit each run is on, as main's CI read takes it.
        const head = this.headOf(b!) ?? b!;
        return ok({ check_runs: this.failingAgain(this.runs(b!) as Record<string, unknown>[]).map((r) => ({ head_sha: head, ...r })) });
      }
      if (this.noCi) return ok({ total_count: 0, check_runs: [] });
      const red = this.red(b!);
      return ok({
        check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: red ? "failure" : "success", html_url: `https://github.com/${REPO}/actions/runs/1` }],
      });
    }
    if (a === "commits" && c === "status") {
      const own = this.statuses.filter(([s]) => s === b).map(([, context, state]) => ({ context, state }));
      const theirs = (this.provider?.(b!) ?? []).map(([context, state]) => ({ context, state, target_url: `https://ci.example.invalid/${context}` }));
      return ok({ statuses: [...own, ...theirs] });
    }
    if (a === "commits" && parts.length === 2 && diff) return { exitCode: 0, stdout: `${git(this.origin, ["diff", `${b}^`, b!])}\n`, stderr: "" };
    if (a === "commits" && parts.length === 2) return ok({ files: [] });
    if (a === "statuses" && method === "POST") {
      this.statuses.push([b!, fields.get("context") ?? "", fields.get("state") ?? ""]);
      this.log.push(`status ${fields.get("context")} ${fields.get("state")} ${b}`);
      return ok({ state: fields.get("state") });
    }
    if (a === "actions" && b === "workflows") {
      return ok(
        this.noCi
          ? { total_count: 1, workflows: [{ name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", state: "active" }] }
          : { total_count: 1, workflows: [{ name: "CI", path: ".github/workflows/ci.yml", state: "active" }] },
      );
    }
    if (a === "actions" && b === "runs" && q("head_sha") !== undefined) {
      return ok({ workflow_runs: this.runEvents.map(([id, event]) => ({ id, event })) });
    }
    if (a === "actions" && b === "runs" && parts.length === 3) {
      const run = this.workflowRuns.get(Number(c));
      return run === undefined ? httpError(404, "Not Found") : ok(run);
    }
    if (a === "actions" && b === "runs" && parts[3] === "rerun" && method === "POST") {
      this.runReruns.push(Number(c));
      this.log.push(`rerun run ${c}`);
      return ok({});
    }
    if (a === "actions" && b === "runs") return ok({ workflow_runs: [] });
    if (a === "actions" && b === "jobs" && parts[3] === "rerun" && method === "POST") {
      this.reruns.push(Number(c));
      this.log.push(`rerun ${c}`);
      return ok({});
    }
    if (a === "branches") return ok({ name: "main", protected: false, protection: { enabled: false, required_status_checks: { contexts: [] } } });
    if (a === "rules") {
      const rules: unknown[] = [];
      if (this.required.length > 0) {
        rules.push({ type: "required_status_checks", ruleset_id: 1, parameters: { required_status_checks: this.required.map((context) => ({ context })) } });
      }
      const ap = this.approvals;
      if ((ap && !ap.classic) || this.ruleMethods) {
        const review = ap && !ap.classic;
        const parameters: Record<string, unknown> = {
          required_approving_review_count: review && !ap.codeOwners ? 1 : 0,
          dismiss_stale_reviews_on_push: review && ap.dismissStale === true,
          require_code_owner_review: review && ap.codeOwners === true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        };
        if (this.ruleMethods) parameters.allowed_merge_methods = this.ruleMethods;
        rules.push({ type: "pull_request", ruleset_id: 2, parameters });
      }
      return ok(rules);
    }
    if (a === "contents") {
      const at = q("ref") ?? "main";
      const file = parts.slice(1).join("/");
      const object = `${at.match(/^[0-9a-f]{40}$/) ? at : `refs/heads/${at}`}:${file}`;
      const kind = gitOut(this.origin, ["cat-file", "-t", object]);
      if (kind === "blob") return { exitCode: 0, stdout: git(this.origin, ["show", object]), stderr: "" };
      if (kind === "tree") {
        return ok(
          git(this.origin, ["ls-tree", "--name-only", object])
            .split("\n")
            .map((n) => ({ name: n, path: `${file}/${n}`, type: "file" })),
        );
      }
      return httpError(404, "Not Found");
    }
    return httpError(404, "Not Found");
  }
}

/** The tasks, workstreams, events and wakes around the train. */
export class FakeHost implements TrainHost {
  readonly tasks = new Map<string, TaskView>();
  readonly sends: [string, string][] = [];
  readonly events: EventView[] = [];
  readonly wakes: string[] = [];
  readonly orders: [string, string][] = [];
  readonly branches = new Map<string, string>();
  /** The commands the train ran on a node, each its argv. */
  readonly nodeRuns: string[][] = [];
  wsClosed = false;
  private listeners: (() => void)[] = [];

  eventsOf(type: string): any[] {
    return this.events.filter((e) => e.eventType === type).map((e) => e.data);
  }

  task(taskId: string) {
    return this.tasks.get(taskId);
  }
  writers(): [string, string][] {
    return [...this.branches].filter(([id]) => {
      const t = this.tasks.get(id);
      return t !== undefined && t.kind === "write" && ["running", "idle", "done"].includes(t.state);
    });
  }
  async messageTask(_r: ProjectRef, _by: string, taskId: string, text: string) {
    this.sends.push([taskId, text]);
  }
  async cancelTask(_r: ProjectRef, _by: string, taskId: string, reason: string) {
    const t = this.tasks.get(taskId);
    if (t) {
      t.state = "cancelled";
      t.resultTail = reason;
    }
  }
  readonly spawns: ReviewSpawn[] = [];
  async spawnReview(spawn: ReviewSpawn): Promise<TaskView> {
    const task: TaskView = { taskId: `T${50 + this.spawns.length}`, projectRef: spawn.projectRef, workstreamId: spawn.workstreamId, kind: "review", state: "running", prUrl: spawn.pr };
    this.spawns.push(spawn);
    this.tasks.set(task.taskId, task);
    return task;
  }
  workstream(id: string): WorkstreamView | undefined {
    const n = Number(id.slice(1));
    if (n >= 100 && n - 100 < this.orders.length) return { workstreamId: id, projectRef: PROJECT, hasBrief: true, open: true };
    return id === WS ? { workstreamId: WS, projectRef: PROJECT, hasBrief: true, open: !this.wsClosed } : undefined;
  }
  appendEvent(_r: ProjectRef, eventType: string, _summary: string, data: unknown) {
    this.events.push({ seq: this.events.length + 1, eventType, data });
    const ls = this.listeners;
    this.listeners = [];
    for (const l of ls) l();
  }
  eventsHead() {
    return this.events.length;
  }
  async eventsWait(cursor: number, types: string[], _timeoutSec: number, signal?: AbortSignal) {
    for (;;) {
      if (this.events.length > cursor || signal?.aborted) {
        return { events: this.events.filter((e) => e.seq > cursor && types.includes(e.eventType)), cursor: this.events.length };
      }
      await new Promise<void>((resolve) => {
        this.listeners.push(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  projectRoot(r: ProjectRef) {
    return r.projectId === "removed" ? undefined : "/srv/storefront";
  }
  githubRepos(): [string, ProjectRef][] {
    return [];
  }
  repoProjects(): ProjectRef[] {
    return [];
  }
  sees() {
    return true;
  }
  async nodeRun(_checkout: ProjectRef, _cwd: string, argv: string[]): Promise<NodeRun> {
    this.nodeRuns.push(argv);
    throw new Error("no checkout");
  }
  async wakeLead(_r: ProjectRef, line: string) {
    this.wakes.push(line);
  }
  async branchPrefix() {
    return "fleetd/";
  }
  async openOrder(_r: ProjectRef, text: string, requestId: string) {
    let n = this.orders.findIndex(([r]) => r === requestId);
    if (n < 0) {
      this.orders.push([requestId, text]);
      n = this.orders.length - 1;
    }
    return `W${100 + n}`;
  }
  landingsWatched() {
    return false;
  }
  time(): TimeSink | undefined {
    return undefined;
  }
}

/** A gate that approves each Change's patch at once, as task T9's clean review. */
export class CleanGate implements ReviewGate {
  reviewed: string[] = [];
  blocking = new Set<string>();
  async review(change: Change): Promise<Verdict> {
    this.reviewed.push(change.changeId);
    if (this.blocking.has(change.changeId)) return { kind: "blocked" };
    return change.patchId === undefined
      ? { kind: "pending" }
      : { kind: "ready", reviews: [{ taskId: "T9", prHeadSha: change.headSha, patchId: change.patchId, blocking: 0, nonBlocking: 0 }] };
  }
  again(change: Change) {
    return this.review(change);
  }
  rereview() {
    return false;
  }
  async resolved() {
    return false;
  }
}

class ManualClock {
  constructor(public ms: number) {}
  now() {
    return this.ms;
  }
}

/** An origin with `main`, the author's clone, the fakes and a train that steps only when the test says. */
export class Kit {
  readonly dir: string;
  readonly origin: string;
  readonly clone: string;
  readonly gh: FakeGh;
  readonly host = new FakeHost();
  readonly gate = new CleanGate();
  readonly clock = new ManualClock(Date.parse("2026-10-17T10:00:00Z"));
  readonly db = HubDb.memory();
  readonly train: Train;
  private readonly options: Partial<TrainOptions>;

  constructor(options: Partial<TrainOptions> = {}) {
    this.dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bun-train-"));
    this.origin = join(this.dir, "origin.git");
    this.clone = join(this.dir, "clone");
    git(this.dir, ["init", "-q", "--bare", "-b", "main", this.origin]);
    git(this.dir, ["clone", "-q", this.origin, this.clone]);
    writeFileSync(join(this.clone, "README.md"), "storefront\n");
    git(this.clone, ["add", "-A"]);
    git(this.clone, ["commit", "-q", "-m", "init"]);
    git(this.clone, ["push", "-q", "origin", "HEAD:main"]);
    const clock = this.clock;
    this.gh = new FakeGh(this.origin, () => clock.ms);
    this.options = {
      autoRun: false,
      pollIntervalMs: 1000,
      // Each wait moves the clock, so CI timeouts come without sleeping.
      sleep: async (ms) => {
        clock.ms += ms;
        await Bun.sleep(0);
      },
      ...options,
    };
    this.train = this.newTrain();
  }

  private newTrain(): Train {
    const train = new Train(this.host, this.clock, this.db, this.gh, this.options);
    train.gate = this.gate;
    this.trains.push(train);
    return train;
  }

  private readonly trains: Train[] = [];

  /** A new train on this kit's database, GitHub and host, as after a hub restart; the old ones stopped. */
  restarted(): Train {
    for (const t of this.trains) t.stop();
    return this.newTrain();
  }

  /** Commits `files` (path → text) onto main, as a push to it. */
  commitMain(files: Record<string, string>): void {
    git(this.clone, ["fetch", "-q", "origin"]);
    git(this.clone, ["checkout", "-q", "-B", "main", "origin/main"]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(this.clone, path, ".."), { recursive: true });
      writeFileSync(join(this.clone, path), text);
    }
    git(this.clone, ["add", "-A"]);
    git(this.clone, ["commit", "-q", "-m", `main: ${Object.keys(files).join(", ")}`]);
    git(this.clone, ["push", "-q", "origin", "main:main"]);
  }

  /** The repo's `.fleetd/train.json` on main: its fast checks and the ones left for after the merge. */
  trainFile(fast: string[], afterMerge: string[] = []): void {
    this.commitMain({ ".fleetd/train.json": JSON.stringify({ fastChecks: fast, afterMerge }) });
    for (const t of this.trains) t.repoChecks.clear();
  }

  done(): void {
    for (const t of this.trains) t.stop();
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** A write task, and its PR #`n` from `branch` with `files` (path → text) committed on main's head. */
  pr(n: number, branch: string, files: Record<string, string>, extra: Partial<FakePull> = {}): string {
    git(this.clone, ["fetch", "-q", "origin"]);
    git(this.clone, ["checkout", "-q", "-B", branch, "origin/main"]);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(this.clone, path, ".."), { recursive: true });
      writeFileSync(join(this.clone, path), text);
    }
    git(this.clone, ["add", "-A"]);
    git(this.clone, ["commit", "-q", "-m", `change ${branch}`]);
    git(this.clone, ["push", "-q", "-f", "origin", `${branch}:${branch}`]);
    this.gh.pulls.set(n, { repo: REPO, branch, base: "main", title: `PR ${n}`, body: "", state: "open", merged: false, labels: [], draft: false, comments: [], ...extra });
    const taskId = `T${n}`;
    this.host.tasks.set(taskId, { taskId, projectRef: PROJECT, workstreamId: WS, kind: "write", state: "done", prUrl: `https://github.com/${REPO}/pull/${n}` });
    return `https://github.com/${REPO}/pull/${n}`;
  }

  /** Enqueues PR `n` as its task's. */
  enqueue(n: number): Promise<Change> {
    return this.train.enqueue(PROJECT, { taskId: `T${n}`, prUrl: `https://github.com/${REPO}/pull/${n}` });
  }

  /** Steps the repo's train until it takes nothing more, at most `max` passes. */
  async settle(max = 10): Promise<void> {
    for (let i = 0; i < max; i++) {
      this.clock.ms += 61_000;
      if (!(await this.train.step(REPO))) return;
    }
  }

  change(n: number): Change {
    return this.train.records.latestFor(REPO, n)!;
  }

  /** A person approves PR `n` on GitHub. */
  approve(n: number): void {
    this.gh.pulls.get(n)!.approved = true;
  }

  mainLog(): string[] {
    return git(this.origin, ["log", "--format=%s", "main"]).split("\n");
  }
}
