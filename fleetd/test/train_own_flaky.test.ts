// A PR can't turn its base red with its own flaky test (W826): a failing test the PR adds or changes isn't re-run as a
// flake, so the PR goes back to its writer; an old flake in a test it doesn't touch keeps its one re-run. And a check
// red on main after a merge opens no fix order while a fix is already under way: an open PR or a write task under way
// that names its failing test or its run.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { failedTests, ownTests, testLeaf } from "../src/hub/train/flaky.ts";
import type { Train } from "../src/hub/train/service.ts";
import { Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

const kit = () => {
  const k = new Kit();
  kits.push(k);
  return k;
};

const MINUTE = 60_000;
/** The test #1979 added, which failed in the train, passed on its re-run, merged, and then failed on main. */
const NEW_TEST = "a long whitespace run after a key's header or line is matched in linear time, and the key still hidden";
const OLD_TEST = "a session keeps its scratch dir through a node restart";
/** Main's CI run of c962d511 that it failed in. */
const MAIN_RUN = 45058871823;

/** A job `id` of workflow run `run`, done with `conclusion`. */
const job = (id: number, run: number, name: string, conclusion: string) => ({
  id,
  name,
  status: "completed",
  conclusion,
  html_url: `https://github.com/${REPO}/actions/runs/${run}/job/${id}`,
});

/** `fleetd`'s failed log as GitHub serves it: a coloured step header, then Bun's own lines. */
const bunLog = (failing: string) =>
  [
    "2026-11-22T18:58:22.4046591Z \u001b[36;1mbun test --parallel=4\u001b[0m",
    "2026-11-22T18:58:54.7877500Z (pass) the train merges a green PR [98.10ms]",
    `2026-11-22T18:58:54.9047475Z (fail) redact > ${failing} [5012.28ms]`,
    "2026-11-22T18:59:54.2412571Z  1 fail",
  ].join("\n");

/** The required `fleetd` fails on the PR's head (job 10) and passes when the train re-runs it (job 11). */
function flakyOnce(k: Kit, failing: string): void {
  k.gh.required = ["fleetd"];
  k.gh.jobLogs.set(10, bunLog(failing));
  k.gh.runs = () => [job(10, 2, "fleetd", "failure"), ...(k.gh.reruns.length > 0 ? [job(11, 2, "fleetd", "success")] : [])];
}

const redactTests = (...names: string[]) => `import { expect, test } from "bun:test";\n\n${names.map((n) => `test("${n}", () => {\n  expect(1).toBe(1);\n});\n`).join("\n")}`;

// --- a PR's own flaky test goes back to its writer ---

test("a test the PR adds that fails in the train goes back to its writer, not re-run as a flake", async () => {
  const k = kit();
  flakyOnce(k, NEW_TEST);
  k.pr(7, "fleetd/T7-redact", { "test/redact.test.ts": redactTests(NEW_TEST) });
  await k.enqueue(7);
  await k.settle();
  expect(k.change(7).state).toBe("ci_failed");
  expect(k.gh.reruns).toEqual([]);
  expect(k.gh.log.some((l) => l.startsWith("merge "))).toBe(false);
  const sent = k.host.sends.at(-1)!;
  expect(sent[0]).toBe("T7");
  expect(sent[1]).toContain(`the failing test redact > ${NEW_TEST} (fleetd) is one this PR adds or changes`);
  expect(sent[1]).toContain("Make it pass every time");
  expect(k.host.sends.some(([, m]) => m.includes("flaky CI on"))).toBe(false);
  expect(k.host.wakes.some((w) => w.includes("flaky CI on"))).toBe(false);
});

test("a test the PR changes that fails in the train goes back to its writer too", async () => {
  const k = kit();
  k.pr(6, "fleetd/T6-base", { "test/redact.test.ts": redactTests(OLD_TEST, NEW_TEST) });
  await k.enqueue(6);
  await k.settle();
  expect(k.change(6).state).toBe("merged");

  flakyOnce(k, NEW_TEST);
  const changed = redactTests(OLD_TEST, NEW_TEST).replace(`test("${NEW_TEST}", () => {\n  expect(1).toBe(1);`, `test("${NEW_TEST}", () => {\n  expect(2).toBe(2);`);
  k.pr(7, "fleetd/T7-redact", { "test/redact.test.ts": changed });
  await k.enqueue(7);
  await k.settle();
  expect(k.change(7).state).toBe("ci_failed");
  expect(k.gh.reruns).toEqual([]);
  expect(k.host.sends.at(-1)![1]).toContain("is one this PR adds or changes");
});

test("an old flake in a test the PR doesn't touch keeps its one re-run, and merges", async () => {
  const k = kit();
  flakyOnce(k, OLD_TEST);
  // The PR changes a test file, but not the test that failed.
  k.pr(7, "fleetd/T7-redact", { "test/redact.test.ts": redactTests(NEW_TEST) });
  await k.enqueue(7);
  await k.settle();
  expect(k.change(7).state).toBe("merged");
  expect(k.gh.reruns).toEqual([10]);
  expect(k.host.sends.filter(([, m]) => m.includes(`fleetd (test redact > ${OLD_TEST}) failed, then passed`)).length).toBe(1);
});

test("which failing tests a PR's diff adds or changes, by their own names in a test file's hunks", () => {
  const diff = [
    "diff --git a/fleetd/test/redact.test.ts b/fleetd/test/redact.test.ts",
    "--- a/fleetd/test/redact.test.ts",
    "+++ b/fleetd/test/redact.test.ts",
    "@@ -10,3 +10,8 @@ import { redact } from",
    " });",
    "+",
    `+test('${NEW_TEST.replace("'", "\\'")}', () => {`,
    "+  expect(redact(x)).toBe(y);",
    "+});",
    "diff --git a/fleetd/src/redact.ts b/fleetd/src/redact.ts",
    "--- a/fleetd/src/redact.ts",
    "+++ b/fleetd/src/redact.ts",
    "@@ -1,2 +1,2 @@",
    `-// ${OLD_TEST}`,
    `+// ${OLD_TEST}!`,
  ].join("\n");
  // An escaped quote in the source still names the test; a name in a source file names none.
  expect(ownTests(diff, [`redact > ${NEW_TEST}`, OLD_TEST])).toEqual([`redact > ${NEW_TEST}`]);
  expect(ownTests(diff, ["src/redact.test.ts > other"])).toEqual([]);
  expect(testLeaf("crate::redact::tests::long_whitespace")).toBe("long_whitespace");
  expect(testLeaf("TestRedact/long_run")).toBe("TestRedact");
  expect(testLeaf("tests/test_redact.py::test_long[case-1]")).toBe("test_long");
  expect(testLeaf("redact.test.ts > redact > long run 5012ms")).toBe("long run");
  expect(failedTests(bunLog(NEW_TEST) + "\n(fail) another [1ms]\n" + bunLog(NEW_TEST))).toEqual([`redact > ${NEW_TEST}`, "another"]);
});

// --- a check red on main with a fix under way opens no fix order ---

const step = async (k: Kit, train: Train = k.train, by = 61_000) => {
  k.clock.ms += by;
  return train.step(REPO);
};

/**
 * PR 7 merged, then `fleetd`, which runs only after merges, fails on main in run `MAIN_RUN` (job 50) and again on the
 * train's re-run of it, naming `NEW_TEST`.
 */
async function redOnMain(k: Kit): Promise<void> {
  let failed = false;
  k.gh.required = ["unit"];
  k.trainFile([]);
  k.gh.jobLogs.set(50, bunLog(NEW_TEST));
  k.gh.runs = () => [job(1, 1, "unit", "success"), ...(failed ? [job(50, MAIN_RUN, "fleetd", "failure")] : [])];
  k.pr(7, "fleetd/T7-a", { "a1.txt": "a\n" });
  await k.enqueue(7);
  expect(await step(k)).toBe(true);
  expect(k.change(7).state).toBe("merged");
  failed = true;
  await step(k);
  expect(k.gh.reruns).toEqual([50]);
  for (let i = 0; i < 3; i++) await step(k);
}

test("a check red on main opens no fix order while a task under way names its failing test, and the status says a fix is in progress", async () => {
  const k = kit();
  k.host.underWay.push({ taskId: "T4992", workstreamId: "W820", text: `Fix the timing test\nMake "${NEW_TEST}" pass on every run.` });
  await redOnMain(k);
  expect(k.host.orders).toEqual([]);
  expect(k.train.mainCiNote(REPO)).toBe("`fleetd` is red on main, fix in progress");
  // Later passes don't look again, nor open one.
  await step(k, k.train, 6 * MINUTE);
  expect(k.host.orders).toEqual([]);
  expect(k.gh.reruns).toEqual([50]);
});

test("a check red on main opens no fix order while an open PR names its run", async () => {
  const k = kit();
  k.gh.pulls.set(9, {
    repo: REPO,
    branch: "fleetd/T4992-timing",
    base: "main",
    title: "fix(node): the timing test",
    body: `Main's run https://github.com/${REPO}/actions/runs/${MAIN_RUN} failed on it.`,
    state: "open",
    merged: false,
    labels: [],
    draft: false,
    comments: [],
  });
  await redOnMain(k);
  expect(k.host.orders).toEqual([]);
  expect(k.train.mainCiNote(REPO)).toBe("`fleetd` is red on main, fix in progress");
});

test("a check red on main still opens its one fix order when no PR or task names it", async () => {
  const k = kit();
  k.host.underWay.push({ taskId: "T5000", workstreamId: "W821", text: "Something else\nA new settings page." });
  await redOnMain(k);
  expect(k.host.orders.length).toBe(1);
  expect(k.host.orders[0]![1]).toStartWith("Fix the check `fleetd` on main");
  expect(k.train.mainCiNote(REPO)).toBe("`fleetd` is red on main, fix in progress");
});

test("a check the train re-ran that GitHub leaves out of its list for a while stays pending, never read as green (fleetd-cloud #824)", async () => {
  const k = kit();
  // As fleetd-cloud #824 on 3d379d34, a repo that requires no checks: `check` failed (job 10) and the train re-ran it.
  // Until the re-run (job 11) started, GitHub listed only `pin` and `infra`, both green; then job 11 failed too.
  k.gh.jobLogs.set(10, bunLog(OLD_TEST));
  let reads = 0;
  k.gh.runs = () => {
    const green = [job(1, 2, "pin", "success"), job(2, 2, "infra", "success")];
    if (k.gh.reruns.length === 0) return [...green, job(10, 2, "check", "failure")];
    reads += 1;
    if (reads <= 3) return green;
    if (reads <= 6) return [...green, { ...job(11, 2, "check", "failure"), status: "in_progress", conclusion: null }];
    return [...green, job(11, 2, "check", "failure")];
  };
  k.pr(8, "fleetd/T8-x", { "x.md": "x\n" });
  await k.enqueue(8);
  await k.settle();
  expect(k.gh.reruns).toEqual([10]);
  expect(k.gh.log.filter((l) => l.startsWith("merge") || l.startsWith("status fleetd/train success"))).toEqual([]);
  expect(k.change(8).state).toBe("ci_failed");
});
