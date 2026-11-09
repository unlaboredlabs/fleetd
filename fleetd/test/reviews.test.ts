// The review gate over the train kit (crates/fleetd/src/hub/reviews tests): one fresh reviewer per patch, verdicts
// bound to the patch they reviewed, blocking findings back to the author, a reviewer ending without a verdict asked
// once then replaced, tools failing not counted against the retries, and findings the lead resolved.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { withReviews } from "../src/hub/reviews/service.ts";
import { compare } from "../src/hub/reviews/rebase.ts";
import { gate, reviewTitle, toolsFailed } from "../src/hub/reviews/rules.ts";
import { Kit, PROJECT } from "./train_kit.ts";

// The train's kit merges and pushes through a real git origin, a git process each: a loaded machine (CI, or a busy
// devbox) takes longer than bun's 5 s default.
setDefaultTimeout(30_000);

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});

function lab() {
  const k = new Kit();
  kits.push(k);
  const reviews = withReviews(k.train, k.host);
  /** The reviewer records a verdict on the head it reviewed: the row `fleetd review verdict` writes, and its event. */
  const verdict = async (taskId: string, sha: string, blocking: number, summary = "looks fine") => {
    k.db.conn
      .query("INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES (?, NULL, ?, ?, 0, ?)")
      .run(taskId, sha, blocking, JSON.stringify({ taskId, prHeadSha: sha, blocking, nonBlocking: 1, summary }));
    await reviews.handle({ seq: 0, eventType: "review.verdict", data: { taskId, prHeadSha: sha, blocking, nonBlocking: 1 } });
  };
  const ended = async (taskId: string, tail: string, how = "completed") => {
    const t = k.host.tasks.get(taskId)!;
    t.state = how === "completed" ? "done" : how;
    t.resultTail = tail;
    await reviews.handle({ seq: 0, eventType: `task.${how}`, data: { taskId } });
  };
  return { k, reviews, verdict, ended };
}

test("a fresh reviewer per patch; its clean verdict makes the Change ready, and the train merges it", async () => {
  const { k, verdict } = lab();
  k.pr(7, "fleetd/T7-a", { "a.md": "a\n" });
  const change = await k.enqueue(7);
  expect(change.state).toBe("reviewing");
  expect(k.host.spawns.map((s) => [s.title, s.by, s.pr])).toEqual([["Checking: PR 7", "hub:reviews", "https://github.com/acme/storefront/pull/7"]]);
  expect(k.host.spawns[0]!.prompt).toContain(change.headSha);
  // The same head again starts no second reviewer.
  await k.train.step("acme/storefront");
  expect(k.host.spawns.length).toBe(1);
  await verdict("T50", change.headSha, 0);
  expect(k.change(7)).toMatchObject({ state: "ready", reviews: [{ taskId: "T50", blocking: 0, patchId: change.patchId }] });
  await k.settle();
  expect(k.change(7).state).toBe("merged");
});

test("blocking findings go back to the author, and the Change waits for a new head, which gets a new reviewer", async () => {
  const { k, verdict, reviews } = lab();
  k.pr(8, "fleetd/T8-a", { "a.md": "a\n" });
  const change = await k.enqueue(8);
  await verdict("T50", change.headSha, 2, "a.md:1 leaks the key");
  const held = k.change(8);
  expect(held.state).toBe("reviewing");
  expect(held.lastError).toBe(`waiting for a new head: T50 found 2 blocking at ${change.headSha.slice(0, 12)}; sent to T8`);
  const [to, text] = k.host.sends.at(-1)!;
  expect(to).toBe("T8");
  expect(text).toContain("review T50 at");
  expect(text).toContain("found 2 blocking findings (1 non-blocking)");
  expect(text).toContain("a.md:1 leaks the key");
  expect((await reviews.again(held)).kind).toBe("blocked");
  // The author pushes a fix: a new patch, a new reviewer; the old one counts no more.
  k.pr(8, "fleetd/T8-a", { "b.md": "b\n" });
  await k.settle();
  expect(k.host.spawns.length).toBe(2);
  const moved = k.change(8);
  expect(moved.headSha).not.toBe(change.headSha);
  await verdict("T51", moved.headSha, 0);
  await k.settle();
  expect(k.change(8).state).toBe("merged");
});

test("a reviewer that ends without a verdict is asked once, then replaced, and the lead hears; then no more", async () => {
  const { k, ended } = lab();
  k.pr(9, "fleetd/T9-a", { "a.md": "a\n" });
  await k.enqueue(9);
  await ended("T50", "I approve this PR.");
  // Asked once in its own thread to finish and report.
  expect(k.host.sends.at(-1)![0]).toBe("T50");
  expect(k.change(9).lastError).toContain('asked it once to finish and report');
  await ended("T50", "Approved, no issues.");
  expect(k.host.spawns.length).toBe(2);
  expect(k.change(9).lastError).toContain("T51 reviews it again (retry 1 of 1)");
  expect(k.host.wakes.at(-1)).toContain("verdict not recorded: the reviewer T50 ended without one");
  // The second asked once, then ends again: no third reviewer, the lead hears it stalled.
  await ended("T51", "lgtm");
  await ended("T51", "lgtm");
  expect(k.host.spawns.length).toBe(2);
  expect(k.host.wakes.at(-1)).toContain("2 reviewers in a row ended without one, the last T51");
  expect(k.change(9).state).toBe("reviewing");
});

test("a reviewer whose fleetd tools failed is not a retry: the next starts after a wait or once any verdict is recorded", async () => {
  const { k, ended, verdict } = lab();
  k.pr(10, "fleetd/T10-a", { "a.md": "a\n" });
  k.pr(11, "fleetd/T11-b", { "b.md": "b\n" });
  await k.enqueue(10);
  await ended("T50", "The fleetd MCP server is not connected, so I could not record the verdict.", "failed");
  expect(k.change(10).lastError).toStartWith("review tools failed: the reviewer T50 couldn't use fleetd's tools");
  expect(k.host.wakes.at(-1)).toContain("couldn't use fleetd's tools to record a verdict");
  await k.train.step("acme/storefront");
  expect(k.host.spawns.length).toBe(1);
  // Another review recording a verdict shows the tools work again: the next reviewer starts at once.
  const other = await k.enqueue(11);
  k.clock.ms += 1000;
  await verdict("T51", other.headSha, 0);
  await k.train.step("acme/storefront");
  expect(k.host.spawns.length).toBe(3);
  expect(k.change(10).lastError).toContain("another review recorded a verdict since, so the tools work again: T52 reviews it now");
});

test("findings the lead resolved without a new patch count no more, and a fresh full review of the patch starts", async () => {
  const { k, verdict } = lab();
  k.pr(12, "fleetd/T12-a", { "a.md": "a\n" });
  const change = await k.enqueue(12);
  await verdict("T50", change.headSha, 1);
  // The lead narrows the brief and enqueues it again.
  const again = await k.train.enqueue(PROJECT, { prUrl: change.prUrl });
  expect(again.lastError).toStartWith("enqueued again while its review's findings blocked it");
  expect(k.host.spawns.length).toBe(2);
  await verdict("T51", change.headSha, 0);
  expect(k.change(12).state).toBe("ready");
});

test("the gate's pure rules", () => {
  expect(gate("p", [{ taskId: "T1", patchId: "p", blocking: 0 }])).toMatchObject({ ready: true });
  expect(gate("p", [{ taskId: "T1", patchId: "p", blocking: 0 }, { taskId: "T2", patchId: "p", blocking: 1 }])).toMatchObject({ ready: false, waitingForHead: true });
  expect(gate("p", [{ taskId: "T1", patchId: "q", blocking: 0 }])).toMatchObject({ ready: false, waitingForHead: false });
  expect(reviewTitle("Add pricing (W41) [D128, T7]", 7)).toBe("Checking: Add pricing");
  expect(reviewTitle(undefined, 7)).toBe("Checking PR #7");
  expect(toolsFailed("the MCP server failed to start")).toBe(true);
  expect(toolsFailed("I could not record my verdict")).toBe(true);
  expect(toolsFailed("spawn ENOENT")).toBe(true);
  expect(toolsFailed("Two findings: a.rs:3 leaks the key")).toBe(false);
});

test("a rebase that moved the approved lines alone carries the approval; one that changed them doesn't", () => {
  const patch = (start: number, lines: string) => `diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -${start},1 +${start},2 @@\n ctx\n${lines}`;
  const approved = patch(10, "+mine\n");
  expect(compare(approved, patch(12, "+mine\n"), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,0 +1,2 @@\n+x\n+y\n").kind).toBe("unchanged");
  expect(compare(approved, patch(10, "+changed\n"), "").kind).toBe("changed");
});
