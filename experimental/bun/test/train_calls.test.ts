// The train's and the reviews' lead calls through the hub's lead-call registry (train/calls.rs, serve/wire.rs
// `CheckCalls`): `change_enqueue`, `review_verdict` and `review_read`, and the train's project_get field.
import { afterEach, expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { executorHooks } from "../src/hub/executor/hooks.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { withReviews } from "../src/hub/reviews/service.ts";
import { registerLeadCalls } from "../src/hub/train/calls.ts";
import { HubHost } from "../src/hub/train/hub_host.ts";
import { start } from "../src/hub/train/loops.ts";
import { ToolError } from "../src/shared/errors.ts";
import { Kit, PROJECT, REPO } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});

/** A hub whose train runs over the kit's fake GitHub and host. */
function lab() {
  const k = new Kit();
  kits.push(k);
  const hub = new Hub({ home: k.dir, listen: { host: "127.0.0.1", port: 0 } }, k.db, k.clock);
  const reviews = withReviews(k.train, k.host);
  hub.area("merge_train", () => ({ train: k.train, reviews, host: new HubHost(hub) }));
  // The verdicts read tasks from the hub's table.
  const task = (id: string, kind: string, pr?: string) =>
    k.db.conn
      .query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, 'W1', 'running', ?)")
      .run(Number(id.slice(1)), PROJECT.machineId, PROJECT.projectId, JSON.stringify({ taskId: id, projectRef: PROJECT, workstreamId: "W1", kind, state: "running", title: "t", ...(pr ? { pr } : {}) }));
  return { k, hub, reviews, task };
}

const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/storefront", agent: { kind: "lead" } };

test("change_enqueue puts the PR on the train and says what the lead does next; a refusal is the call's error", async () => {
  const { k, hub } = lab();
  registerLeadCalls(hub);
  const url = k.pr(7, "fleetd/T7-a", { "a.md": "a\n" });
  const handler = leadCalls(hub).handler("change_enqueue")!;
  const out = (await handler(lead, { op: "change_enqueue", prUrl: url, taskId: "T7" })) as { change: { changeId: string; state: string }; next: string };
  expect(out.change).toMatchObject({ changeId: "X1", state: "reviewing" });
  expect(out.next).toBe("don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.");
  const refused = await Promise.resolve(handler(lead, { op: "change_enqueue", prUrl: "https://github.com/acme/storefront/pull/99", taskId: "T99" })).catch((e) => e);
  expect(refused).toBeInstanceOf(ToolError);
  expect((refused as ToolError).code).toBe("not_found");
  const bad = await Promise.resolve(handler(lead, { op: "change_enqueue", prUrl: "nope" })).catch((e) => e);
  expect((bad as ToolError).code).toBe("invalid");
});

test("review_verdict records a reviewer's own verdict and review_read reads it back, whole", async () => {
  const { k, hub, task } = lab();
  registerLeadCalls(hub);
  const url = k.pr(8, "fleetd/T8-a", { "a.md": "a\n" });
  task("T60", "review", url);
  const sha = "c".repeat(40);
  const reviewer: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/storefront", agent: { kind: "task", taskId: "T60" } };
  const recorded = (await leadCalls(hub).handler("review_verdict")!(reviewer, {
    op: "review_verdict",
    prHeadSha: sha,
    blocking: 1,
    nonBlocking: 2,
    summary: "a.md:1 leaks GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  })) as { verdict: Record<string, unknown>; next: string };
  expect(recorded.verdict).toEqual({ taskId: "T60", prHeadSha: sha, blocking: 1, nonBlocking: 2, summary: "a.md:1 leaks GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  expect(recorded.next).toContain("listing each blocking finding");
  const event = k.db.conn.query<{ data: string }, []>("SELECT data FROM events WHERE type = 'review.verdict'").get()!;
  expect(JSON.parse(event.data)).toMatchObject({ type: "review.verdict", data: { taskId: "T60", pr: url, blocking: 1 } });
  const read = (await leadCalls(hub).handler("review_read")!(reviewer, { op: "review_read" })) as { prs: { pr: string; reviews: { findings: string }[] }[] };
  expect(read.prs.map((p) => p.pr)).toEqual([url]);
  expect(read.prs[0]!.reviews[0]!.findings).toBe("a.md:1 leaks GH_TOKEN=[secret]");
  // Another task's verdict is not this one's to record.
  const other = await Promise.resolve(
    leadCalls(hub).handler("review_verdict")!(reviewer, { op: "review_verdict", taskId: "T61", blocking: 0, nonBlocking: 0, summary: "x" }),
  ).catch((e) => e);
  expect((other as ToolError).message).toBe("You are T60, so you record only your own verdict, not T61's.");
});

test("start wires the lead calls and the project's trains into project_get", async () => {
  const { k, hub } = lab();
  start(hub);
  k.train.stop();
  k.pr(9, "fleetd/T9-a", { "a.md": "a\n" }, { labels: ["hold"] });
  await k.enqueue(9);
  expect(leadCalls(hub).handler("change_enqueue")).toBeDefined();
  const extras = await Promise.all(executorHooks(hub).project.map((h) => h(hub, PROJECT)));
  expect(extras.map((e) => e.fields)).toContainEqual({ trains: [{ repo: REPO, queue: ["X1"] }] });
});

test("the hub's host fails gracefully while Tasks and the intake aren't in the hub", async () => {
  const { hub } = lab();
  const host = new HubHost(hub);
  await expect(host.messageTask(PROJECT, "hub:train", "T1", "hi")).rejects.toThrow("Tasks is not ported to Bun yet");
  await expect(host.openOrder(PROJECT, "fix", "r1")).rejects.toThrow("the order intake is not ported to Bun yet");
  expect(await host.branchPrefix(PROJECT)).toBe("fleetd/");
  expect(host.landingsWatched(REPO, "main")).toBe(false);
  // With the owners' areas made, the host goes through them.
  const sent: string[] = [];
  hub.area("tasks", () => ({ message: async (_c: unknown, id: string, text: string) => sent.push(`${id}: ${text}`), spawn: async () => ({}), cancel: async () => ({}) }));
  hub.area("policy", () => ({ branchPrefix: () => "slot/1/fleetd/" }));
  await host.messageTask(PROJECT, "hub:train", "T1", "hi");
  expect(sent).toEqual(["T1: hi"]);
  expect(await host.branchPrefix(PROJECT)).toBe("slot/1/fleetd/");
});

test("a writer's command that prints its PR URL starts the train's ready pass at once", async () => {
  const { k, hub } = lab();
  start(hub);
  k.train.stop();
  const { namesAPr } = await import("../src/hub/executor/index.ts");
  expect(namesAPr({ status: "completed", kind: { type: "command", output: "https://github.com/acme/storefront/pull/9\n" } })).toBe(true);
  expect(namesAPr({ status: "running", kind: { type: "command", output: "https://github.com/acme/storefront/pull/9" } })).toBe(false);
  expect(namesAPr({ status: "completed", kind: { type: "tool", output: "https://github.com/acme/storefront/pull/9" } })).toBe(false);
  k.db.conn
    .query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (31, ?, ?, 'W1', 'running', 's-31', ?)")
    .run(PROJECT.machineId, PROJECT.projectId, JSON.stringify({ taskId: "T31", projectRef: PROJECT, workstreamId: "W1", kind: "write", state: "running", title: "t" }));
  k.train.records.ensureTrain(REPO, PROJECT, k.clock.ms);
  k.train.lastReadyCheck.set(REPO, k.clock.ms);
  executorHooks(hub).foundPr({ machineId: PROJECT.machineId, threadId: "s-31" });
  expect(k.train.lastReadyCheck.has(REPO)).toBe(false);
});

test("the lead digest's merge train lines", async () => {
  const { trainDigest, trainUnlanded } = await import("../src/hub/train/index.ts");
  const { k, hub } = lab();
  expect(trainDigest(hub, PROJECT)).toBeUndefined();
  k.pr(10, "fleetd/T10-a", { FAIL: "x\n" });
  k.train.gate = new (await import("./train_kit.ts")).CleanGate();
  await k.enqueue(10);
  await k.settle();
  const lines = trainDigest(hub, PROJECT, "2026-10-17T09:00:00.000Z")!;
  expect(lines[0]).toBe(`- ${REPO}: queue empty`);
  expect(lines[1]).toStartWith(`- X1 ci_failed: ${REPO}#10, by T10; CI failed on `);
  expect(lines[1]).toEndWith("Back with its author; the train retries its next push");
  expect(trainUnlanded(hub, PROJECT, "W1")).toEqual(["#10 ci_failed"]);
});

test("a stopped order's PRs leave the train through the chat area's stop hooks", async () => {
  const { k, hub } = lab();
  const stops: { takeLeftovers?: (r: typeof PROJECT, w: string, why: string) => number[] } = {};
  hub.area("chat_stop_hooks", () => stops);
  start(hub);
  k.train.stop();
  k.pr(11, "fleetd/T11-a", { "a.md": "a\n" }, { labels: ["hold"] });
  await k.enqueue(11);
  expect(stops.takeLeftovers!(PROJECT, "W1", "its order was stopped")).toEqual([11]);
  expect(k.change(11)).toMatchObject({ state: "abandoned", lastError: "its order was stopped" });
});
