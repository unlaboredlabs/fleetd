// "Merge, then verify" over the fake GitHub of train_kit.ts: each ready PR merges on its own green CI on a fresh
// rebase, side by side and never in a batch; a base turned red by two PRs that pass alone is bisected, the culprit
// reverted first and sent back to its writer; a flake on the base reverts nothing; a base that requires branches up to
// date makes a PR go again, never fail. Counts, not milliseconds, measure what the line saves.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { gitOut, Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(60_000);

const BEFORE = "2026-10-17T09:00:00Z";

/** A kit whose bot merges, then verifies, with one required check `ci`, red where `red` says. */
function kit(red: (sha: string) => boolean, upToDate = false): Kit {
  const k = new Kit();
  kits.push(k);
  k.host.mode = "verify_after";
  k.gh.upToDate = upToDate;
  k.gh.required = ["ci"];
  // Each commit's run its own job, so a re-run of one is that commit's.
  const ids = new Map<string, number>();
  k.gh.runs = (sha) => {
    const head = gitOut(k.origin, ["rev-parse", sha]) ?? sha;
    let id = ids.get(head);
    if (id === undefined) {
      id = 10 + ids.size;
      ids.set(head, id);
    }
    return [
      {
        id,
        name: "ci",
        status: "completed",
        conclusion: red(head) ? "failure" : "success",
        started_at: BEFORE,
        completed_at: BEFORE,
        html_url: `https://github.com/${REPO}/actions/runs/${id}/job/${id}`,
      },
    ];
  };
  return k;
}

/** Whether commit `sha` holds `path`. */
const has = (k: Kit, sha: string, path: string) => gitOut(k.origin, ["cat-file", "-e", `${sha}:${path}`]) !== undefined;

/** Passes of the train, each waiting for the PRs it took side by side, until nothing moves. */
async function drain(k: Kit, passes = 12): Promise<void> {
  for (let i = 0; i < passes; i++) {
    k.clock.ms += 61_000;
    const took = await k.train.step(REPO);
    await k.train.lanes.idle();
    if (!took && !k.train.lanes.any(REPO)) {
      k.clock.ms += 6 * 60_000;
      await k.train.step(REPO);
      await k.train.lanes.idle();
    }
  }
}

const merges = (k: Kit) => k.gh.log.filter((l) => l.startsWith("merge #"));
const batches = (k: Kit) => [...k.gh.pulls.values()].filter((p) => p.branch.includes("train/batch"));

test("each reviewed PR green on a fresh rebase merges on its own, side by side, never in a batch", async () => {
  const k = kit(() => false);
  for (const n of [1, 2, 3]) {
    k.pr(n, `fleetd/T${n}-a`, { [`f${n}.txt`]: `${n}\n` });
    await k.enqueue(n);
  }
  await drain(k);
  for (const n of [1, 2, 3]) expect(k.change(n).state).toBe("merged");
  expect(merges(k).sort()).toEqual(["merge #1", "merge #2", "merge #3"]);
  expect(batches(k)).toEqual([]);
  // Each one rebased once, onto main as it was then: the ones after the first merged behind it, with no second CI run.
  expect(k.gh.log.filter((l) => l.startsWith("rebase #")).length).toBeLessThanOrEqual(3);
});

test("PRs beyond the repo's ciAtOnce wait, saying why, and go once a place frees", async () => {
  const k = kit(() => false);
  k.commitMain({ ".fleetd/train.json": JSON.stringify({ ciAtOnce: 1 }) });
  k.train.repoChecks.clear();
  for (const n of [1, 2]) {
    k.pr(n, `fleetd/T${n}-a`, { [`f${n}.txt`]: `${n}\n` });
    await k.enqueue(n);
  }
  k.clock.ms += 61_000;
  await k.train.step(REPO);
  expect(k.change(2).lastError).toContain("waiting for a free place in CI: 1 PR is in CI at once");
  await k.train.lanes.idle();
  await drain(k);
  expect(k.change(1).state).toBe("merged");
  expect(k.change(2).state).toBe("merged");
});

test("two PRs green alone but red together: the base is bisected, the second reverted first, and its writer told", async () => {
  // `ci` fails only on a tree with both files.
  const k = kit((sha) => has(k, sha, "a.txt") && has(k, sha, "b.txt"));
  k.pr(1, "fleetd/T1-a", { "a.txt": "a\n" });
  k.pr(2, "fleetd/T2-b", { "b.txt": "b\n" });
  await k.enqueue(1);
  await k.enqueue(2);
  await drain(k, 20);
  expect(k.change(1).state).toBe("merged");
  expect(k.change(2).state).toBe("merged");
  // The merge that broke it is the one whose tree has both: the train re-ran it once, then reverted it.
  const culprit = has(k, k.change(1).mergedSha!, "b.txt") ? 1 : 2;
  expect(k.gh.reverted).toEqual([culprit]);
  const revert = [...k.gh.pulls].find(([, p]) => p.branch.startsWith(`revert-${culprit}-`))!;
  expect(revert[1].body).toContain(`Reverts #${culprit}`);
  // The revert landed before any other PR, and main is green again with the other PR's work on it.
  expect(revert[1].merged).toBe(true);
  const main = gitOut(k.origin, ["rev-parse", "main"])!;
  expect(has(k, main, "a.txt") && has(k, main, "b.txt")).toBe(false);
  // Its writer hears it was reverted; the lead hears it once; no fix order opens.
  const told = k.host.sends.filter(([task]) => task === `T${culprit}`).map(([, text]) => text);
  expect(told.some((t) => t.includes("reverted it in"))).toBe(true);
  expect(k.host.wakes.filter((w) => w.includes("reverted:"))).toHaveLength(1);
  expect(k.host.orders).toEqual([]);
  // Bisecting read what each merge's own CI had already run: one re-run, of the red commit, and no other.
  expect(k.gh.reruns).toHaveLength(1);
});

test("a check red on the base that passes its one re-run is a flake: nothing is reverted, no order opens", async () => {
  const k = kit(() => false);
  const flaked = true;
  const runs = k.gh.runs!;
  k.gh.runs = (sha) => {
    const [r] = runs(sha) as Record<string, unknown>[];
    const onMain = gitOut(k.origin, ["rev-parse", "main"]) === gitOut(k.origin, ["rev-parse", sha]);
    if (!onMain || !flaked) return [r!];
    // Red on the merged commit, green on the train's re-run of it.
    const id = r!.id as number;
    return k.gh.reruns.includes(id) ? [{ ...r, conclusion: "failure" }, { ...r, id: id + 500, conclusion: "success" }] : [{ ...r, conclusion: "failure" }];
  };
  k.pr(1, "fleetd/T1-a", { "a.txt": "a\n" });
  await k.enqueue(1);
  await drain(k, 10);
  expect(k.change(1).state).toBe("merged");
  expect(k.gh.reruns).toHaveLength(1);
  expect(k.gh.reverted).toEqual([]);
  expect(k.host.orders).toEqual([]);
  expect(k.host.wakes.filter((w) => w.includes("reverted:"))).toEqual([]);
});

test("a base that requires branches up to date: a PR behind it goes again, rebased, and never counts as failed", async () => {
  const k = kit(() => false, true);
  for (const n of [1, 2, 3]) {
    k.pr(n, `fleetd/T${n}-a`, { [`f${n}.txt`]: `${n}\n` });
    await k.enqueue(n);
  }
  await drain(k, 20);
  for (const n of [1, 2, 3]) expect(k.change(n).state).toBe("merged");
  expect(k.host.wakes.filter((w) => w.includes("gave up"))).toEqual([]);
});

test("one slow PR holds no other: side by side lands the rest in a fraction of the time a batch with it takes", async () => {
  // Every PR's CI takes 5 minutes; any tree with PR 1's work in it, 40. Time runs only as the test moves the clock, the same for every
  // PR in CI at once, so the two modes are timed alike.
  const landing = async (mode: "verify_after" | "test_first") => {
    const k = new Kit({ sleep: async (ms) => { const until = k.clock.ms + ms; while (k.clock.ms < until) await Bun.sleep(0); } });
    kits.push(k);
    k.host.mode = mode;
    k.gh.upToDate = false;
    k.gh.required = ["ci"];
    const seen = new Map<string, number>();
    k.gh.runs = (sha) => {
      const head = gitOut(k.origin, ["rev-parse", sha]) ?? sha;
      if (!seen.has(head)) seen.set(head, k.clock.ms);
      // PR 1 adds a slow test: any tree with its work takes 40 minutes, within the train's 45 of CI time.
      const takes = has(k, head, "slow.txt") ? 40 * 60_000 : 5 * 60_000;
      const done = k.clock.ms - seen.get(head)! >= takes;
      const id = 10 + [...seen.keys()].indexOf(head);
      return [{ id, name: "ci", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null, started_at: BEFORE, html_url: `https://github.com/${REPO}/actions/runs/${id}/job/${id}` }];
    };
    k.pr(1, "fleetd/T1-a", { "slow.txt": "x\n" });
    const green = [2, 3, 4, 5, 6, 7, 8, 9];
    for (const n of green) k.pr(n, `fleetd/T${n}-a`, { [`f${n}.txt`]: `${n}\n` });
    for (const n of [1, ...green]) await k.enqueue(n);
    const start = k.clock.ms;
    let stepping: Promise<unknown> | undefined;
    let lastStep = -Infinity;
    while (!green.every((n) => k.change(n).state === "merged") && k.clock.ms - start < 6 * 60 * 60_000) {
      if (stepping === undefined && k.clock.ms - lastStep >= 15_000) {
        lastStep = k.clock.ms;
        stepping = k.train.step(REPO).finally(() => (stepping = undefined));
      }
      k.clock.ms += 5_000;
      for (let i = 0; i < 10; i++) await Bun.sleep(0);
    }
    await stepping;
    expect(green.every((n) => k.change(n).state === "merged")).toBe(true);
    return k.clock.ms - start;
  };
  const verify = await landing("verify_after");
  const batches = await landing("test_first");
  // Batches wait on the slow PR's 40 minutes; side by side, the other eight land in three rounds of five minutes
  // beside it. A ratio of times on the same clock, never a budget in milliseconds.
  expect(verify / batches).toBeLessThan(0.6);
}, 120_000);
