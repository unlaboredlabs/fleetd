// The merge train end to end over a fake GitHub backed by a real bare git origin (train_kit.ts), as
// crates/fleetd/src/hub/train/tests.rs drives the Rust one: enqueue, review, rebase, CI, the `fleetd/train` status and
// the pinned squash merge; red CI and conflicts back to their writers; batches; refusals; merges outside the train.
import { afterEach, expect, test } from "bun:test";
import { httpError, Kit, PROJECT, REPO } from "./train_kit.ts";
import { awaitsChecks, checks } from "../src/hub/train/rules.ts";
import { batchSkipped, gatedName, jobChecks, labelGated, unprovenBatchSkips } from "../src/hub/train/next.ts";
import { ownChecks, withTrailers } from "../src/hub/train/batch.ts";
import { failedTest } from "../src/hub/train/flaky.ts";
import { batchHeads, squashText } from "../src/hub/train/github.ts";
import { earlyMigrations, parseRegenerate } from "../src/hub/train/regen.ts";
import { counted, deliberate, undone } from "../src/hub/train/reverts.ts";
import { parse as parseRepoChecks } from "../src/hub/train/repo_checks.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
const kit = (...a: ConstructorParameters<typeof Kit>) => {
  const k = new Kit(...a);
  kits.push(k);
  return k;
};

test("one PR: reviewed, rebased, CI green, fleetd/train posted, squash-merged pinned to its head", async () => {
  const k = kit();
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  const queued = await k.enqueue(7);
  expect(queued.state).toBe("ready");
  expect(queued.patchId).toMatch(/^[0-9a-f]{40}$/);
  await k.settle();
  const merged = k.change(7);
  expect(merged.state).toBe("merged");
  expect(merged.mergedSha).toBe(k.gh.headOf("main"));
  expect(k.gh.log.filter((l) => !l.startsWith("label") && !l.startsWith("unlabel"))).toEqual([`status fleetd/train success ${queued.headSha}`, "merge #7"]);
  const subject = k.mainLog()[0]!;
  expect(subject).toBe("change fleetd/T7-pricing (#7)");
  const body = Bun.spawnSync(["git", "log", "-1", "--format=%B", "main"], { cwd: k.origin }).stdout.toString();
  expect(body).toContain("Fleetd-Change: X1 (T7, W1)");
  expect(k.host.eventsOf("pr.merged")).toMatchObject([{ changeId: "X1", prNumber: 7, mergedSha: merged.mergedSha, taskId: "T7" }]);
  expect(k.host.eventsOf("change.state").map((e) => `${e.from}→${e.to}`)).toEqual(["queued→reviewing", "reviewing→ready", "ready→rebasing", "rebasing→ci", "ci→merging", "merging→merged"]);
  expect(k.host.wakes.at(-1)).toStartWith("- PR #7 merged as ");
});

test("red CI goes back to its writer with the pr.fix prompt, and a push of a fix merges", async () => {
  const k = kit();
  k.pr(8, "fleetd/T8-broken", { FAIL: "x\n" });
  await k.enqueue(8);
  await k.settle();
  const failed = k.change(8);
  expect(failed.state).toBe("ci_failed");
  expect(failed.lastError).toStartWith(`CI failed on ${failed.headSha.slice(0, 12)}: ci (failure) (log: https://github.com/${REPO}/actions/runs/1)`);
  const [to, text] = k.host.sends.at(-1)!;
  expect(to).toBe("T8");
  expect(text).toContain(`https://github.com/${REPO}/pull/8 (X1)`);
  expect(text).toContain("the merge train did not merge it: CI failed");
  expect(text).toContain("fleetd/T8-broken");
  // The author removes FAIL and pushes: a new patch, reviewed, merged.
  k.pr(8, "fleetd/T8-broken", { "fixed.md": "ok\n" });
  await k.settle();
  expect(k.change(8).state).toBe("merged");
});

test("a PR that conflicts with its base goes back to its writer as needs_rebase", async () => {
  const k = kit();
  k.pr(9, "fleetd/T9-a", { "shared.md": "nine\n" });
  k.pr(10, "fleetd/T10-b", { "shared.md": "ten\n" });
  await k.enqueue(9);
  await k.settle();
  expect(k.change(9).state).toBe("merged");
  await k.enqueue(10);
  await k.settle();
  const c = k.change(10);
  expect(c.state).toBe("needs_rebase");
  expect(c.lastError).toBe("conflicts with main");
  expect(k.host.sends.at(-1)![1]).toContain("the merge train could not rebase it: it conflicts with main");
  expect(k.host.eventsOf("change.needs_rebase")).toMatchObject([{ changeId: c.changeId }]);
});

test("two ready PRs green on their own heads land as one batch, each closed with a link", async () => {
  const k = kit();
  k.pr(11, "fleetd/T11-one", { "one.md": "1\n" });
  k.pr(12, "fleetd/T12-two", { "two.md": "2\n" });
  await k.enqueue(11);
  await k.enqueue(12);
  await k.settle();
  expect([k.change(11).state, k.change(12).state]).toEqual(["merged", "merged"]);
  const batch = [...k.gh.pulls].find(([, p]) => p.branch === "fleetd/train/batch");
  expect(batch).toBeDefined();
  const [n, pull] = batch!;
  expect(pull.title).toBe("batch: PR 11 (#11); PR 12 (#12)");
  expect(batchHeads(pull.body).map(([x]) => x)).toEqual([11, 12]);
  expect(k.gh.log).toContain(`merge #${n}`);
  expect(k.gh.pulls.get(11)!.comments[0]).toStartWith(`Landed in #${n} (`);
  expect(k.gh.pulls.get(11)!.state).toBe("closed");
  expect(k.host.eventsOf("pr.merged").map((e) => [e.prNumber, e.batchPr])).toEqual([
    [11, n],
    [12, n],
  ]);
  const body = Bun.spawnSync(["git", "log", "-1", "--format=%B", "main"], { cwd: k.origin }).stdout.toString();
  expect(body).toContain("Fleetd-Change: X1 (T11, W1)\nFleetd-Change: X2 (T12, W1)");
});

test("a red batch sends each PR alone: the green one merges, the red one goes back", async () => {
  const k = kit();
  k.pr(13, "fleetd/T13-good", { "good.md": "g\n" });
  k.pr(14, "fleetd/T14-bad", { "bad.md": "b\n" });
  // PR 14's own head passes; only the batch's tree fails.
  k.gh.runs = (sha) => {
    const fails = Bun.spawnSync(["git", "cat-file", "-e", `${sha}:bad.md`], { cwd: k.origin }).exitCode === 0 && Bun.spawnSync(["git", "cat-file", "-e", `${sha}:good.md`], { cwd: k.origin }).exitCode === 0;
    return [{ id: 1, name: "ci", status: "completed", conclusion: fails ? "failure" : "success", html_url: `https://github.com/${REPO}/actions/runs/1/job/2` }];
  };
  await k.enqueue(13);
  await k.enqueue(14);
  await k.settle(20);
  expect(k.change(13).state).toBe("merged");
  expect(k.change(14).state).toBe("ci_failed");
});

test("enqueue refuses a PR with no workstream brief, a closed PR, and a fork's branch, with their fixes", async () => {
  const k = kit();
  k.pr(15, "fleetd/T15-x", { "x.md": "x\n" });
  k.host.workstream = () => ({ workstreamId: "W1", projectRef: PROJECT, hasBrief: false, open: true });
  await expect(k.enqueue(15)).rejects.toMatchObject({ code: "invalid", message: `The train refused https://github.com/${REPO}/pull/15: W1 has no brief yet.` });
  const k2 = kit();
  k2.pr(16, "fleetd/T16-x", { "x.md": "x\n" }, { state: "closed" });
  await expect(k2.enqueue(16)).rejects.toMatchObject({ code: "invalid", fix: "enqueue an open PR" });
  expect(k2.change(16).state).toBe("refused");
  k2.pr(17, "fleetd/T17-x", { "y.md": "y\n" }, { headRepo: "someone/fork" });
  await expect(k2.enqueue(17)).rejects.toMatchObject({ message: expect.stringContaining("Its branch lives in another repository.") });
  await expect(k2.train.enqueue(PROJECT, { prUrl: "https://example.com/x" })).rejects.toMatchObject({ code: "invalid" });
  await expect(k2.train.enqueue(PROJECT, { taskId: "T99", prUrl: `https://github.com/${REPO}/pull/17` })).rejects.toMatchObject({ code: "not_found" });
});

test("the same open PR enqueued again is the same Change; a draft waits until it is marked ready", async () => {
  const k = kit();
  k.pr(18, "fleetd/T18-x", { "x.md": "x\n" }, { draft: true });
  const a = await k.enqueue(18);
  const b = await k.enqueue(18);
  expect(b.changeId).toBe(a.changeId);
  expect(a.lastError).toBe("draft, waiting to be marked ready");
  await k.settle();
  expect(k.change(18).state).toBe("queued");
  k.gh.pulls.get(18)!.draft = false;
  await k.settle();
  expect(k.change(18).state).toBe("merged");
});

test("the hold label keeps a ready PR off the train until it is gone", async () => {
  const k = kit();
  k.pr(19, "fleetd/T19-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(19);
  await k.settle();
  expect(k.change(19)).toMatchObject({ state: "ready", lastError: "held: the PR has the `hold` label; the train takes it once the label is gone" });
  k.gh.pulls.get(19)!.labels = [];
  await k.settle();
  expect(k.change(19).state).toBe("merged");
});

test("a repo with no CI holds its ready PRs and says so", async () => {
  const k = kit();
  k.gh.noCi = true;
  k.pr(20, "fleetd/T20-x", { "x.md": "x\n" });
  await k.enqueue(20);
  await k.settle();
  expect(k.change(20).lastError).toStartWith("held: this repo has no CI");
  expect(k.train.reposWithoutCi()).toEqual([REPO]);
});

test("a merge GitHub refuses goes back to ready, and after three the lead hears the train gave up", async () => {
  const k = kit();
  k.pr(21, "fleetd/T21-x", { "x.md": "x\n" });
  for (let i = 0; i < 3; i++) k.gh.mergeReplies.push(httpError(405, "Pull Request is not mergeable"));
  await k.enqueue(21);
  await k.settle(10);
  const c = k.change(21);
  expect(c.state).toBe("ci_failed");
  expect(c.lastError).toBe("GitHub refused the merge (HTTP 405): Pull Request is not mergeable; gave up after 3 tries");
  expect(k.host.wakes.at(-1)).toContain("the train gave up after 3 tries");
});

test("a PR merged into main without the train is reported once", async () => {
  const k = kit();
  k.pr(22, "fleetd/T22-x", { "x.md": "x\n" });
  await k.enqueue(22);
  await k.settle();
  // Someone merges PR 23 by hand.
  k.pr(23, "someone-else", { "z.md": "z\n" }, { state: "closed", merged: true, mergedAt: new Date(k.clock.ms + 3_600_000).toISOString(), mergeSha: "f".repeat(40) });
  k.clock.ms += 2 * 60_000;
  await k.train.step(REPO);
  expect(k.host.eventsOf("pr.merged_outside")).toMatchObject([{ repo: REPO, prNumber: 23, base: "main", head: "someone-else" }]);
  k.clock.ms += 2 * 60_000;
  await k.train.step(REPO);
  expect(k.host.eventsOf("pr.merged_outside").length).toBe(1);
  expect(k.host.wakes).toContain(`${REPO}#23 was merged into main without the merge train.`);
});

test("a write task's result naming its PR puts it on the train (auto-enqueue)", async () => {
  const k = kit();
  k.pr(24, "fleetd/T24-x", { "x.md": "x\n" });
  await k.train.onTaskPr("T24");
  expect(k.change(24).state).toBe("ready");
  // An already merged PR is skipped quietly.
  k.pr(25, "fleetd/T25-x", { "y.md": "y\n" }, { state: "closed", merged: true });
  await k.train.onTaskPr("T25");
  expect(k.change(25)).toBeUndefined();
});

test("a stopped order's PRs leave the train", async () => {
  const k = kit();
  k.pr(26, "fleetd/T26-x", { "x.md": "x\n" }, { labels: ["hold"] });
  await k.enqueue(26);
  const left = k.train.takeLeftovers(PROJECT, "W1", "its order was stopped");
  expect(left.map((c) => [c.changeId, c.state])).toEqual([["X1", "abandoned"]]);
});

// --- the pure rules ---

test("a head's checks read green, pending or red, a cancelled check red only once nothing runs", () => {
  const run = (name: string, status: string, conclusion?: string) => ({ id: 1, name, status, conclusion: conclusion ?? null });
  expect(checks([]).kind).toBe("none");
  expect(checks([run("a", "completed", "success"), run("b", "completed", "skipped")]).kind).toBe("green");
  expect(checks([run("a", "in_progress"), run("b", "completed", "cancelled")]).kind).toBe("pending");
  expect(checks([run("a", "completed", "cancelled")]).kind).toBe("red");
  expect(checks([run("a", "completed", "failure"), run("b", "queued")]).kind).toBe("red");
});

test("GitHub's words for a merge refused while checks are expected", () => {
  expect(awaitsChecks("3 of 3 required status checks are expected.")).toBe(true);
  expect(awaitsChecks('Required status check "build" is in progress.')).toBe(true);
  expect(awaitsChecks('Required status check "error-prone" is expected.')).toBe(true);
  expect(awaitsChecks('Required status check "build" has failed.')).toBe(false);
  expect(awaitsChecks("Base branch was modified.")).toBe(false);
});

test("job names with expressions match their checks; the label's and the batch's skips are read from workflows", () => {
  expect(gatedName("qa (${{ matrix.os }})", "qa (macos-latest)")).toBe(true);
  expect(gatedName("qa (${{ matrix.os }})", "lint (macos-latest)")).toBe(false);
  const shard = "qa (${{ matrix.os }}, ${{ matrix.shard }}/${{ matrix.of }})";
  expect(gatedName(shard, "qa (ubuntu-latest, 1/4)")).toBe(true);
  expect(gatedName(shard, "qa (ubuntu-latest)")).toBe(false);
  const ci = "name: CI\non: pull_request\njobs:\n  lint:\n    runs-on: x\n  rust:\n    name: rust (linux)\n    runs-on: x\n  qa:\n    strategy:\n      matrix:\n        os: [a, b]\n    runs-on: x\n  mobile:\n    uses: ./.github/workflows/mobile.yml\n";
  const jobs = jobChecks([["ci.yml", ci]]);
  const defined = (n: string) => jobs.some((j) => gatedName(j, n));
  for (const n of ["lint", "rust (linux)", "qa (a)", "mobile / mobile (ios)"]) expect(defined(n)).toBe(true);
  for (const n of ["rust", "rust (macos)", "qa"]) expect(defined(n)).toBe(false);
  const skips = "${{ !endsWith( github.head_ref , \"train/batch\") }}";
  const wf = (on: string, jobs: string) => `name: W\non:\n${on}\njobs:\n${jobs}`;
  const job = (id: string, cond: string) => `  ${id}:\n    if: ${cond}\n    runs-on: macos-latest\n`;
  const names = batchSkipped([
    ["ci.yml", wf("  pull_request:\n  push:", job("mac", skips) + job("batch-only", "endsWith(github.head_ref, 'train/batch')"))],
    ["typed.yml", wf("  pull_request:\n    types: [opened, synchronize, reopened]", job("typed", skips))],
    ["list.yml", wf("  [push, pull_request]", job("listed", skips))],
    ["label.yml", wf("  pull_request:\n    types: [labeled]", job("labelled", skips))],
    ["main.yml", wf("  push:", job("main", skips))],
  ]).map((s) => s.name);
  expect(names).toEqual(["mac", "typed", "listed"]);
  const labelWf = "name: L\non:\n  pull_request:\n    types: [labeled]\njobs:\n  mac:\n    if: contains(github.event.pull_request.labels.*.name, 'fleetd:next')\n    runs-on: macos-latest\n";
  expect(labelGated([["label.yml", labelWf]])).toEqual(["mac"]);
  const batch = [{ name: "mac", needs: ["scope"] }];
  const skipped = { id: 1, name: "mac", status: "completed", conclusion: "skipped" };
  expect(unprovenBatchSkips([skipped, { id: 2, name: "scope", status: "completed", conclusion: "success" }], batch)).toEqual([]);
  expect(unprovenBatchSkips([skipped, { id: 2, name: "scope", status: "completed", conclusion: "cancelled" }], batch).map((r) => r.name)).toEqual(["mac"]);
});

test("a PR's own head keeps it out of a batch for a failed, running or unreported check", () => {
  const run = (name: string, status: string, conclusion?: string) => ({ id: 1, name, status, conclusion: conclusion ?? null });
  expect(ownChecks([], [], undefined, [])).toBe("its own head has no checks yet");
  expect(ownChecks([run("ci", "completed", "failure")], [], undefined, [])).toBe("its own head's `ci` failed");
  expect(ownChecks([run("ci", "in_progress")], [], undefined, [])).toBe("its own head's `ci` still running");
  expect(ownChecks([run("ci", "completed", "success")], [], undefined, ["mac"])).toBe("its own head hasn't reported `mac` yet");
  expect(ownChecks([run("ci", "completed", "success")], [], undefined, [])).toBeUndefined();
});

test("squash messages and trailers as GitHub and git read them", () => {
  const pull = { number: 7, title: "Add pricing", body: "the body" } as never;
  expect(squashText(pull, "COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES", ["one commit\n\nits body"])).toEqual(["one commit (#7)", "its body"]);
  expect(squashText(pull, "PR_TITLE", "COMMIT_MESSAGES", ["a\n\nCo-authored-by: X <x@x>", "b\n\nco-authored-by: x <x@x>"])).toEqual([
    "Add pricing (#7)",
    "* a\n\n* b\n\n---------\n\nCo-authored-by: X <x@x>",
  ]);
  const change = { changeId: "X3", taskId: "T4", workstreamId: "W2" } as never;
  expect(withTrailers("body\n\nCo-authored-by: X <x@x>", [change])).toBe("body\n\nCo-authored-by: X <x@x>\nFleetd-Change: X3 (T4, W2)");
  expect(withTrailers("just a body", [change])).toBe("just a body\n\nFleetd-Change: X3 (T4, W2)");
  expect(withTrailers("", [change])).toBe("Fleetd-Change: X3 (T4, W2)");
  expect(batchHeads("intro\n\nfleetd-batch: #12@AbC #13@def #20\n")).toEqual([
    [12, "abc"],
    [13, "def"],
    [20, undefined],
  ]);
});

test("a flaky job's log names its failing test", () => {
  expect(failedTest("2026-10-17T10:00:00.1234567Z test hub::train::tests::merges ... FAILED")).toBe("hub::train::tests::merges");
  expect(failedTest("--- FAIL: TestMerge (0.01s)")).toBe("TestMerge");
  expect(failedTest("\u001b[31mFAIL\u001b[0m src/a.test.ts > merges")).toBe("src/a.test.ts > merges");
  expect(failedTest("all good")).toBeUndefined();
});

test("the regenerate config and early migrations", () => {
  const c = parseRegenerate('{ "generated": ["gen/"], "run": ["make gen"], "migrations": "migrations" }');
  expect(earlyMigrations(c, ["migrations/0005_x.sql", "migrations/0009_y.sql", "src/a.ts"], ["0001_a.sql", "0007_b.sql"])).toEqual(["0005_x.sql"]);
  expect(() => parseRegenerate('{ "generated": ["../x"], "run": [] }')).toThrow("is not a path inside the repo");
  expect(() => parseRegenerate('{ "generated": [], "run": [], "extra": 1 }')).toThrow("unknown field");
  expect(parseRepoChecks('{ "fastChecks": ["site"], "afterMerge": ["e2e"] }')).toEqual({ fastChecks: ["site"], afterMerge: ["e2e"] });
  for (const bad of ['{ "fastCheck": ["site"] }', '{ "fastChecks": ["site", "site"] }', '{ "fastChecks": "site" }']) expect(() => parseRepoChecks(bad)).toThrow();
});

test("a PR that puts files back to an older version of its base undoes those commits", () => {
  const v = (commit: string, blob: string | undefined, at: number) => ({ commit, subject: commit, at, ...(blob ? { blob } : {}) });
  const history = [v("c3", "b3", 30), v("c2", "b2", 20), v("c1", "b1", 10)];
  expect(undone("b3", 25, history)).toBeUndefined();
  expect(undone("b1", 25, history)?.map((x) => x.commit)).toEqual(["c3", "c2"]);
  expect(undone("b9", 25, history)).toBeUndefined();
  const restores = [{ path: "a", undone: [v("c3", "b3", 30)] }];
  expect(counted(restores, new Set(), new Map([["c3", [["a", false], ["b", false], ["c", false]] as [string, boolean][]]]))).toEqual([]);
  expect(counted(restores, new Set(), new Map([["c3", [["a", false], ["b", false]] as [string, boolean][]]])).length).toBe(1);
  expect(deliberate("Revert #123: it broke the build")).toBe(true);
  expect(deliberate("revert abcdef1")).toBe(true);
  expect(deliberate("An ordinary change")).toBe(false);
});
