// A red base's fix on the train (red_fix.ts): on 2026-11-23 fleetd-cloud's main was red from a `check` job running
// past its limit, and its fix, #769 (it changed `.github/workflows/ci.yml`), sat "ready" behind four PRs in CI on the
// red main while the status said "no fix under way". Now the status counts it, and the line takes it first: past the
// repo's limit on PRs in CI at once in "Merge, then verify", alone and first in test-then-merge.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { gitOut, Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

const CI_YML = "name: CI\non: [push, pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n";
const LINT_YML = "name: Lint\non: [push, pull_request]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun run lint\n";

/** A kit whose main has the `ci` and `lint` workflows, with `ci` red on main's head as it is now, green elsewhere. */
function redMain(mode: "verify_after" | "test_first"): Kit {
  const k = new Kit();
  kits.push(k);
  k.host.mode = mode;
  k.gh.required = ["ci"];
  k.commitMain({ ".github/workflows/ci.yml": CI_YML, ".github/workflows/lint.yml": LINT_YML, ".fleetd/train.json": JSON.stringify({ ciAtOnce: 1 }) });
  k.train.repoChecks.clear();
  const red = gitOut(k.origin, ["rev-parse", "refs/heads/main"]);
  k.gh.runs = (sha) => {
    const head = gitOut(k.origin, ["rev-parse", sha]) ?? sha;
    return [{ id: 5, name: "ci", status: "completed", conclusion: head === red ? "cancelled" : "success", html_url: `https://github.com/${REPO}/actions/runs/5/job/5` }];
  };
  return k;
}

test("a PR changing the failing check's workflow is the red main's fix: the status counts it, and it takes a place in CI past the limit", async () => {
  const k = redMain("verify_after");
  k.pr(1, "fleetd/T1-feature", { "f1.txt": "1\n" });
  // Another workflow's file is no fix for `ci`.
  k.pr(2, "fleetd/T2-lint", { ".github/workflows/lint.yml": `${LINT_YML}# faster\n` });
  k.pr(3, "fleetd/T3-fix", { ".github/workflows/ci.yml": `${CI_YML}    timeout-minutes: 30\n` });
  for (const n of [1, 2, 3]) await k.enqueue(n);
  // The repo's one place in CI is taken by a PR already in it.
  const busy = k.train.lanes.of(REPO);
  busy.add("X-already-in-ci");
  k.clock.ms += 61_000;
  await k.train.step(REPO);
  expect(k.train.mainCiNote(REPO)).toBe("`ci` is red on main, fix in progress: #3");
  // The fix went into CI though the place was taken; the others wait for it.
  expect(k.change(3).lastError ?? "").not.toContain("waiting for a free place in CI");
  expect(busy.has(k.change(3).changeId) || k.change(3).state !== "ready").toBe(true);
  for (const n of [1, 2]) expect(k.change(n).lastError).toContain("waiting for a free place in CI: 1 PR is in CI at once");
  busy.delete("X-already-in-ci");
  await k.train.lanes.idle();
});

test("with no fix on the train, the red main still says no fix under way", async () => {
  const k = redMain("verify_after");
  k.pr(1, "fleetd/T1-lint", { ".github/workflows/lint.yml": `${LINT_YML}# faster\n` });
  await k.enqueue(1);
  k.train.lanes.of(REPO).add("X-already-in-ci");
  k.clock.ms += 61_000;
  await k.train.step(REPO);
  expect(k.train.mainCiNote(REPO)).toBe("`ci` is red on main, no fix under way");
  expect(k.change(1).lastError).toContain("waiting for a free place in CI");
  k.train.lanes.of(REPO).delete("X-already-in-ci");
});

test("in test-then-merge, the red main's fix goes first and alone, ahead of PRs queued before it", async () => {
  const k = redMain("test_first");
  k.pr(1, "fleetd/T1-feature", { "f1.txt": "1\n" });
  k.pr(2, "fleetd/T2-feature", { "f2.txt": "2\n" });
  k.pr(3, "fleetd/T3-fix", { ".github/workflows/ci.yml": `${CI_YML}    timeout-minutes: 30\n` });
  for (const n of [1, 2, 3]) await k.enqueue(n);
  k.clock.ms += 61_000;
  await k.train.step(REPO);
  const fix = k.change(3).changeId;
  for (const n of [1, 2]) expect(k.change(n).lastError).toBe(`not in this batch: ${fix} goes first: it fixes the red base, so it merges first, on its own`);
  expect(k.change(3).state).not.toBe("ready");
});
