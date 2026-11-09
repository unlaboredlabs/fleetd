// The PR views: GitHub's answers joined with the merge queue and the agents,
// rolled up checks and reviews, a patch as numbered lines, GitHub read once per burst with a failed read remembered
// rather than retried, and the four tools through the registry against a fake `gh`.
import { afterAll, expect, test } from "bun:test";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry, type Caller } from "../src/hub/api/registry.ts";
import { explain, type GhCheck, type GhPull, type GhReview, PrsGitHub, READS_AT_ONCE } from "../src/hub/prs/github.ts";
import { personReview } from "../src/hub/prs/index.ts";
import * as join from "../src/hub/prs/join.ts";
import { listPage, PR_LIST_MAX } from "../src/hub/prs/tools.ts";
import { HubDb } from "../src/hub/store/db.ts";
import type { GhOut, GhRunner } from "../src/hub/train/gh.ts";
import { ChangeRecords } from "../src/hub/train/records.ts";
import type { Change, PrRow, Task } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";

const AT = "2026-10-22T10:00:00.000Z";
const SHA = "b".repeat(40);

class ManualClock {
  constructor(public ms: number) {}
  now() {
    return this.ms;
  }
}

const task = (id: string, branch: string): Task =>
  ({
    taskId: id,
    projectRef: { machineId: "devbox", projectId: "web" },
    workstreamId: "W3",
    title: "Add the pricing page",
    kind: "write",
    prompt: "do it",
    profile: "high",
    state: "done",
    attempt: 1,
    createdAt: AT,
    branch,
    threadRef: { machineId: "devbox", threadId: `s-${id}` },
  }) as unknown as Task;

const change = (n: number, number: number, state: string, reviews: unknown[]): Change =>
  ({
    changeId: `X${n}`,
    projectRef: { machineId: "devbox", projectId: "web" },
    repo: "acme/web",
    prNumber: number,
    prUrl: `https://github.com/acme/web/pull/${number}`,
    branch: "fleetd/T4-pricing",
    taskId: "T4",
    workstreamId: "W3",
    headSha: SHA,
    patchId: "c".repeat(40),
    state,
    reviews,
    position: 0,
    lastError: "conflict in src/app.ts; token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    createdAt: AT,
    updatedAt: AT,
  }) as Change;

const review = (taskId: string, patch: string, blocking: number) => ({ taskId, prHeadSha: SHA, patchId: patch, blocking, nonBlocking: 1 });

function pull(number: number, state: string, extra: Partial<GhPull> = {}): GhPull {
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    author: { login: "octo" },
    headRefName: `feature-${number}`,
    headRefOid: SHA,
    createdAt: "2026-10-20T09:00:00Z",
    updatedAt: "2026-10-21T09:00:00Z",
    reviewDecision: "",
    statusCheckRollup: [],
    ...extra,
  };
}

test("checks roll up failing over pending over passing, without fleetd's own", () => {
  const rollup: GhCheck[] = [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SKIPPED" },
    { __typename: "CheckRun", name: "build", status: "IN_PROGRESS" },
    { __typename: "StatusContext", context: "fleetd/train", state: "PENDING" },
    { __typename: "StatusContext", context: "deploy/preview", state: "SUCCESS" },
  ];
  const summary = join.checksSummary(rollup);
  expect(summary).toEqual({ state: "pending", passed: 3, failed: 0, pending: 1 });
  const failing = [...rollup, { __typename: "CheckRun", name: "e2e", status: "COMPLETED", conclusion: "TIMED_OUT" }];
  expect(join.checksSummary(failing).state).toBe("failing");
  expect(join.checksSummary([]).state).toBe("none");
  expect(rollup.map(join.check).filter(Boolean).map((c) => c!.name)).toEqual(["test", "lint", "build", "deploy/preview"]);
});

test("reviews count only verdicts on the current change", () => {
  const patch = "c".repeat(40);
  const clean = change(1, 7, "reviewing", [review("T5", patch, 0), review("T6", "d".repeat(40), 2)]);
  expect(join.reviewSummary(clean, 1, "")).toEqual({ state: "approved", done: 1, needed: 1 });
  const blocked = change(1, 7, "reviewing", [review("T5", patch, 0), review("T6", patch, 1)]);
  expect(join.reviewSummary(blocked, 1, "").state).toBe("changes_requested");
  expect(join.reviewSummary(undefined, 0, "APPROVED")).toEqual({ state: "approved", done: 0, needed: 0 });
  expect(join.isCurrent(clean, "T6", SHA)).toBe(false);
  expect(join.isCurrent(clean, "T9", SHA)).toBe(true);
});

test("the list joins GitHub with the queue and names the writing agent", () => {
  const ctx = join.rowCtx([task("T4", "fleetd/T4-pricing"), task("T8", "feature-9")]);
  ctx.queues.set("acme/web", 3);
  const pulls: [string, GhPull][] = [
    ["acme/web", pull(7, "OPEN", { headRefName: "fleetd/T4-pricing", updatedAt: "2026-10-22T08:00:00Z" })],
    ["acme/web", pull(9, "OPEN", { isDraft: true, reviewDecision: "REVIEW_REQUIRED" })],
    ["acme/web", pull(11, "OPEN", { updatedAt: "2026-10-22T09:00:00Z" })],
    ["acme/web", pull(3, "MERGED", { mergedAt: "2026-10-21T12:00:00Z", updatedAt: "2026-10-21T12:00:00Z" })],
    ["acme/web", pull(2, "CLOSED", { closedAt: "2026-09-01T12:00:00Z", updatedAt: "2026-09-01T12:00:00Z" })],
  ];
  const changes = [change(1, 7, "needs_rebase", []), change(2, 5, "queued", [])];
  const { rows, truncated } = join.rows(pulls, changes, "2026-10-15T00:00:00.000Z", ctx, 60);
  expect(truncated).toBe(false);
  expect(rows.map((r) => r.number)).toEqual([5, 11, 7, 9, 3]);
  const seven = rows[2]!;
  expect(seven.state).toBe("open");
  expect(seven.author.taskId).toBe("T4");
  expect(seven.author.login).toBe("octo");
  expect([seven.queue!.state, seven.queue!.length]).toEqual(["needs_rebase", 3]);
  expect(seven.queue!.reason).toStartWith("conflict in src/app.ts");
  expect(seven.queue!.reason).not.toContain("ghp_");
  expect(seven.review.needed).toBe(1);
  const five = rows[0]!;
  expect(five.checks).toBeUndefined();
  expect(five.title).toBe("Add the pricing page");
  expect(five.queue!.reason).toBeUndefined();
  const nine = rows[3]!;
  expect(nine.state).toBe("draft");
  expect(nine.author.taskId).toBe("T8");
  expect(nine.review.state).toBe("pending");
  expect(nine.queue).toBeUndefined();
  expect(rows[4]!.state).toBe("merged");
  expect(rows[4]!.mergedAt).toBe("2026-10-21T12:00:00.000Z");
});

test("a patch reads as numbered lines without secrets", () => {
  const patch =
    '@@ -10,4 +10,5 @@ fn main() {\n let a = 1;\n-let b = 2;\n+let b = 3;\n+let key = "sk-ant-api03-abcdefghijklmnop";\n let c = 4;\n\\ No newline at end of file';
  const lines = join.diffLines(patch);
  expect(lines.map((l) => l.kind)).toEqual(["hunk", "context", "del", "add", "add", "context"]);
  expect(lines[0]!.text).toBe("fn main() {");
  expect(lines.map((l) => [l.old, l.new])).toEqual([
    [10, 10],
    [10, 10],
    [11, undefined],
    [undefined, 11],
    [undefined, 12],
    [12, 13],
  ]);
  expect(lines[4]!.text).toBe('let key = "[secret]";');
  const cut = join.diffLines(`@@ -1 +1 @@\n+${"x".repeat(1000)}`)[1]!;
  expect([cut.text.length, cut.cut]).toEqual([400, true]);
  const shown = join.file({ filename: "logo.png", status: "added", additions: 0, deletions: 0 })!;
  expect([shown.status, shown.diffLines]).toEqual(["added", undefined]);
});

test("a person's pending review is left out and secrets are never shown", () => {
  const r = (state: string): GhReview => ({
    author: { login: "dana" },
    state,
    body: "LGTM, but rotate AKIAABCDEFGHIJKLMNOP",
    submittedAt: "2026-10-22T09:00:00Z",
    commit: { oid: SHA },
  });
  expect(personReview(r("PENDING"), SHA)).toBeUndefined();
  const shown = personReview(r("CHANGES_REQUESTED"), SHA)!;
  expect(shown.verdict).toBe("changes_requested");
  expect(shown.current).toBe(true);
  expect(shown.text).toBe("LGTM, but rotate [secret]");
  expect(personReview(r("APPROVED"), "other")!.current).toBe(false);
});

/** Answers every `gh` run with the next canned reply and keeps the runs. */
class Canned implements GhRunner {
  runs: string[][] = [];
  constructor(private readonly replies: [number, string, string][]) {}
  async run(args: string[]): Promise<GhOut> {
    this.runs.push(args);
    const [exitCode, stdout, stderr] = this.replies.shift() ?? [1, "", "no more canned replies"];
    return { exitCode, stdout, stderr };
  }
}

const gqlPage = (pulls: unknown[], next?: string) =>
  JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes: pulls } } } });

function gqlPull(number: number, state: string, minutes: number): Record<string, unknown> {
  const at = `2026-10-22T${String(10 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`;
  return {
    number,
    title: `PR ${number}`,
    state,
    isDraft: false,
    author: { login: "octo" },
    headRefName: `f-${number}`,
    headRefOid: SHA,
    createdAt: AT,
    updatedAt: at,
    closedAt: state !== "OPEN" ? at : null,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
  };
}

test("a burst of reads asks GitHub once per minute", async () => {
  const list = gqlPage([gqlPull(4, "OPEN", 0)]);
  const gh = new Canned([
    [0, list, ""],
    [0, list, ""],
  ]);
  const clock = new ManualClock(1_792_000_000_000);
  const github = new PrsGitHub(gh, clock);
  const reads = await Promise.all(Array.from({ length: 5 }, () => github.page("acme/web", false)));
  for (const read of reads) {
    expect(read.value!.pulls[0]!.title).toBe("PR 4");
    expect(read.value!.pulls[0]!.statusCheckRollup[0]!.name).toBe("ci");
    expect(read.value!.next).toBeUndefined();
    expect(read.error).toBeUndefined();
  }
  expect(gh.runs.length).toBe(1);
  const argv = gh.runs[0]!.join(" ");
  expect(argv).toStartWith("api graphql -f query=");
  expect(argv).toContain("states: [OPEN]");
  expect(argv).toContain("-f owner=acme -f name=web");
  clock.ms += 61_000;
  await github.page("acme/web", false);
  expect(gh.runs.length).toBe(2);
});

test("reads of different PRs run side by side, READS_AT_ONCE at most; a burst for one PR shares its read", async () => {
  let running = 0;
  let most = 0;
  const gh: GhRunner & { runs: number } = {
    runs: 0,
    async run(args: string[]): Promise<GhOut> {
      gh.runs += 1;
      running += 1;
      most = Math.max(most, running);
      await Bun.sleep(20);
      running -= 1;
      const number = Number(args[2]);
      return { exitCode: 0, stdout: JSON.stringify({ number, title: `PR ${number}`, state: "OPEN", headRefName: "f", headRefOid: SHA, createdAt: AT, updatedAt: AT }), stderr: "" };
    },
  };
  const github = new PrsGitHub(gh, new ManualClock(1_792_000_000_000));
  const reads = await Promise.all([...Array.from({ length: 10 }, (_, i) => github.detail("acme/web", i + 1)), github.detail("acme/web", 1)]);
  expect(reads.map((r) => r.value?.pull.title)).toEqual([...Array.from({ length: 10 }, (_, i) => `PR ${i + 1}`), "PR 1"]);
  expect([gh.runs, most]).toEqual([10, READS_AT_ONCE]);
});

test("only open pages ask GitHub for checks", async () => {
  const merged = gqlPull(3, "MERGED", 0);
  delete merged.commits;
  const gh = new Canned([
    [0, gqlPage([gqlPull(4, "OPEN", 0)]), ""],
    [0, gqlPage([merged]), ""],
  ]);
  const github = new PrsGitHub(gh, new ManualClock(1_792_000_000_000));
  await github.page("acme/web", false);
  const page = (await github.page("acme/web", true)).value!;
  expect(page.pulls[0]!.title).toBe("PR 3");
  expect(page.pulls[0]!.statusCheckRollup).toEqual([]);
  expect(gh.runs[0]!.join(" ")).toContain("statusCheckRollup");
  expect(gh.runs[1]!.join(" ")).not.toContain("statusCheckRollup");
  expect(gh.runs[1]!.join(" ")).not.toContain("CHECKS");
});

test("a failed read keeps the last answer and waits a minute to ask again", async () => {
  const detail = JSON.stringify({ number: 4, title: "Fix login", state: "OPEN", headRefName: "fix", headRefOid: SHA, createdAt: AT, updatedAt: AT, body: "Fixes the login.", changedFiles: 1 });
  const gh = new Canned([
    [0, detail, ""],
    [1, "", "gh: API rate limit exceeded for user ID 1 (HTTP 403)"],
    [0, detail, ""],
  ]);
  const clock = new ManualClock(1_792_000_000_000);
  const github = new PrsGitHub(gh, clock);
  expect((await github.detail("acme/web", 4)).error).toBeUndefined();
  clock.ms += 31_000;
  const limited = await github.detail("acme/web", 4);
  expect(limited.value!.body).toBe("Fixes the login.");
  expect(limited.error).toContain("rate limit");
  clock.ms += 30_000;
  expect((await github.detail("acme/web", 4)).error).toBeDefined();
  expect(gh.runs.length).toBe(2);
  clock.ms += 31_000;
  expect((await github.detail("acme/web", 4)).error).toBeUndefined();
  expect(gh.runs.length).toBe(3);
});

test("gh failures read as what to do", () => {
  expect(explain(4, "")).toContain("gh auth login");
  expect(explain(1, "To get started with GitHub CLI, please run:  gh auth login")).toContain("signed in");
  expect(explain(1, "gh: Could not resolve to a PullRequest with the number of 9.")).toContain("doesn't know");
  expect(explain(1, "gh: something broke")).toBe("GitHub couldn't be read: something broke");
});

test("the list loads older PRs past the first page", async () => {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const open1 = gqlPage(range(1, 50).map((n) => gqlPull(200 - n, "OPEN", 200 - n)), "open-2");
  const closed1 = gqlPage(range(1, 30).map((n) => gqlPull(100 - n, "MERGED", 100 - n)));
  const open2 = gqlPage(range(51, 70).map((n) => gqlPull(200 - n, "OPEN", 200 - n)));
  const gh = new Canned([
    [0, open1, ""],
    [0, closed1, ""],
    [0, open2, ""],
  ]);
  const github = new PrsGitHub(gh, new ManualClock(1_792_000_000_000));
  const ctx = join.rowCtx([]);
  const numbers = (rows: PrRow[]) => rows.map((r) => r.number);
  const first = await listPage(github, ["acme/web"], [], "", ctx, undefined);
  expect(first.error).toBeUndefined();
  expect(numbers(first.rows)).toEqual(range(150, 199).reverse());
  expect(first.more).toBe(true);
  expect(gh.runs.length).toBe(2);
  const key = join.keyOfCursor(join.cursorOf(join.rowKey(first.rows.at(-1)!)))!;
  const second = await listPage(github, ["acme/web"], [], "", ctx, key);
  expect(gh.runs.length).toBe(3);
  expect(gh.runs[2]!.join(" ")).toEndWith("-f after=open-2");
  expect(second.more).toBe(false);
  expect(numbers(second.rows)).toEqual([...range(130, 149).reverse(), ...range(70, 99).reverse()]);
  expect(second.rows.length).toBeLessThanOrEqual(PR_LIST_MAX);
  expect(join.keyOfCursor("not a cursor")).toBeUndefined();
});

// --- the tools, through the registry ---

const home = tempHome();
afterAll(home.done);

/** A fake GitHub behind `gh`: PR 7's detail, its two files' pages, the list pages. */
class FakeGh implements GhRunner {
  runs: string[][] = [];
  async run(args: string[]): Promise<GhOut> {
    this.runs.push(args);
    const ok = (v: unknown): GhOut => ({ exitCode: 0, stdout: JSON.stringify(v), stderr: "" });
    if (args[0] === "pr" && args[1] === "view") {
      if (args[2] !== "7") return { exitCode: 1, stdout: "", stderr: "gh: Could not resolve to a PullRequest with the number of 8." };
      return ok({
        number: 7,
        title: "Add pricing",
        state: "OPEN",
        isDraft: false,
        author: { login: "octo" },
        headRefName: "fleetd/T4-pricing",
        headRefOid: SHA,
        createdAt: AT,
        updatedAt: AT,
        body: "Adds it. GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        baseRefName: "main",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://ci/1" }],
        reviews: [{ author: { login: "dana" }, state: "COMMENTED", body: "nice", submittedAt: "2026-10-22T11:00:00Z", commit: { oid: SHA } }],
      });
    }
    if (args[0] === "api" && args[1]?.includes("/pulls/7/files")) {
      return ok([
        { filename: "src/pricing.ts", status: "added", additions: 10, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;" },
        { filename: "logo.png", status: "modified", additions: 0, deletions: 0 },
      ]);
    }
    if (args[0] === "api" && args[1] === "graphql") return ok({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    return { exitCode: 1, stdout: "", stderr: `gh: unexpected ${args.join(" ")}` };
  }
}

function toolLab() {
  const clock = new ManualClock(Date.parse("2026-10-22T12:00:00Z"));
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), clock);
  const tools = new Registry();
  registerAll(tools);
  const gh = new FakeGh();
  hub.area("prs", (h) => new PrsGitHub(gh, h.clock));
  hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'web', 'web', ?, ?)")
    .run(AT, JSON.stringify({ machineId: "devbox", projectId: "web", title: "web", workspaceRoot: "/w" }));
  hub.db.conn.query("INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'web', 'W3', 'done', ?)").run(JSON.stringify(task("T1", "x")));
  for (let i = 2; i <= 4; i++) {
    hub.db.conn.query("INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'web', 'W3', 'done', ?)").run(JSON.stringify(task(`T${i}`, `b${i}`)));
  }
  const records = new ChangeRecords(hub.db);
  records.ensureTrain("acme/web", { machineId: "devbox", projectId: "web" }, clock.ms);
  const made = records.create({ ...change(0, 7, "reviewing", []), patchId: undefined } as unknown as Change);
  return { hub, tools, gh, records, made };
}

const reader: Caller = { keyId: "k", name: "reader", prefix: "fld_cccccc", grants: [{ role: "read", machines: "*" }], createdAt: AT };

async function call(l: ReturnType<typeof toolLab>, tool: string, input: unknown): Promise<any> {
  const out = await l.tools.call(l.hub, reader, tool, input);
  if ("error" in out) throw new Error(JSON.stringify(out.error.kind === "tool" ? out.error.error.toJSON() : out.error));
  return out.output;
}

test("pr_get joins GitHub's detail, the reviewer's verdict and the queue, with secrets out", async () => {
  const l = toolLab();
  l.hub.db.conn
    .query("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES ('T2', 'github.com/acme/web/pull/7', ?, 0, ?, ?)")
    .run(SHA, Date.parse("2026-10-22T10:30:00Z"), JSON.stringify({ taskId: "T2", prHeadSha: SHA, blocking: 0, nonBlocking: 1, summary: "fine" }));
  const out = await call(l, "pr_get", { repo: "acme/web", number: 7 });
  expect(out.pr.queue.changeId).toBe(l.made.changeId);
  expect(out.pr.author.taskId).toBe("T4");
  expect(out.body).toBe("Adds it. GH_TOKEN=[secret]");
  expect([out.baseBranch, out.headSha, out.additions, out.deletions, out.changedFiles]).toEqual(["main", SHA, 12, 3, 2]);
  expect(out.checks).toEqual([{ name: "ci", state: "passing", conclusion: "success", url: "https://ci/1" }]);
  expect(out.reviews.map((r: any) => [r.verdict, r.login ?? r.agent?.taskId, r.current])).toEqual([
    ["commented", "dana", true],
    ["approved", "T2", true],
  ]);
  expect(out.links).toEqual({ files: "https://github.com/acme/web/pull/7/files", checks: "https://github.com/acme/web/pull/7/checks", pr: "https://github.com/acme/web/pull/7" });
  const missing = await l.tools.call(l.hub, reader, "pr_get", { repo: "acme/web", number: 8 });
  expect("error" in missing && missing.error.kind === "tool" && missing.error.error.code).toBe("not_found");
  const nobody = await l.tools.call(l.hub, reader, "pr_get", { repo: "other/repo", number: 1 });
  expect("error" in nobody && nobody.error.kind === "tool" && nobody.error.error.message).toBe("No project of this fleet lands PRs on other/repo.");
});

test("pr_files pages a PR's files and pr_diff one file's lines", async () => {
  const l = toolLab();
  const files = await call(l, "pr_files", { repo: "acme/web", number: 7 });
  expect(files.total).toBe(2);
  expect(files.nextOffset).toBeUndefined();
  expect(files.files.map((f: any) => [f.path, f.status, f.diffLines])).toEqual([
    ["src/pricing.ts", "added", 3],
    ["logo.png", "modified", undefined],
  ]);
  const diff = await call(l, "pr_diff", { repo: "acme/web", number: 7, path: "src/pricing.ts", limit: 2 });
  expect(diff.lines.map((d: any) => d.kind)).toEqual(["hunk", "add"]);
  expect([diff.total, diff.nextOffset]).toEqual([3, 2]);
  const rest = await call(l, "pr_diff", { repo: "acme/web", number: 7, path: "src/pricing.ts", offset: 2 });
  expect([rest.lines.length, rest.nextOffset]).toEqual([1, undefined]);
  expect((await call(l, "pr_diff", { repo: "acme/web", number: 7, path: "logo.png" })).noDiff).toBe(true);
  const none = await l.tools.call(l.hub, reader, "pr_diff", { repo: "acme/web", number: 7, path: "nope.ts" });
  expect("error" in none && none.error.kind === "tool" && none.error.error.code).toBe("not_found");
  // The detail and each files page were read once for all of these.
  expect(l.gh.runs.filter((r) => r[0] === "pr").length).toBe(1);
  expect(l.gh.runs.filter((r) => r[1]?.includes("/files")).length).toBe(1);
});

test("pr_list shows the queue's Changes when GitHub's lists don't carry them, and refuses an unknown project", async () => {
  const l = toolLab();
  const out = await call(l, "pr_list", { projectRef: { machineId: "devbox", projectId: "web" } });
  expect(out.prs.map((r: any) => [r.number, r.queue?.changeId])).toEqual([[7, l.made.changeId]]);
  expect(out.nextCursor).toBeUndefined();
  const bad = await l.tools.call(l.hub, reader, "pr_list", { projectRef: { machineId: "devbox", projectId: "web" }, cursor: "nope" });
  expect("error" in bad && bad.error.kind === "tool" && bad.error.error.code).toBe("invalid");
  const gone = await l.tools.call(l.hub, reader, "pr_list", { projectRef: { machineId: "devbox", projectId: "nope" } });
  expect("error" in gone && gone.error.kind === "tool" && gone.error.error.message).toBe("No project nope on devbox.");
});
