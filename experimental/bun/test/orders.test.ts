// The board join (crates/fleetd/src/hub/orders/tests.rs and phase.rs's tests), and orders_board, order_get and
// agents_list over a hub's rows.
import { expect, test } from "bun:test";
import { card, type Lookups, parkedReason, shortTitle, trainLive } from "../src/hub/orders/index.ts";
import { leadLaneStatus, phase, role } from "../src/hub/orders/phase.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import type { Change, Task, UsageParked, Workstream } from "../src/shared/contracts.ts";
import { key, kit, project, workstream as storedWorkstream } from "./work-kit.ts";

const AT = "2026-10-18T10:00:00.000Z";

const fake = (threads: Record<string, string>): Lookups => ({
  thread: (r) => (threads[r.threadId] ? { status: threads[r.threadId]! } : undefined),
  live: () => undefined,
  leadProfile: () => "high",
});

const workstream = (): Workstream =>
  ({
    workstreamId: "W14",
    projectRef: { machineId: "lab-a", projectId: "p1" },
    title: "Three pages",
    source: { text: "Three pages", channel: "app", by: "human", at: AT },
    state: "open",
    headline: "waiting on reviews",
    brief: { goal: "g", why: "w", pointers: [], constraints: [], doneWhen: ["the pages ship"] },
    createdAt: AT,
    updatedAt: AT,
  }) as unknown as Workstream;

const task = (id: string, kind: string, state: string, extra: Record<string, unknown> = {}): Task => {
  const t: Record<string, unknown> = {
    taskId: id,
    projectRef: { machineId: "lab-a", projectId: "p1" },
    workstreamId: "W14",
    title: `${id} work`,
    kind,
    prompt: "do it",
    state,
    attempt: 1,
    createdAt: AT,
    startedAt: `2026-10-18T10:0${id[1]}:00.000Z`,
    threadRef: { machineId: "lab-a", threadId: `s-${id}` },
    ...extra,
  };
  for (const [k, v] of Object.entries(t)) if (v === null) delete t[k];
  return t as unknown as Task;
};

const change = (id: string, number: number, taskId: string, state: string, extra: Partial<Change> = {}): Change => {
  const sha = "b".repeat(40);
  const patch = "c".repeat(40);
  return {
    changeId: id,
    projectRef: { machineId: "lab-a", projectId: "p1" },
    repo: "o/testbed",
    prNumber: number,
    prUrl: `https://github.com/o/testbed/pull/${number}`,
    branch: `fleetd/${taskId}`,
    taskId,
    workstreamId: "W14",
    headSha: sha,
    patchId: patch,
    state,
    createdAt: AT,
    updatedAt: AT,
    reviews: [
      { taskId: "T5", prHeadSha: sha, patchId: patch, blocking: 0, nonBlocking: 1 },
      { taskId: "T6", prHeadSha: sha, patchId: "d".repeat(40), blocking: 0, nonBlocking: 0 },
      { taskId: "T7", prHeadSha: sha, patchId: patch, blocking: 2, nonBlocking: 0 },
    ],
    ...extra,
  } as unknown as Change;
};

test("an order joins its agents, PRs and asks", () => {
  const reviewPr = { pr: "https://github.com/o/testbed/pull/12", qa: false };
  const tasks = [
    task("T1", "write", "done", { endedAt: "2026-10-18T10:05:00.000Z" }),
    task("T2", "write", "running"),
    task("T3", "review", "running", reviewPr),
    task("T4", "review", "queued", { pr: "https://github.com/o/testbed/pull/12", queuedReason: "fleet cap: 40 of 40 running", threadRef: null }),
    task("T5", "review", "running", { pr: "https://github.com/o/testbed/pull/12", qa: true }),
  ];
  const joined = card(
    { workstream: workstream(), tasks, changes: [change("X2", 12, "T1", "reviewing")], openRequests: 0, leadWorking: true },
    fake({ "s-T2": "running", "s-T3": "waiting", "s-T5": "running" }),
  );
  const c = joined.card;
  // T3 waits on a permission: the order needs you even with no open request.
  expect([c.phase, c.phaseDetail]).toEqual(["waiting_on_you", "1 approval"]);
  expect([c.settled, c.total, c.next]).toEqual([1, 5, "waiting on reviews"]);
  // Active lanes only, newest first.
  expect(c.lanes.map((l) => [l.laneId, l.role, l.status])).toEqual([
    ["T5", "qa", "working"],
    ["T4", "reviewer", "queued"],
    ["T3", "reviewer", "waiting"],
    ["T2", "implementer", "working"],
  ]);
  const t4 = c.lanes.find((l) => l.laneId === "T4")!;
  expect(t4.statusReason).toBe("fleet cap: 40 of 40 running");
  expect(t4.pr?.number).toBe(12);
  expect(c.lanes.map((l) => l.title)).toEqual(["QA #12", "review #12", "review #12", "T2 work"]);
  expect(joined.done.length).toBe(1);
  expect(joined.done[0]?.pr?.number).toBe(12);
  // One clean review of the current patch: T6 reviewed an older patch, T7 found blocking issues.
  expect([c.prs[0]?.reviewsDone, c.prs[0]?.reviewsNeeded, c.prs[0]?.state]).toEqual([1, 1, "reviewing"]);
});

test("trains list the head, then the queue, then today's merges", () => {
  const train = trainLive(
    "o/testbed",
    [
      change("X3", 13, "T3", "queued", { position: 1 }),
      change("X4", 9, "T4", "merged", { updatedAt: "2026-10-18T09:00:00.000Z" }),
      change("X1", 10, "T1", "ci", { updatedAt: "2026-10-18T10:03:00.000Z" }),
      change("X5", 8, "T5", "merged", { updatedAt: "2026-10-17T23:00:00.000Z" }),
      change("X2", 12, "T2", "reviewing", { position: 0 }),
    ],
    "2026-10-18T00:00:00.000Z",
  );
  expect(train.chips.map((c) => c.number)).toEqual([10, 12, 13, 9]);
  expect(train.mergedToday).toBe(1);
});

test("cards get a short title", () => {
  const w = { ...workstream() } as Workstream;
  delete (w as { brief?: unknown }).brief;
  w.title =
    "Add three short pages, lab/20261018153639/alpha.md, beta.md and gamma.md, each one paragraph on what fleetd's merge train does. One writer per page.";
  expect(shortTitle(w)).toBe("Add three short pages, lab/20261018153639/alpha.md…");
  w.title = "@storefront fix: rounding of cart totals";
  expect(shortTitle(w)).toBe("rounding of cart totals");
  w.brief = { goal: "Three pages on the merge train. One per writer.", why: "demo", pointers: [], constraints: [], doneWhen: ["x"] } as never;
  expect(shortTitle(w)).toBe("Three pages on the merge train");
});

test("a parked lane says when it goes on, and asks for usage_resume only for a drained pool", () => {
  const since = "2026-10-25T22:40:38.000Z";
  const cases: [UsageParked, string][] = [
    [{ class: "usage_limit", since, resumeAt: "2026-10-26T03:00:00.000Z" }, "usage limit: resumes 03:00"],
    [{ class: "rate_limit", since, checkAt: "2026-10-25T22:41:38.000Z", proxy: true }, "rate-limited by your proxy: checking again at 22:41"],
    [{ class: "rate_limit", since }, "usage limit: checking again shortly"],
    [{ class: "pool_exhausted", since, proxy: true }, "usage limit: resumes on usage_resume"],
  ];
  for (const [p, want] of cases) expect(parkedReason(p)).toBe(want);
});

test("the worst child rolls up in table order, and closed orders say how they ended", () => {
  const busy: [never, never, string | undefined][] = [
    ["implementer", "working", undefined],
    ["reviewer", "working", undefined],
    ["reviewer", "queued", "fleet cap: 40 of 40 running"],
  ] as never;
  const pr = [{ state: "ci" as const, number: 208 }];
  const input = (lanes: unknown, prs: unknown = [], extra = {}) =>
    ({ state: "open", draft: false, openRequests: 0, lanes, prs, leadWorking: false, ...extra }) as Parameters<typeof phase>[0];
  expect(phase(input(busy, pr, { openRequests: 1 }))).toEqual(["waiting_on_you", "1 request"]);
  expect(phase(input([["implementer", "waiting"], ["implementer", "working"]]))[0]).toBe("waiting_on_you");
  expect(phase(input(busy, pr))).toEqual(["working", "1 working"]);
  expect(phase(input([["implementer", "done"], ["reviewer", "working"]], pr))).toEqual(["reviewing", "1 reviewing"]);
  const done = [["implementer", "done"], ["reviewer", "done"]];
  expect(phase(input(done, pr))).toEqual(["merging", "#208 in CI"]);
  expect(phase(input([["implementer", "queued", "slots: 4/4 in use"], ["reader", "done"]]))).toEqual(["queued", "queued: slots: 4/4 in use"]);
  expect(phase(input([], [], { leadWorking: true }))[0]).toBe("planning");
  expect(phase(input([], [], { draft: true }))[0]).toBe("planning");
  expect(phase(input(done))[0]).toBe("idle");
  const merged = [{ state: "merged", number: 211 }, { state: "merged", number: 212 }];
  expect(phase(input([], merged, { state: "done" }))).toEqual(["done", "2 PRs merged"]);
  expect(phase(input([], [], { state: "stopped" }))[0]).toBe("stopped");
  expect([role("write", false), role("read", false), role("review", false), role("review", true)]).toEqual(["implementer", "reader", "reviewer", "qa"]);
  expect(leadLaneStatus("idle", false, "running")).toBe("working");
  expect(leadLaneStatus("working", false, "waiting")).toBe("waiting");
  expect(leadLaneStatus("idle", false, "completed")).toBe("idle");
  expect(leadLaneStatus("working", true, "running")).toBe("parked");
  expect(leadLaneStatus("stopped", false, undefined)).toBe("cancelled");
});

test("orders_board, order_get and agents_list read the hub's rows", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r, { title: "App" });
  const w = storedWorkstream(k.hub, r, "fix: the cart totals");
  TaskRecords.create(k.hub.db.conn, { ...task("T1", "write", "queued", { threadRef: null, queuedReason: "slots: 4/4 in use" }), projectRef: r, workstreamId: w.workstreamId });
  k.hub.db.conn.run(
    "INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'app', 'lead-1', '2026-10-17T09:00:00.000Z', 1)",
  );
  const board = await k.ok(key("read"), "orders_board", {});
  expect(board.orders.map((o: { workstreamId: string; title: string; phase: string; phaseDetail: string }) => [o.workstreamId, o.title, o.phase, o.phaseDetail])).toEqual([
    [w.workstreamId, "the cart totals", "queued", "queued: slots: 4/4 in use"],
  ]);
  expect(board.trains).toEqual([]);
  expect((await k.ok(key("read", { machines: ["laptop"] }), "orders_board", {})).orders).toEqual([]);
  const got = await k.ok(key("read"), "order_get", { workstreamId: w.workstreamId });
  expect(got.order.total).toBe(1);
  expect(got.lead).toMatchObject({ laneId: "lead:devbox/app", role: "lead", title: "App lead", status: "starting", profile: "high" });
  expect([got.requests, got.decisions, got.steers, got.doneLanes]).toEqual([[], [], [], []]);
  expect(await k.refused(key("read"), "order_get", { workstreamId: "W99" })).toBe("not_found");
  const agents = await k.ok(key("read"), "agents_list", {});
  expect(agents.agents.map((a: { laneId: string; status: string; projectTitle: string }) => [a.laneId, a.status, a.projectTitle])).toEqual([
    ["lead:devbox/app", "starting", "App"],
    ["T1", "queued", "App"],
  ]);
});
