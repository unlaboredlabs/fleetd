// Every PR a writer opens goes on the train as its task's, exactly once (W791). On 2026-11-23 T5178, whose branch was
// `fleetd/T5178-a-cloud-lead-woken-late-answers-in-about`, opened a second PR from `fleetd/T5178-mcp-skip-unreachable`
// in the bot's other repo: the ready pass took only the task's own branch and `<branch>-<n>`, so the PR sat open, with
// no review and no train entry, until the lead enqueued it by hand.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Kit, PROJECT, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
setDefaultTimeout(30_000);

/** A kit whose writer T7, at work on `fleetd/T7-pricing`, has its own PR 7 on the train. */
async function writer(): Promise<Kit> {
  const k = new Kit();
  kits.push(k);
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  k.host.tasks.get("T7")!.state = "running";
  k.host.branches.set("T7", "fleetd/T7-pricing");
  await k.enqueue(7);
  return k;
}

/** PR `n` from `branch`, opened by no task of its own (`k.pr` makes one: it is dropped). */
function openPr(k: Kit, n: number, branch: string, extra: Parameters<Kit["pr"]>[3] = {}): void {
  k.pr(n, branch, { [`${n}.md`]: `${n}\n` }, extra);
  k.host.tasks.delete(`T${n}`);
}

/** `n` passes of the train, a minute apart. */
async function passes(k: Kit, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    k.clock.ms += 61_000;
    await k.train.step(REPO);
  }
}

const changesOf = (k: Kit, n: number) => k.train.records.list({ repo: REPO, limit: 50 }).filter((c) => c.prNumber === n);

test("a writer's PR from any branch of its own prefix goes on the train as its task's, once", async () => {
  const k = await writer();
  openPr(k, 8, "fleetd/T7-mcp-skip-unreachable");
  openPr(k, 9, "fleetd/T7-pricing-2");
  openPr(k, 10, "fleetd/T7-4");
  await passes(k, 3);
  for (const n of [8, 9, 10]) {
    expect(changesOf(k, n).map((c) => [c.taskId, c.workstreamId])).toEqual([["T7", "W1"]]);
  }
  expect(changesOf(k, 7)).toHaveLength(1);
});

test("a person's branch, another task's lookalike branch and a fork's branch stay off the train", async () => {
  const k = await writer();
  openPr(k, 8, "sam/pricing-fix");
  openPr(k, 9, "fleetd/T70-pricing");
  openPr(k, 10, "fleetd/T7pricing");
  openPr(k, 11, "fleetd/T7-from-a-fork", { headRepo: "someone/storefront" });
  await passes(k, 3);
  for (const n of [8, 9, 10, 11]) expect(changesOf(k, n)).toEqual([]);
  // A fork's PR is never offered, so the lead hears no refusal of it.
  expect(k.host.wakes.filter((w) => w.includes("/pull/11"))).toEqual([]);
});

test("a writer's PR opened after its result went on the train is taken too, once", async () => {
  const k = await writer();
  k.host.tasks.get("T7")!.state = "done";
  await passes(k, 2);
  openPr(k, 8, "fleetd/T7-cloud-pin");
  await k.train.writerOpenedPr(PROJECT);
  await passes(k, 3);
  expect(changesOf(k, 8).map((c) => c.taskId)).toEqual(["T7"]);
});

test("a writer's PR in a repo of the bot with no train yet goes on the train when the writer opens it", async () => {
  const k = new Kit();
  kits.push(k);
  k.host.githubRepos = () => [[REPO, PROJECT]];
  openPr(k, 5, "fleetd/T7-pricing");
  openPr(k, 8, "fleetd/T7-mcp-skip");
  k.host.tasks.set("T7", { taskId: "T7", projectRef: PROJECT, workstreamId: "W1", kind: "write", state: "running" });
  k.host.branches.set("T7", "fleetd/T7-pricing");
  expect(k.train.records.train(REPO)).toBeUndefined();
  await k.train.writerOpenedPr(PROJECT);
  for (const n of [5, 8]) expect(changesOf(k, n).map((c) => c.taskId)).toEqual(["T7"]);
  await k.train.writerOpenedPr(PROJECT);
  await passes(k, 2);
  for (const n of [5, 8]) expect(changesOf(k, n)).toHaveLength(1);
});

// On 2026-11-23 #742 (`…-flaky-3`, 05:24:45) and #743 (`…-failing-3`, 05:29:21) opened while the cloud's train waited
// on CI of the PR ahead of them: a pass waits there for minutes, and its ready pass ran only before it, so neither was
// taken until its writer's end put its result's PR on, with no slice line.
test("a writer's PR opened while the train waits on another PR's CI goes on the train during that wait", async () => {
  let during: (() => void) | undefined;
  const k: Kit = new Kit({
    sleep: async (ms) => {
      k.clock.ms += ms;
      during?.();
      await Bun.sleep(0);
    },
  });
  kits.push(k);
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  k.host.tasks.get("T7")!.state = "done";
  k.host.branches.set("T7", "fleetd/T7-pricing");
  let done = false;
  k.gh.runs = () => [{ id: 1, name: "ci", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null }];
  await k.enqueue(7);
  let opened = false;
  let sevenWhenTaken: string | undefined;
  let sleeps = 0;
  during = () => {
    if (k.change(7).state !== "ci") return;
    sleeps++;
    if (!opened) {
      opened = true;
      // The writer, ended already, opens its third PR: its `gh pr create` tells the train.
      openPr(k, 8, "fleetd/T7-pricing-3");
      void k.train.writerOpenedPr(PROJECT);
    } else if (sevenWhenTaken === undefined && changesOf(k, 8).length > 0) sevenWhenTaken = k.change(7).state;
    if (sevenWhenTaken !== undefined || sleeps > 30) done = true;
  };
  await k.train.step(REPO);
  expect(opened).toBe(true);
  expect(sevenWhenTaken).toBe("ci");
  expect(changesOf(k, 8).map((c) => [c.taskId, c.workstreamId])).toEqual([["T7", "W1"]]);
});

test("a ready pass that throws while the train waits on CI is logged, and the wait goes on to the merge", async () => {
  let during: (() => void) | undefined;
  const k: Kit = new Kit({
    sleep: async (ms) => {
      k.clock.ms += ms;
      during?.();
      await Bun.sleep(0);
    },
  });
  kits.push(k);
  k.pr(7, "fleetd/T7-pricing", { "pricing.md": "pricing\n" });
  k.host.branches.set("T7", "fleetd/T7-pricing");
  let done = false;
  k.gh.runs = () => [{ id: 1, name: "ci", status: done ? "completed" : "in_progress", conclusion: done ? "success" : null }];
  await k.enqueue(7);
  let thrown = 0;
  let sleeps = 0;
  during = () => {
    if (k.change(7).state !== "ci") return;
    // From the first poll in CI, the writers can't be read: every ready pass there throws.
    k.host.writers = () => {
      thrown++;
      throw new Error("writers unread");
    };
    void k.train.writerOpenedPr(PROJECT);
    if (++sleeps > 5) done = true;
  };
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await k.train.step(REPO);
  } finally {
    console.warn = warn;
  }
  expect(thrown).toBeGreaterThan(1);
  expect(k.change(7).state).toBe("merged");
  expect(lines.filter((l) => l.includes(`ready pass of ${REPO} in CI failed: Error: writers unread`))).toHaveLength(1);
});
