// A ready PR that no task opened goes on the train by its `fleetd-train` label (src/hub/train/label.ts): a Renovate,
// Dependabot or workflow PR, such as the cloud's standing pin bump (W858). It opens its own order, briefed from the PR,
// goes through review and CI as a writer's PR does, and its order closes when the PR merges or closes. Without the
// label, from a fork, or as a draft, it stays off the train.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { LABEL_DONE_WHEN, TRAIN_LABEL } from "../src/hub/train/label.ts";
import { Kit, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

/** A kit whose repo has its train (a writer's PR 7 on it, merged by the first passes). */
async function kit(): Promise<Kit> {
  const k = new Kit();
  kits.push(k);
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  k.host.tasks.get("T7")!.state = "running";
  k.host.branches.set("T7", "fleetd/T7-pricing");
  await k.enqueue(7);
  return k;
}

/** PR `n` from `branch`, opened by no task (`k.pr` makes one: it is dropped). */
function openPr(k: Kit, n: number, branch: string, extra: Parameters<Kit["pr"]>[3] = {}): void {
  k.pr(n, branch, { [`${n}.md`]: `${n}\n` }, extra);
  k.host.tasks.delete(`T${n}`);
}

async function passes(k: Kit, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    k.clock.ms += 61_000;
    await k.train.step(REPO);
  }
}

const changesOf = (k: Kit, n: number) => k.train.records.list({ repo: REPO, limit: 50 }).filter((c) => c.prNumber === n);

test("a labelled PR opens its own order, briefed from the PR, goes through review and CI, and its order closes when it merges", async () => {
  const k = await kit();
  openPr(k, 20, "fleetd/pin-bump", { labels: [TRAIN_LABEL], title: "The pin moves to fleetd 7ce064b", body: "fleetd's commits it takes:\n- A fix (#2106)" });
  await passes(k, 2);
  const [change] = changesOf(k, 20);
  expect(change).toMatchObject({ workstreamId: "W200", branch: "fleetd/pin-bump" });
  expect(change!.taskId).toBeUndefined();
  const order = k.host.briefed.get("W200")!;
  expect(order.requestId).toBe(`train-label:${REPO}#20`);
  expect(order.brief).toEqual({
    goal: "The pin moves to fleetd 7ce064b",
    why: "fleetd's commits it takes:\n- A fix (#2106)",
    pointers: [`https://github.com/${REPO}/pull/20`],
    constraints: ["The pull request's own title and description are its brief: judge it by them, its diff and its CI."],
    doneWhen: [LABEL_DONE_WHEN],
  });
  await k.settle();
  expect(k.change(20).state).toBe("merged");
  expect(order.closed).toBe(`https://github.com/${REPO}/pull/20 merged`);
  // The writer's own order is a lead's: never closed by the train.
  expect(k.change(7).state).toBe("merged");
  expect([...k.host.briefed.keys()]).toEqual(["W200"]);
});

test("a labelled PR closed unmerged leaves the train, and its order closes with why", async () => {
  const k = await kit();
  // Held, so it waits on the train until its PR closes; the label's case doesn't matter, as on GitHub.
  openPr(k, 21, "renovate/bun-1.x", { labels: ["dependencies", "FLEETD-TRAIN", "hold"] });
  await passes(k, 1);
  expect(changesOf(k, 21)).toHaveLength(1);
  k.gh.pulls.get(21)!.state = "closed";
  await k.settle();
  expect(k.change(21).state).toBe("abandoned");
  expect(k.host.briefed.get("W200")!.closed).toStartWith(`https://github.com/${REPO}/pull/21 left the train (abandoned`);
  // Reopened at the same head: back on the train, under a new order of its own.
  k.gh.pulls.get(21)!.state = "open";
  await passes(k, 2);
  expect(changesOf(k, 21).map((c) => [c.workstreamId, c.state])).toContainEqual(["W201", expect.not.stringMatching(/abandoned|refused/)]);
  expect(k.host.briefed.get("W201")).toMatchObject({ requestId: `train-label:${REPO}#21` });
  expect(k.host.briefed.get("W201")!.closed).toBeUndefined();
});

test("a labelled PR whose order a person stopped stays off the train: not at the same head, nor at a new one", async () => {
  const k = await kit();
  openPr(k, 26, "renovate/x", { labels: [TRAIN_LABEL, "hold"] });
  await passes(k, 1);
  expect(changesOf(k, 26).map((c) => c.workstreamId)).toEqual(["W200"]);
  // The stop flow (chat/stop.ts): its PRs off the train while the order is still open, then the order stopped.
  k.train.takeLeftovers(k.change(26).projectRef, "W200", "W200 was stopped: by you");
  Object.assign(k.host.briefed.get("W200")!, { stopped: true, closed: "stopped" });
  await passes(k, 2);
  expect(changesOf(k, 26).map((c) => [c.workstreamId, c.state])).toEqual([["W200", "abandoned"]]);
  // A new push: refused, said to the lead, and still no new order.
  k.pr(26, "renovate/x", { "26.md": "26 again\n" }, { labels: [TRAIN_LABEL, "hold"] });
  k.host.tasks.delete("T26");
  await passes(k, 2);
  expect(changesOf(k, 26)).toHaveLength(1);
  expect([...k.host.briefed.keys()]).toEqual(["W200"]);
  expect(k.host.wakes.some((w) => w.includes("/pull/26") && w.includes("was stopped, so it stays off the train"))).toBe(true);
});

test("without the label, from a fork, or as a draft, a PR no task opened stays off the train, and opens no order", async () => {
  const k = await kit();
  openPr(k, 22, "sam/pricing-fix");
  openPr(k, 23, "dependabot/npm/x", { labels: [TRAIN_LABEL], headRepo: "someone/storefront" });
  openPr(k, 24, "renovate/x", { labels: [TRAIN_LABEL], draft: true });
  await passes(k, 3);
  for (const n of [22, 23, 24]) expect(changesOf(k, n)).toEqual([]);
  expect(k.host.briefed.size).toBe(0);
});

test("a hub that can't open a briefed order takes no PR by its label", async () => {
  const k = await kit();
  (k.host as { openBriefedOrder?: unknown }).openBriefedOrder = undefined;
  openPr(k, 25, "fleetd/pin-bump", { labels: [TRAIN_LABEL] });
  await passes(k, 2);
  expect(changesOf(k, 25)).toEqual([]);
});
