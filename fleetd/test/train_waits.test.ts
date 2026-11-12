// The train's waits as the Rust hub has them since #1303, #1327, #1334, #1345 and #1300 (crates/fleetd/src/hub/train/
// tests.rs, tests/restarts.rs, tests/regen.rs): a check the train re-ran is waited for until its re-run is done; a
// check red on main after a merge is re-run once, then gets one fix order; the train's waits on a Change survive a
// restart; a removed project's PRs leave the train once; repeating warnings log at most hourly.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { WAIT_BLOCKED, WAIT_REGEN, WAIT_UNSTARTED } from "../src/hub/train/records.ts";
import { regen } from "../src/hub/train/regen.ts";
import { REPEAT_EVERY_MS, Repeats } from "../src/hub/train/repeats.ts";
import { BLOCKED_WAKE_MS, REMOVED_PROJECT, type Train } from "../src/hub/train/service.ts";
import { Kit, PROJECT, REPO } from "./train_kit.ts";

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
const BEFORE = "2026-10-17T09:00:00Z";

/** A job `id` of workflow run `run`, done with `conclusion`. */
const job = (id: number, run: number, name: string, conclusion: string) => ({
  id,
  name,
  status: "completed",
  conclusion,
  html_url: `https://github.com/${REPO}/actions/runs/${run}/job/${id}`,
});

/** A check `id` of its own run, running while `conclusion` is undefined. */
const run = (id: number, name: string, conclusion?: string) => ({
  id,
  name,
  status: conclusion !== undefined ? "completed" : "in_progress",
  conclusion: conclusion ?? null,
  started_at: BEFORE,
  html_url: `https://github.com/${REPO}/actions/runs/${id}/job/${id}`,
});

const step = async (k: Kit, train: Train = k.train, by = 61_000) => {
  k.clock.ms += by;
  return train.step(REPO);
};

// --- #1334: a check the train re-ran for failing is waited for until its re-run is done ---

/**
 * `bun (experimental)`, outside the fast set, fails on the PR's own head while the required `build` passes. The train
 * re-runs it, and its re-run stays queued, then runs, for a few reads before it is done with `conclusion`. Returns how
 * often the re-run was read done.
 */
function nonFastReRun(k: Kit, conclusion: string): { done: number } {
  const seen = { done: 0 };
  let reads = 0;
  k.gh.required = ["build"];
  k.gh.runs = () => {
    const runs: Record<string, unknown>[] = [job(5, 1, "build", "success"), job(10, 2, "bun (experimental)", "failure")];
    if (k.gh.reruns.length > 0) {
      const rerun: Record<string, unknown> = job(11, 2, "bun (experimental)", conclusion);
      const n = reads++;
      if (n >= 4) {
        seen.done++;
        return [...runs, rerun];
      }
      runs.push({ ...rerun, status: n === 0 ? "queued" : "in_progress", conclusion: null });
    }
    return runs;
  };
  return seen;
}

test("a failed check outside the fast set is waited for on its re-run, and failing again goes back to its author", async () => {
  const k = kit();
  const seen = nonFastReRun(k, "failure");
  k.pr(7, "fleetd/T7-docs", { "docs.md": "docs\n" });
  await k.enqueue(7);
  await k.settle();
  expect(seen.done).toBeGreaterThan(0);
  expect(k.change(7).state).toBe("ci_failed");
  expect(k.gh.reruns).toEqual([10]);
  expect(k.gh.log.some((l) => l.startsWith("merge "))).toBe(false);
  expect(k.host.sends.some(([, m]) => m.includes("flaky"))).toBe(false);
  expect(k.host.sends.at(-1)![1]).toContain("bun (experimental) (failure)");
  expect(k.host.wakes.some((w) => w.includes("flaky CI on"))).toBe(false);
});

test("a failed check outside the fast set merges once its re-run passed, called flaky then", async () => {
  const k = kit();
  const seen = nonFastReRun(k, "success");
  k.pr(7, "fleetd/T7-docs", { "docs.md": "docs\n" });
  await k.enqueue(7);
  await k.settle();
  expect(seen.done).toBeGreaterThan(0);
  expect(k.change(7).state).toBe("merged");
  expect(k.gh.reruns).toEqual([10]);
  expect(k.host.sends.filter(([, m]) => m.includes("bun (experimental) failed, then passed")).length).toBe(1);
});

// --- a flaky check's note names the test its failed run's log names, the log read through gh as it answers ---

/** `bun (experimental)`'s failed log as GitHub serves it: a coloured step header, then Bun's own lines. */
const BUN_LOG = [
  "2026-11-12T08:58:22.4046591Z \u001b[36;1mbun test --parallel=4\u001b[0m",
  "2026-11-12T08:58:54.7877500Z (pass) the train merges a green PR [98.10ms]",
  "2026-11-12T08:58:54.9047475Z (fail) a session keeps its scratch dir through a node restart [97.28ms]",
  "2026-11-12T08:59:54.2412571Z  1 fail",
].join("\n");

for (const oldGh of [false, true]) {
  test(`a flaky check's note names the failing test from its coloured log${oldGh ? ", on a gh before 2.97.0" : ""}`, async () => {
    const k = kit();
    nonFastReRun(k, "success");
    k.gh.jobLogs.set(10, BUN_LOG);
    k.gh.oldGh = oldGh;
    k.pr(7, "fleetd/T7-docs", { "docs.md": "docs\n" });
    await k.enqueue(7);
    await k.settle();
    expect(k.change(7).state).toBe("merged");
    const named = "bun (experimental) (test a session keeps its scratch dir through a node restart) failed, then passed";
    expect(k.host.sends.filter(([, m]) => m.includes(named)).length).toBe(1);
    expect(k.host.wakes.filter((w) => w.includes(named)).length).toBe(1);
  });
}

// --- #1303: a check failing on main after a merge is re-run once before one fix order; manual runs ignored ---

/**
 * A kit whose `unit` gates merges and whose `ios sessions` runs only after them, as job 50 of workflow run `wfRun`:
 * `ios` says how it is done from the jobs the train re-ran so far.
 */
function kitWithLateIos(wfRun: number, ios: (reruns: number[]) => Record<string, unknown>[]): Kit {
  const k = kit();
  k.gh.required = ["unit"];
  k.trainFile([]);
  k.gh.runs = () => [
    job(1, 1, "unit", "success"),
    ...ios(k.gh.reruns).map((r) => ({ ...r, html_url: `https://github.com/${REPO}/actions/runs/${wfRun}/job/${r.id === 50 ? 50 : 51}` })),
  ];
  return k;
}

/** PR 7 merged, alone. */
async function merged(k: Kit): Promise<void> {
  k.pr(7, "fleetd/T7-a", { "a1.txt": "a\n" });
  await k.enqueue(7);
  expect(await step(k)).toBe(true);
  expect(k.change(7).state).toBe("merged");
}

test("a check that fails on main and passes its one re-run opens nothing, and the status says it is re-run", async () => {
  let failed = false;
  let rerunDone = false;
  const k = kitWithLateIos(40, (reruns) => {
    const runs = [run(50, "ios sessions", failed ? "failure" : undefined)];
    if (reruns.length > 0) runs.push(run(51, "ios sessions", rerunDone ? "success" : undefined));
    return runs;
  });
  await merged(k);

  failed = true;
  await step(k);
  expect(k.gh.reruns).toEqual([50]);
  // The re-run goes: main waits for it, and the status says why.
  await step(k);
  expect(k.train.mainCiNote(REPO)).toBe("`ios sessions` failed on main after the merge, re-running once");

  rerunDone = true;
  await step(k);
  expect(k.train.mainCiNote(REPO)).toBeUndefined();
  await step(k, k.train, 6 * MINUTE);
  expect(k.host.orders).toEqual([]);
  expect(k.gh.reruns.length).toBe(1);
  expect(k.train.records.watches(REPO)).toEqual([]);
});

test("a check that fails on main and on its re-run opens one fix order, and is never re-run again", async () => {
  let failed = false;
  // GitHub's re-run of job 50 fails again (`failingAgain`).
  const k = kitWithLateIos(40, () => [run(50, "ios sessions", failed ? "failure" : undefined)]);
  await merged(k);

  failed = true;
  await step(k);
  expect(k.gh.reruns).toEqual([50]);
  expect(k.host.orders).toEqual([]);
  expect(k.train.mainCiNote(REPO)).toBe("`ios sessions` is red on main, re-running once");
  for (let i = 0; i < 3; i++) await step(k);
  expect(k.host.orders.length).toBe(1);
  expect(k.host.orders[0]![1]).toContain("and again when the train re-ran it once.");
  expect(k.gh.reruns).toEqual([50]);
  expect(k.train.mainCiNote(REPO)).toBe("`ios sessions` is red on main, fix in progress");
});

test("two jobs failing in one run on main are each re-run once, one at a time", async () => {
  let done = false;
  const k = kit();
  k.gh.required = ["unit"];
  k.trainFile([]);
  const edge = (id: number, name: string) => (done ? job(id, 40, name, "failure") : { ...job(id, 40, name, "failure"), status: "in_progress", conclusion: null });
  k.gh.runs = () => [job(1, 1, "unit", "success"), edge(50, "edge / desktop-linux"), edge(51, "edge / desktop-macos")];
  await merged(k);

  done = true;
  await step(k);
  expect(k.gh.reruns).toEqual([50]);
  expect(k.host.orders).toEqual([]);
  // Both fail again on their re-runs: each opens its one order, after its re-run.
  await step(k);
  expect(k.gh.reruns).toEqual([50, 51]);
  await step(k);
  expect(k.host.orders.length).toBe(2);
  for (const [, text] of k.host.orders) expect(text).toContain("and again when the train re-ran it once.");
  expect(k.gh.reruns.length).toBe(2);
});

test("a failed manual or scheduled run on main opens nothing and isn't re-run", async () => {
  for (const event of ["workflow_dispatch", "schedule"]) {
    let failed = false;
    const k = kitWithLateIos(77, () => (failed ? [run(50, "ios", "failure")] : []));
    k.gh.runEvents.push([77, event]);
    await merged(k);

    failed = true;
    for (let i = 0; i < 3; i++) await step(k);
    expect(k.host.orders).toEqual([]);
    expect(k.gh.reruns).toEqual([]);
    await step(k, k.train, 6 * MINUTE);
    expect(k.train.records.watches(REPO)).toEqual([]);
  }
});

// --- #1327: a fast check red on main after a merge gets one re-run, then one fix order ---

test("a fast check red on main after the merge is re-run once, then opens one fix order saying it passed on the batch", async () => {
  let failed = false;
  const k = kit();
  k.gh.required = ["unit"];
  k.trainFile(["bun (experimental)"]);
  k.gh.runs = () => [job(1, 1, "unit", "success"), job(50, 40, "bun (experimental)", failed ? "failure" : "success")];
  await merged(k);
  expect(k.host.orders).toEqual([]);

  failed = true;
  await step(k);
  expect(k.gh.reruns).toEqual([50]);
  expect(k.host.orders).toEqual([]);
  // It fails again on its re-run (`failingAgain`).
  await step(k);
  await step(k);
  expect(k.host.orders.length).toBe(1);
  const text = k.host.orders[0]![1];
  expect(text).toStartWith("Fix the check `bun (experimental)` on main: it failed after the merge train merged");
  expect(text).toContain("and again when the train re-ran it once.");
  // The train waited for it and it passed on the batch: the order says so, not that it ran only after the merge.
  expect(text).toContain("It passed on the merge train's batch, but failed on main's own run: look at what that run does differently");
  expect(text).not.toContain("doesn't wait for this check");
  expect(k.gh.reruns).toEqual([50]);
});

// --- #1345: the train's waits survive a hub restart ---

const wakesSaying = (k: Kit, text: string) => k.host.wakes.filter((w) => w.includes(text)).length;
const since = (train: Train, changeId: string, kind: string) => train.records.wait(changeId, kind)!.sinceMs;

test("a wait for checks to start keeps its start across a restart, and flags once per head", async () => {
  // main requires `build`; the PR's head has only `lint`.
  const k = kit();
  k.gh.required = ["build"];
  k.gh.runs = () => [run(1, "lint", "success")];
  k.pr(7, "fleetd/T7-silent", { "q.txt": "q\n" }, { labels: ["hold"] });
  const change = await k.enqueue(7);
  const wait = k.train.options.checksStartWaitMs;
  const flagged = () => wakesSaying(k, "no check started on its head");

  await step(k);
  const began = since(k.train, change.changeId, WAIT_UNSTARTED);
  k.clock.ms = began + wait - MINUTE;
  let train = k.restarted();
  await train.step(REPO);
  expect(flagged()).toBe(0);
  expect(since(train, change.changeId, WAIT_UNSTARTED)).toBe(began);

  k.clock.ms = began + wait;
  await train.step(REPO);
  expect(flagged()).toBe(1);

  train = k.restarted();
  await step(k, train, wait);
  expect(flagged()).toBe(1);
});

test("a blocked wait keeps its start across a restart, and the lead hears once per head", async () => {
  const k = kit();
  k.gate.blocking.add("X1");
  k.pr(7, "fleetd/T7-slice-1", { "a1.txt": "a\n" });
  const change = await k.enqueue(7);
  expect(change.state).toBe("reviewing");
  const told = () => wakesSaying(k, "call `change_enqueue` for it again");

  await step(k);
  const began = since(k.train, change.changeId, WAIT_BLOCKED);
  k.clock.ms = began + BLOCKED_WAKE_MS - MINUTE;
  let train = k.restarted();
  await train.step(REPO);
  expect(told()).toBe(0);
  expect(since(train, change.changeId, WAIT_BLOCKED)).toBe(began);

  k.clock.ms = began + BLOCKED_WAKE_MS;
  await train.step(REPO);
  expect(told()).toBe(1);

  train = k.restarted();
  await step(k, train, BLOCKED_WAKE_MS);
  expect(told()).toBe(1);
});

/** PR 7 adds a migration that sorts before one main added after it: the train renames it by regenerating. */
async function earlyMigration(k: Kit): Promise<string> {
  k.commitMain({ ".fleetd/regenerate.json": JSON.stringify({ generated: ["gen/"], run: ["make gen"], migrations: "migrations" }) });
  k.pr(7, "fleetd/T7-migrate", { "migrations/202605010000_mine.sql": "-- mine\n" });
  const change = await k.enqueue(7);
  k.commitMain({ "migrations/202610270000_theirs.sql": "-- theirs\n" });
  return change.changeId;
}

test("a failed regeneration is not tried again after a restart", async () => {
  const k = kit();
  const id = await earlyMigration(k);
  // The kit's node refuses every run: the regeneration fails.
  await step(k);
  await k.train.regenerationsDone();
  const failed = k.train.records.get(id)!;
  expect(regen(k.train, failed)).toBe("failed");
  const runs = k.host.nodeRuns.length;
  expect(runs).toBeGreaterThan(0);

  const train = k.restarted();
  expect(regen(train, failed)).toBe("failed");
  await step(k, train);
  await train.regenerationsDone();
  expect(k.host.nodeRuns.length).toBe(runs);
});

test("a regeneration the hub stopped in is run again", async () => {
  const k = kit();
  const change = k.train.records.get(await earlyMigration(k))!;
  k.train.records.startWait(change, WAIT_REGEN, change.headSha, 0, "running");
  expect(k.host.nodeRuns).toEqual([]);

  const train = k.restarted();
  expect(regen(train, change)).toBeUndefined();
  await step(k, train);
  await train.regenerationsDone();
  expect(k.host.nodeRuns.length).toBeGreaterThan(0);
});

// --- #1300: removed projects' PRs leave quietly; repeating warnings at most hourly ---

test("a removed project's PRs leave the train once, with one line; a live project's stay", async () => {
  const k = kit();
  k.pr(7, "fleetd/T7-gone", { "g.txt": "g\n" }, { labels: ["hold"] });
  k.pr(8, "fleetd/T8-kept", { "k.txt": "k\n" }, { labels: ["hold"] });
  const gone = await k.enqueue(7);
  const kept = await k.enqueue(8);
  k.train.records.put({ ...k.train.records.get(gone.changeId)!, projectRef: { machineId: "devbox", projectId: "removed" } });

  const lines: string[] = [];
  const [info, warn] = [console.info, console.warn];
  console.info = (...a: unknown[]) => void lines.push(`INFO ${a.join(" ")}`);
  console.warn = (...a: unknown[]) => void lines.push(`WARN ${a.join(" ")}`);
  try {
    k.train.dropRemoved();
    k.train.dropRemoved();
  } finally {
    [console.info, console.warn] = [info, warn];
  }

  const left = k.train.records.get(gone.changeId)!;
  expect([left.state, left.lastError]).toEqual(["abandoned", REMOVED_PROJECT]);
  expect(k.train.records.get(kept.changeId)!.state).not.toBe("abandoned");
  const abandoned = k.host.eventsOf("change.state").filter((d) => d.to === "abandoned");
  expect(abandoned.map((d) => d.changeId)).toEqual([gone.changeId]);
  expect(lines.filter((l) => l.includes("PRs of removed projects left the train")).length).toBe(1);
  expect(lines.filter((l) => l.startsWith("WARN"))).toEqual([]);
  expect(PROJECT.projectId).toBe("storefront");
});

test("a repeating warning logs once, then hourly with the count held back", () => {
  const r = new Repeats();
  expect(r.due("a", "down", 0)).toBe(0);
  expect(r.due("a", "down", 1_000)).toBeUndefined();
  expect(r.due("a", "down", REPEAT_EVERY_MS - 1)).toBeUndefined();
  expect(r.due("a", "down", REPEAT_EVERY_MS)).toBe(2);
  expect(r.due("a", "down", REPEAT_EVERY_MS + 1)).toBeUndefined();
  // Another error, or another key, is news.
  expect(r.due("a", "refused", REPEAT_EVERY_MS + 2)).toBe(0);
  expect(r.due("b", "refused", REPEAT_EVERY_MS + 2)).toBe(0);
  expect(r.clear("a")).toBe(true);
  expect(r.clear("a")).toBe(false);
  expect(r.due("a", "refused", REPEAT_EVERY_MS + 3)).toBe(0);
});
