// A check GitHub still shows pending after its workflow run finished (#1362), as the Rust hub has it
// (crates/fleetd/src/hub/train/tests/stale.rs): the train re-runs that run once per head and waits for the fresh
// result, never counting the stale check as passed; a run still going is never re-run. The shapes are GitHub's own
// answers, shared with the Rust tests (crates/fleetd/src/hub/train/testdata/stale_checks.json): `stale` the Desktop
// QA run 42538020541 at attempt 1, completed green while job `qa (ubuntu-latest, 1/4)` read in_progress (conclusion
// success); `rerun` its checks after the lead re-ran it; `pending` a CI run with its `site` job still going.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownCi } from "../src/hub/train/batch.ts";
import { Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

type Run = Record<string, unknown>;
const FIXTURE = join(import.meta.dir, "../../../crates/fleetd/src/hub/train/testdata/stale_checks.json");
const fixture = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, { check_runs: Run[]; workflow_run?: Run }>;
const checkRuns = (shape: string): Run[] => fixture()[shape]!.check_runs;

const STALE_RUN = 42538020541;
const MINUTE = 60_000;
const WAITS =
  "its own head's `qa (ubuntu-latest, 1/4)` stayed pending after its workflow run finished; the train re-ran that run and waits for the fresh result";

/** A job `id` of workflow run `run`, done with `conclusion`. */
const job = (id: number, run: number, name: string, conclusion: string) => ({
  id,
  name,
  status: "completed",
  conclusion,
  html_url: `https://github.com/${REPO}/actions/runs/${run}/job/${id}`,
});

/** `runs` in place of the checks of their names in `shown`. */
function show(shown: Run[], runs: Run[]): void {
  for (const r of runs) {
    const at = shown.findIndex((s) => s.name === r.name);
    if (at >= 0) shown.splice(at, 1);
    shown.push(r);
  }
}

/**
 * The four QA shards and `site`, required on main, on a clock long after the recorded runs finished. Each head shows
 * `checks`, with the required checks it lacks green; both recorded workflow runs answer. Returns the checks shown, to
 * change.
 */
function kit(checks: Run[]): [Kit, Run[]] {
  const k = new Kit();
  kits.push(k);
  k.clock.ms = Date.parse("2027-01-15T08:00:00Z");
  const required = [...checkRuns("stale").map((r) => r.name as string), "site"];
  k.gh.required = required;
  k.trainFile([]);
  const shown = [...checks];
  required.forEach((name, i) => {
    if (!shown.some((r) => r.name === name)) shown.push(job(i + 1, 1, name, "success"));
  });
  k.gh.runs = () => shown.map((r) => ({ ...r }));
  for (const shape of ["stale", "pending"]) {
    const run = fixture()[shape]!.workflow_run!;
    k.gh.workflowRuns.set(run.id as number, run);
  }
  return [k, shown];
}

test("#1362: a check left pending under a finished run gets one re-run of that run", async () => {
  const [k, shown] = kit(checkRuns("stale"));
  k.pr(7, "qa", { "qa.txt": "qa\n" });
  const change = await k.enqueue(7);

  expect(await ownCi(k.train, REPO, change, "main")).toBe(WAITS);
  expect(k.gh.runReruns).toEqual([STALE_RUN]);
  expect(k.gh.reruns).toEqual([]);

  // GitHub still shows the stale check, long after: the head waits, and the run is not re-run again.
  k.clock.ms += 30 * MINUTE;
  expect(await ownCi(k.train, REPO, change, "main")).toBe(WAITS);
  expect(k.gh.runReruns).toEqual([STALE_RUN]);

  // The re-run's checks come in: still going, then green.
  const going = checkRuns("rerun");
  going[0] = { ...going[0], status: "in_progress", conclusion: null };
  show(shown, going);
  expect(await ownCi(k.train, REPO, change, "main")).toBe("its own head's `qa (ubuntu-latest, 1/4)` still running");
  show(shown, checkRuns("rerun"));
  expect(await ownCi(k.train, REPO, change, "main")).toBeUndefined();
  expect(k.gh.runReruns).toEqual([STALE_RUN]);
});

test("a run finished a moment ago is not re-run yet", async () => {
  const [k] = kit(checkRuns("stale"));
  const run = k.gh.workflowRuns.get(STALE_RUN) as Run;
  run.updated_at = new Date(k.clock.ms - MINUTE).toISOString();
  k.pr(7, "qa", { "qa.txt": "qa\n" });
  const change = await k.enqueue(7);

  expect(await ownCi(k.train, REPO, change, "main")).toBe("its own head's `qa (ubuntu-latest, 1/4)` still running");
  expect(k.gh.runReruns).toEqual([]);

  k.clock.ms += 5 * MINUTE;
  expect(await ownCi(k.train, REPO, change, "main")).toBe(WAITS);
  expect(k.gh.runReruns).toEqual([STALE_RUN]);
});

test("a check of a run still going is not re-run", async () => {
  const [k] = kit(checkRuns("pending"));
  k.pr(7, "site", { "site.txt": "site\n" });
  const change = await k.enqueue(7);

  for (let i = 0; i < 3; i++) {
    expect(await ownCi(k.train, REPO, change, "main")).toBe("its own head's `site` still running");
    k.clock.ms += 20 * MINUTE;
  }
  expect(k.gh.runReruns).toEqual([]);
  expect(k.gh.reruns).toEqual([]);
});

test("the CI wait re-runs a stale run once and merges on its fresh result", async () => {
  const [k, shown] = kit(checkRuns("stale"));
  // Green on its own head, behind main: the train rebases it, and the new head's QA shard is left pending.
  k.pr(7, "qa", { "qa.txt": "qa\n" });
  const old = k.gh.headOf("qa");
  const green = [...checkRuns("rerun"), job(5, 1, "site", "success")];
  let reads = 0;
  k.gh.runs = (sha) => {
    if (sha === old) return green;
    const runs = shown.map((r) => ({ ...r }));
    // The re-run's checks come in a few reads after it.
    if (k.gh.runReruns.length > 0 && reads++ >= 3) show(runs, checkRuns("rerun"));
    return runs;
  };
  k.commitMain({ "other.txt": "other\n" });
  await k.enqueue(7);

  await k.train.step(REPO);
  expect(k.change(7).state).toBe("merged");
  expect(k.gh.runReruns).toEqual([STALE_RUN]);
  expect(reads).toBeGreaterThan(3);
});
