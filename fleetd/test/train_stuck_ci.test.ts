// The train never sits on a PR whose CI won't come (fleetd-cloud #1037, 2026-11-27): the pin bump's head had only its
// own manual CI run, red, beside a pull_request run waiting for an approval; CI's time started over at each workspace
// restart; and the train kept waiting on it after the PR was closed.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { TrainOptions } from "../src/hub/train/service.ts";
import { WAIT_CI } from "../src/hub/train/states.ts";
import { Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

const MINUTE = 60_000;
const BEFORE = "2026-10-17T09:00:00Z";

/** A Kit whose waits run `hook` with the clock after each, as the train's CI wait sleeps. */
const kit = (hook?: (k: Kit) => void) => {
  const box: { k?: Kit } = {};
  const sleep: TrainOptions["sleep"] = async (ms) => {
    box.k!.clock.ms += ms;
    hook?.(box.k!);
    await Bun.sleep(0);
  };
  const k = new Kit({ sleep });
  box.k = k;
  kits.push(k);
  return k;
};

/** A job `id` of workflow run `run`, done with `conclusion`, or running while it is undefined. */
const job = (id: number, run: number, name: string, conclusion?: string) => ({
  id,
  name,
  status: conclusion === undefined ? "in_progress" : "completed",
  conclusion: conclusion ?? null,
  started_at: BEFORE,
  completed_at: conclusion === undefined ? null : BEFORE,
  html_url: `https://github.com/${REPO}/actions/runs/${run}/job/${id}`,
});

test("a red manual run of the workflow whose pull_request run never started is the PR's CI: it goes back at once", async () => {
  const k = kit();
  // The pin bump pushes with the workflow's token: CI's pull_request run (1) waits for an approval with no job, and the
  // bump starts CI itself (run 2, the same workflow 7), which fails.
  k.gh.runs = () => [job(5, 2, "pin", "success"), job(10, 2, "check", "failure")];
  k.gh.runEvents.push([1, "pull_request", 7], [2, "workflow_dispatch", 7]);
  k.pr(7, "fleetd/pin-bump", { "package.json": "{}\n" });
  await k.enqueue(7);
  const began = k.clock.ms;
  await k.settle();
  const change = k.change(7);
  expect(change.state).toBe("ci_failed");
  expect(change.lastError).toContain("CI failed on");
  expect(change.lastError).toContain("check (failure)");
  // Not after CI's time ran out on a head with "no checks".
  expect(k.clock.ms - began).toBeLessThan(k.train.options.ciTimeoutMs);
});

test("CI's time on a head goes on across a workspace restart: checks that never start send it back on time", async () => {
  let cut: number | undefined;
  const k = kit((k) => {
    // The workspace stops 40 minutes into CI's wait.
    if (cut !== undefined && k.clock.ms >= cut) {
      cut = undefined;
      k.train.stop();
      throw new Error("the workspace stopped");
    }
  });
  // A manual run of another workflow (a Nightly someone ran on the branch) is all that reports: no check of the PR's own.
  k.gh.runs = () => [job(10, 2, "nightly", "failure")];
  k.gh.runEvents.push([2, "workflow_dispatch", 9]);
  k.pr(7, "fleetd/T7-docs", { "docs.md": "docs\n" });
  const change = await k.enqueue(7);
  const timeout = k.train.options.ciTimeoutMs;
  cut = k.clock.ms + 40 * MINUTE;
  await k.settle().catch(() => {});
  expect(k.change(7).state).toBe("ci");
  const began = k.train.records.wait(change.changeId, WAIT_CI)!.sinceMs;
  const train = k.restarted();
  for (let i = 0; i < 10 && k.change(7).state !== "ci_failed"; i++) {
    k.clock.ms += 61_000;
    await train.step(REPO);
  }
  expect(k.change(7).state).toBe("ci_failed");
  // Its writer hears why (the train goes on reading a timed-out head's checks, and may name the red one after).
  expect(k.host.sends.some(([to, m]) => to === "T7" && m.includes(`no check reported within ${timeout / MINUTE} min`))).toBe(true);
  // Within a few polls of its 45 minutes from the first start, not 45 more after the restart.
  expect(k.clock.ms - began).toBeLessThan(timeout + 5 * MINUTE);
  expect(train.records.wait(change.changeId, WAIT_CI)).toBeUndefined();
});

test("a PR closed while the train waits on its CI leaves the train at once", async () => {
  let closeAt: number | undefined;
  const k = kit((k) => {
    if (closeAt !== undefined && k.clock.ms >= closeAt) k.gh.pulls.get(7)!.state = "closed";
  });
  // Its CI runs on and on.
  k.gh.runs = () => [job(5, 1, "ci")];
  k.pr(7, "fleetd/T7-docs", { "docs.md": "docs\n" });
  await k.enqueue(7);
  closeAt = k.clock.ms + 5 * MINUTE;
  await k.settle();
  expect(k.change(7)).toMatchObject({ state: "abandoned", lastError: "was closed" });
  expect(k.clock.ms - closeAt).toBeLessThan(5 * MINUTE);
  expect(k.gh.log.some((l) => l.startsWith("merge "))).toBe(false);
});
