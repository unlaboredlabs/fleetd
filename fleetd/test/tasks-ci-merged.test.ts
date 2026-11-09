// wait_ci with `merged` (W520): a PR's wait wakes its task when the PR
// merges, fails on the train or closes, read from the merge train; its checks finishing doesn't.
import { expect, test } from "bun:test";
import { type CiReads, type Merge, mergeOf, pollCiWaits, type Read, type Target, targetUrl } from "../src/hub/tasks/ci_wait.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { P, tasksKit, until } from "./tasks-kit.ts";

const PR = "https://github.com/acme/shop/pull/7";
const PR2 = "https://github.com/acme/shop/pull/8";
const RUN = "https://github.com/acme/shop/actions/runs/42";
const LATER = "2026-10-19T11:00:00.000Z";

/** GitHub as the test sets it: each target's read, running until set; each PR's way to merging, pending until set. */
class Reads implements CiReads {
  reads = new Map<string, Read>();
  merges = new Map<string, Merge>();
  read = async (t: Target) => this.reads.get(targetUrl(t)) ?? { kind: "running" };
  merge = async (_: ProjectRef, t: Target) => this.merges.get(targetUrl(t)) ?? { kind: "pending" };
}

/** T1, a writer that ended its turn waiting, in a project whose repo is acme/shop. */
async function ended() {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("build on the seam");
  k.threadRow("s1", "completed", "Waiting on #7 and #8 to merge.");
  k.thread("thread.completed", "s1", { runId: "r1" });
  await until(() => k.t.get("T1")?.state === "done");
  k.hub.db.conn
    .query(
      "INSERT INTO repos (machine_id, project_id, checkout_machine_id, checkout_project_id, name, repo_key) VALUES ('lab-a', 'p1', 'lab-a', 'p1', 'shop', 'github.com/acme/shop')",
    )
    .run();
  const agent = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "task" as const, taskId: "T1" } };
  const waitMerged = (url: string) => leadCall(k.hub, k.t, agent, { op: "wait_ci", url, merged: true });
  const poll = (reads: Reads) => pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads);
  const sent = () => {
    const out = k.ports.sends.map((s) => s.message);
    k.ports.sends = [];
    return out;
  };
  return { ...k, waitMerged, poll, sent };
}

test("an ended task waiting on two PRs to merge is woken as they merge", async () => {
  const k = await ended();
  const asked = await k.waitMerged(`${PR}/files`);
  expect(asked.url).toBe(PR);
  expect(String(asked.next)).toContain("when the PR merges");
  await k.waitMerged(PR2);
  const reads = new Reads();
  const green: Read = { kind: "finished", label: "3f9c2ab", failing: [], total: 12 };
  reads.reads.set(PR, green);
  reads.reads.set(PR2, green);
  expect(await k.poll(reads)).toBe(0);
  expect(k.sent()).toEqual([]);
  reads.merges.set(PR, { kind: "merged" });
  expect(await k.poll(reads)).toBe(1);
  reads.merges.set(PR2, { kind: "merged" });
  expect(await k.poll(reads)).toBe(1);
  expect(k.sent()).toEqual([
    `A PR you waited on to merge (wait_ci merged) has merged: ${PR}.`,
    `A PR you waited on to merge (wait_ci merged) has merged: ${PR2}.`,
  ]);
  expect(await k.poll(reads)).toBe(0);
  k.hub.shutdown.abort();
});

test("a merge wait wakes early when its PR closes unmerged or fails on the train", async () => {
  const k = await ended();
  await k.waitMerged(PR);
  await k.waitMerged(PR2);
  const reads = new Reads();
  reads.merges.set(PR2, { kind: "over", why: "it was closed without merging" });
  expect(await k.poll(reads)).toBe(1);
  expect(k.sent()).toEqual([
    `A PR you waited on to merge (wait_ci merged) won't merge: ${PR2}: it was closed without merging. Ask your lead what to build on instead.`,
  ]);
  expect(await k.poll(reads)).toBe(0);
  reads.merges.set(PR, { kind: "failed", why: "its CI failed" });
  expect(await k.poll(reads)).toBe(1);
  const woke = k.sent();
  expect(woke.length).toBe(1);
  expect(woke[0]?.startsWith(`A PR you waited on to merge (wait_ci merged) failed on the merge train: ${PR}: its CI failed.`)).toBe(true);
  expect(await k.poll(reads)).toBe(0);
  // Asked again while it still fails, it isn't told again.
  await k.waitMerged(PR);
  expect(await k.poll(reads)).toBe(0);
  reads.merges.set(PR, { kind: "pending" });
  expect(await k.poll(reads)).toBe(0);
  reads.merges.set(PR, { kind: "failed", why: "its CI failed" });
  expect(await k.poll(reads)).toBe(1);
  reads.merges.set(PR, { kind: "merged" });
  expect(await k.poll(reads)).toBe(1);
  expect(k.sent().length).toBe(2);
  expect(await k.poll(reads)).toBe(0);
  k.hub.shutdown.abort();
});

test("the hub's merge read is the train's: merged there is merged, a hold's failure is a failure", async () => {
  const held = new Map([[PR2, { note: "held: waiting on acme/shop#8: its CI failed", failed: true }]]);
  const train = { seesPr: (_: ProjectRef, url: string) => !url.endsWith("/9"), upstream: async (url: string) => held.get(url) };
  const merge = (url: string) => mergeOf(train, P, { kind: "pr", repo: "acme/shop", number: Number(url.split("/").at(-1)) });
  expect(await merge(PR)).toEqual({ kind: "merged" });
  expect(await merge(PR2)).toEqual({ kind: "failed", why: "its CI failed" });
  held.set(PR2, { note: "held: waiting on acme/shop#8: it was closed without merging", failed: true });
  expect(await merge(PR2)).toEqual({ kind: "over", why: "it was closed without merging" });
  held.set(PR2, { note: "held: waiting on acme/shop#8: in the train's line", failed: false });
  expect(await merge(PR2)).toEqual({ kind: "pending" });
  expect(await merge("https://github.com/acme/shop/pull/9")).toEqual({ kind: "over", why: "it is in a project you don't see" });
  // Until the train sets its reads, a merge wait waits.
  expect(await mergeOf(undefined, P, { kind: "pr", repo: "acme/shop", number: 7 })).toEqual({ kind: "pending" });
});

test("merged takes only a PR, and the lead's digest says a done task waits on one merging", async () => {
  const k = await ended();
  await expect(Promise.resolve().then(() => k.waitMerged(RUN))).rejects.toThrow("only a PR merges");
  await k.waitMerged(PR);
  expect(k.t.digestLines(P, LATER, 10)).toEqual([
    `- T1 done: build on the seam; waits on CI, and wait_ci wakes it as each ends: ${PR} (until it merges)`,
  ]);
  k.hub.shutdown.abort();
});

test("a merge read that fails leaves the wait for the next pass, and the poll goes on", async () => {
  const k = await ended();
  await k.waitMerged(PR);
  const reads = new Reads();
  reads.merge = async () => {
    throw new Error("database is locked");
  };
  expect(await k.poll(reads)).toBe(0);
  const healthy = new Reads();
  healthy.merges.set(PR, { kind: "merged" });
  expect(await k.poll(healthy)).toBe(1);
  k.hub.shutdown.abort();
});
