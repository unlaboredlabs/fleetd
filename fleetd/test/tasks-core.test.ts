// The tasks core (recovery, breaker, ci_wait and their tests): spawn, start,
// queue, end, recovery, PR lookups, message, cancel, caps and CI waits, against fake ports.
import { expect, test } from "bun:test";
import { sendRunId } from "../src/hub/executor/sessions.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import { slots } from "../src/hub/slots/index.ts";
import { events } from "../src/hub/store/events.ts";
import { pollCiWaits, summary, targetOf } from "../src/hub/tasks/ci_wait.ts";
import { leadCall } from "../src/hub/tasks/calls.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { PortError } from "../src/hub/tasks/ports.ts";
import { ToolError } from "../src/shared/errors.ts";
import type { HubEventType, Task } from "../src/shared/contracts.ts";
import { P, tasksKit, until } from "./tasks-kit.ts";

const typesOf = (k: ReturnType<typeof tasksKit>, type: HubEventType) => events(k.hub).page(0, [type]).events;

test("a writer starts on its own branch from the default branch, and says where it started", async () => {
  const k = tasksKit();
  const task = await k.spawn("Dark mode toggle");
  expect(task.state).toBe("running");
  expect(task.taskId).toBe("T1");
  expect(task.branch).toBe("fleetd/T1-dark-mode-toggle");
  expect(task.threadRef).toEqual({ machineId: "lab-a", threadId: "s1" });
  expect(task.base?.ref).toBe("origin/main");
  const [launch] = k.ports.launches;
  expect(launch?.machineId).toBe("lab-a");
  expect(launch?.request.worktree).toEqual({ baseRef: "main", branch: "fleetd/T1-dark-mode-toggle" });
  expect(launch?.request.title).toBe("T1: Dark mode toggle");
  expect(launch?.request.clientRequestId).toMatch(/^fleetd-task:T1:\d+:1$/);
  expect(launch?.request.prompt).toContain("Dark mode toggle, please");
  const [started] = typesOf(k, "task.started");
  expect(started?.summary).toBe("T1 started (high): Dark mode toggle; based on origin/main @abc1234 as of 10:00 UTC");
  // The board holds its slot from the grant on.
  expect(slots(k.hub).agents(P).running).toBe(1);
});

test("the policy's branch prefix names the branch, and a review runs detached on the default profile", async () => {
  const k = tasksKit();
  k.ports.policyFile = { branchPrefix: "bots/" };
  expect((await k.spawn("Fix it")).branch).toBe("bots/T1-fix-it");
  const review = await k.spawn("Review #3", "review", { pr: "https://github.com/acme/shop/pull/3", profile: "medium" });
  expect(review.profile).toBe("high");
  expect(k.ports.launches[1]?.request.worktree).toEqual({ baseRef: "main", pr: "https://github.com/acme/shop/pull/3" });
  expect(k.ports.launches[1]?.request.kind).toBe("review");
});

test("a spawn is refused for a closed order, an unknown profile, and past the fan-out", async () => {
  const k = tasksKit();
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof ToolError ? `${e.code}: ${e.message}` : String(e);
    }
    return "spawned";
  };
  expect(await refusal(k.t.spawn(k.lead, { workstreamId: "W9", title: "x", kind: "read", prompt: "x" }))).toBe(
    "not_found: No workstream W9 in this project.",
  );
  expect(await refusal(k.spawn("x", "read", { profile: "max" }))).toBe(
    "invalid: Not spawned: this project doesn't allow profile max; it allows high, medium.",
  );
  k.hub.db.conn.query("UPDATE workstreams SET data = json_set(data, '$.state', 'done') WHERE n = 1").run();
  expect(await refusal(k.spawn("x"))).toBe("invalid: Workstream W1 is done; tasks run only for open workstreams.");
});

test("a spawn while the machine is offline queues, and starts once it links", async () => {
  const k = tasksKit();
  k.ports.connected.clear();
  const task = await k.spawn("Offline work");
  expect(task.state).toBe("queued");
  expect(task.queuedReason).toBe("machine lab-a is offline");
  const [queued] = typesOf(k, "task.queued");
  expect((queued?.data as { queuedKind: string }).queuedKind).toBe("offline");
  k.ports.link("lab-a");
  await until(() => k.t.get("T1")?.state === "running");
  expect(k.ports.launches.length).toBe(1);
});

test("a failed launch fails the task with the node's words", async () => {
  const k = tasksKit();
  k.ports.launchErrors.push(new PortError(false, "the node refused"));
  const task = await k.spawn("Doomed");
  expect(task.state).toBe("failed");
  expect(task.result?.tail).toBe("fleetd could not start the task: the node refused");
  expect(typesOf(k, "task.failed")[0]?.summary).toBe("T1 failed to start: the node refused");
});

test("a run that completes ends the task done, wakes its lead, and finds its branch's PR on the host", async () => {
  const k = tasksKit();
  k.ports.branchPrAnswer = async () => "https://github.com/acme/shop/pull/12";
  void k.t.run();
  const task = await k.spawn("Dark mode");
  k.threadRow("s1", "completed", "All done: pushed.");
  k.thread("thread.completed", "s1", { runId: "r1", endCause: "completed" });
  await until(() => k.t.get("T1")?.state === "done");
  const done = k.t.get("T1") as Task;
  expect(done.result?.tail).toBe("All done: pushed.");
  expect(done.result?.branch).toBe(task.branch);
  expect(done.result?.endCause).toBe("completed");
  expect(k.ports.wakes[0]?.kind).toBe("task_result");
  expect(k.ports.wakes[0]?.text).toBe(`- T1 finished: Dark mode (branch ${task.branch})\n  > All done: pushed.`);
  await until(() => k.ports.prsFound.length === 1);
  expect(k.t.get("T1")?.result?.prUrl).toBe("https://github.com/acme/shop/pull/12");
  expect(k.ports.wakes[1]).toEqual({ r: P, kind: "quiet", text: "- T1's PR: https://github.com/acme/shop/pull/12" });
  expect(TaskRecords.prLookupPending(k.hub.db.conn, "T1")).toBe(false);
  expect(typesOf(k, "task.completed")[0]?.summary).toBe("T1 completed: Dark mode");
  k.hub.shutdown.abort();
});

test("an unread host falls back to a PR on the project's own remote in the report, never another repo's", async () => {
  const k = tasksKit();
  k.ports.branchPrAnswer = async () => {
    throw { kind: "unread", why: "502" };
  };
  void k.t.run();
  await k.spawn("Dark mode");
  k.threadRow("s1", "completed", "Opened https://github.com/acme/shop/pull/7; see also https://github.com/other/repo/pull/9");
  k.thread("thread.completed", "s1", { runId: "r1" });
  await until(() => k.ports.prsFound.length === 1);
  expect(k.t.get("T1")?.result?.prUrl).toBe("https://github.com/acme/shop/pull/7");
  k.hub.shutdown.abort();
});

test("a node stop resumes the task in its thread with the recover note; a second exit escalates", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("Long work");
  k.ports.runs.set("s1", "r1");
  k.thread("thread.interrupted", "s1", { runId: "r1", endCause: "node_stopping", error: { message: "the node stopped" } });
  await until(() => k.t.get("T1")?.state === "queued");
  const queued = k.t.get("T1") as Task;
  expect(queued.attempt).toBe(2);
  expect(queued.recovery?.lastCause).toBe("node_stopping");
  expect(queued.recovery?.lastCauseText).toBe("the node on lab-a stopped");
  expect(queued.recovery?.count).toBe(0);
  expect(queued.recovery?.nodeLost).toBe(1);
  expect(queued.queuedReason).toMatch(/^recovering: the node on lab-a stopped; resumes at \d\d:\d\d:\d\d UTC \(0 of 3 recoveries used\)$/);
  // Its lead's message while it waits resumes it now, in its own thread, with the note first.
  await k.t.message(k.lead, "T1", "and also this");
  await until(() => k.t.get("T1")?.state === "running");
  const sent = k.ports.sends.at(-1);
  expect(sent?.thread).toEqual({ machineId: "lab-a", threadId: "s1" });
  expect(sent?.message.endsWith("and also this")).toBe(true);
  expect(sent?.message).toContain("the node on lab-a stopped");
  expect(k.t.get("T1")?.recovery?.resumedAt).toBeDefined();
  // claude exits twice the same way: the second is not resumed.
  // The continued run is the one the send's request id names.
  const r2 = sendRunId({ machineId: "lab-a", threadId: "s1" }, k.ports.sends.at(-1)?.id as string);
  k.ports.runs.set("s1", r2);
  k.thread("thread.failed", "s1", { runId: r2, endCause: "exited", error: { class: "process_exited", message: "killed by signal 9" } });
  await until(() => k.t.get("T1")?.state === "queued" && (k.t.get("T1")?.recovery?.count ?? 0) > 0);
  await k.t.message(k.lead, "T1", "go on");
  await until(() => k.t.get("T1")?.state === "running");
  const r3 = sendRunId({ machineId: "lab-a", threadId: "s1" }, k.ports.sends.at(-1)?.id as string);
  k.ports.runs.set("s1", r3);
  k.thread("thread.failed", "s1", { runId: r3, endCause: "exited", error: { class: "process_exited", message: "killed by signal 9" } });
  await until(() => k.t.get("T1")?.state === "failed");
  expect(k.t.get("T1")?.result?.tail).toContain("Not resumed automatically: it died the same way twice: killed by signal 9.");
  expect(typesOf(k, "task.failed").at(-1)?.data).toMatchObject({ escalated: "it died the same way twice: killed by signal 9" });
  k.hub.shutdown.abort();
});

test("a message continues an ended task in its thread; a running one is steered; a cancelled one refuses", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("Work", "read");
  await k.t.message(k.lead, "T1", "steer");
  expect(k.ports.sends.at(-1)?.message).toBe("steer");
  expect(k.ports.sends.at(-1)?.id).toMatch(/^fleetd-task:T1:\d+:msg:/);
  k.thread("thread.completed", "s1", { runId: "r1" });
  await until(() => k.t.get("T1")?.state === "done");
  await until(() => k.ports.stops.length === 0);
  const continued = await k.t.message(k.lead, "T1", "one more thing");
  expect(continued.state).toBe("running");
  expect(continued.attempt).toBe(2);
  expect(k.ports.sends.at(-1)?.message).toBe("one more thing");
  expect(typesOf(k, "task.started").at(-1)?.summary).toBe("T1 continued (attempt 2): Work");
  const cancelled = await k.t.cancel(k.lead, "T1");
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.result?.tail).toBe("Cancelled by lead:lab-a/p1.");
  expect(k.ports.stops.at(-1)).toEqual({ machineId: "lab-a", threadId: "s1" });
  await expect(k.t.message(k.lead, "T1", "x")).rejects.toThrow("T1 was cancelled.");
  k.hub.shutdown.abort();
});

test("a finished task its own Monitor wakes is running again, and says so for the apps' agents lists", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("Deploy", "read");
  k.thread("thread.completed", "s1", { runId: "r1", endCause: "completed" });
  await until(() => k.t.get("T1")?.state === "done");
  const started = typesOf(k, "task.started").length;
  // Its Monitor prints a line: claude starts a turn of its own, with no message of fleetd's.
  k.threadRow("s1", "running");
  k.thread("thread.started", "s1", { runId: "t1-woke-1" });
  await until(() => k.t.get("T1")?.state === "running");
  await until(() => typesOf(k, "task.started").length > started);
  expect(typesOf(k, "task.started").at(-1)?.summary).toBe("T1 continued in its own thread (attempt 1): Deploy");
  expect(typesOf(k, "task.started").at(-1)?.data).toMatchObject({ taskId: "T1" });
  k.hub.shutdown.abort();
});

test("a cancel the node can't carry out keeps the task and its slot", async () => {
  const k = tasksKit();
  await k.spawn("Work");
  k.ports.stop = async () => {
    throw new PortError(true, "offline");
  };
  await expect(k.t.cancel(k.lead, "T1")).rejects.toThrow(
    "T1 could not be stopped (machine lab-a has no live node link); it keeps running and keeps its slot.",
  );
  expect(k.t.get("T1")?.state).toBe("running");
});

test("past the project's max agents a task queues for a slot, and starts when one frees", async () => {
  const k = tasksKit();
  void k.t.run();
  slots(k.hub).setCap({ maxAgents: { projectRef: P, maxAgents: 1 } });
  await k.spawn("First", "read");
  // The board holds the slot from the grant until the thread first runs.
  const second = await k.spawn("Second", "read");
  expect(second.state).toBe("queued");
  expect(second.queuedReason).toMatch(/^Max agents: 1 of 1/);
  expect(k.t.queuedNext(second)).toMatch(/position 1\. fleetd starts it by itself; don't spawn it again\.$/);
  await k.t.cancel(k.lead, "T1");
  await until(() => k.t.get("T2")?.state === "running");
  k.hub.shutdown.abort();
});

test("a thread waiting for input makes the task idle and wakes its lead with the question", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("Ask");
  k.ports.pending = "May I delete the old table?";
  k.thread("thread.waiting", "s1", { runId: "r1" });
  await until(() => k.t.get("T1")?.state === "idle");
  await until(() => k.ports.wakes.length === 1);
  expect(k.ports.wakes[0]).toEqual({ r: P, kind: "task_waiting", text: "- T1 waiting for an answer: Ask\n  > May I delete the old table?" });
  k.hub.shutdown.abort();
});

test("ask_lead, brief_read and wait_ci answer a task's own agent; the lead calls answer its lead", async () => {
  const k = tasksKit();
  await k.spawn("Ask");
  const task = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "task" as const, taskId: "T1" } };
  const asked = await leadCall(k.hub, k.t, task, { op: "ask_lead", question: "Which table?" });
  expect(asked.taskId).toBe("T1");
  expect(k.ports.wakes[0]?.text).toBe("- T1 waiting for an answer: Ask\n  > Which table?");
  const brief = await leadCall(k.hub, k.t, task, { op: "brief_read" });
  expect(brief).toEqual({ workstreamId: "W1", title: "Dark mode", next: "Your workstream has no brief yet: your task message is all there is." });
  const lead = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "lead" as const } };
  await expect(Promise.resolve().then(() => leadCall(k.hub, k.t, lead, { op: "ask_lead", question: "?" }))).rejects.toThrow(
    "ask_lead is a task's question for its lead, and this call comes from no task.",
  );
  const listed = await leadCall(k.hub, k.t, lead, { op: "task_list" });
  expect((listed.tasks as Task[]).map((t) => t.taskId)).toEqual(["T1"]);
  const spawned = await leadCall(k.hub, k.t, lead, { op: "task_spawn", workstreamId: "W1", title: "Next", kind: "write", prompt: "go" });
  expect((spawned.task as Task).taskId).toBe("T2");
  expect(spawned.next).toBe(
    "Its worktree is based on origin/main @abc1234 as of 10:00 UTC. also writing: T1 Ask (changes unknown) no repo bound; duplicate check skipped",
  );
  // The registry routes every task op here once the area starts.
  const { registerLeadCalls } = await import("../src/hub/tasks/calls.ts");
  registerLeadCalls(k.hub);
  expect(leadCalls(k.hub).handler("task_spawn")).toBeDefined();
  expect(leadCalls(k.hub).handler("wait_ci")).toBeDefined();
});

test("wait_ci takes only a run or PR of the task's project, and a finished one wakes the task", async () => {
  const k = tasksKit();
  void k.t.run();
  await k.spawn("CI", "read");
  k.hub.db.conn
    .query("INSERT INTO repos (machine_id, project_id, checkout_machine_id, checkout_project_id, name, repo_key) VALUES ('lab-a', 'p1', 'lab-a', 'p1', 'shop', 'github.com/acme/shop')")
    .run();
  const task = { projectRef: P, by: "lead:lab-a/p1", agent: { kind: "task" as const, taskId: "T1" } };
  await expect(Promise.resolve().then(() => leadCall(k.hub, k.t, task, { op: "wait_ci", url: "https://github.com/other/repo/actions/runs/5" }))).rejects.toThrow(
    "other/repo is not one of this project's repos.",
  );
  const ok = await leadCall(k.hub, k.t, task, { op: "wait_ci", url: "https://github.com/acme/shop/actions/runs/42/job/7" });
  expect(ok.url).toBe("https://github.com/acme/shop/actions/runs/42");
  // Not yet finished: nothing happens. Then it fails.
  let read: Parameters<typeof summary>[1] = { kind: "running" };
  const reads = { read: async () => read, merge: async () => ({ kind: "pending" as const }) };
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(0);
  read = { kind: "finished", conclusion: "failure", label: "ci", failing: ["rust", "bun"], total: 5 };
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(1);
  expect(k.ports.sends.at(-1)?.message).toBe(
    "CI you waited on (wait_ci) finished: https://github.com/acme/shop/actions/runs/42 (ci) ended failure: 2 of 5 jobs failed: rust, bun.",
  );
  expect(await pollCiWaits(k.t, k.hub.db.conn, k.clock.ms, reads)).toBe(0);
  expect(targetOf("https://github.com/acme/shop/pull/3/files")).toEqual({ kind: "pr", repo: "acme/shop", number: 3 });
  k.hub.shutdown.abort();
});

test("cap_set's pause: running agents above a lowered max push their work and queue with a resume", async () => {
  const k = tasksKit();
  await k.spawn("One", "read");
  await k.spawn("Two", "read");
  k.thread("thread.started", "s1", { runId: "r1" });
  k.thread("thread.started", "s2", { runId: "r2" });
  void k.t.run();
  slots(k.hub).setCap({ maxAgents: { projectRef: P, maxAgents: 1 } });
  await until(() => slots(k.hub).extras(P).length === 1);
  const paused = await k.t.pauseExtras(P, 1);
  expect(paused.length).toBe(1);
  const queued = k.t.get(paused[0] as string) as Task;
  expect(queued.state).toBe("queued");
  expect(queued.queuedReason).toBe("paused: max agents lowered to 1; resumes when a slot frees");
  // Sent under the tasks lock, so as a brief send: a busy node holds the lock 15 s at most.
  expect(k.ports.briefs.length).toBe(1);
  expect(k.ports.sends.at(-1)?.message).toContain("1");
  k.hub.shutdown.abort();
});

test("a running task's end the hub never applied is applied by the sweep; one whose session is gone fails", async () => {
  const k = tasksKit();
  await k.spawn("Lost");
  await k.spawn("Gone");
  k.threadRow("s1", "completed", "finished while the hub was away");
  k.clock.ms += 10 * 60_000;
  await k.t.sweep();
  expect(k.t.get("T1")?.state).toBe("done");
  expect(k.t.get("T2")?.state).toBe("failed");
  expect(k.t.get("T2")?.result?.tail).toContain("[session_lost] the node on lab-a has no session for this agent any more");
});

test("a usage pause queues the task; the disk guard holds only new agents", async () => {
  const k = tasksKit();
  k.ports.usagePaused = "usage limit until 14:00";
  expect((await k.spawn("A")).queuedReason).toBe("usage limit until 14:00");
  k.ports.usagePaused = undefined;
  k.ports.pausedWhy = "Paused new agents: 3 GB free on lab-a";
  expect((await k.spawn("B")).queuedReason).toBe("Paused new agents: 3 GB free on lab-a");
});

test("the nightly sweep removes old worktrees, keeps one holding work and tells once, and gives up after a week", async () => {
  const { cancelClosedQueued, nextRunMs, sweepWorktrees, unsaved } = await import("../src/hub/tasks/worktrees.ts");
  const k = tasksKit();
  for (const title of ["Old", "Kept", "Offline"]) await k.spawn(title, "read");
  for (const id of ["T1", "T2", "T3"]) await k.t.cancel(k.lead, id);
  await until(() => k.ports.removed.length === 3);
  // The cancels' own removals were recorded; a sweep only looks at those left.
  k.hub.db.conn.query("UPDATE tasks SET worktree = NULL").run();
  k.ports.removed = [];
  k.ports.removeErrors.set("s2", new PortError(false, "the node kept /w/s2: it has uncommitted changes"));
  k.ports.removeErrors.set("s3", new PortError(true, "offline"));
  // Not three days yet: nothing goes.
  expect(await sweepWorktrees(k.t)).toEqual({ removed: 0, kept: 0, failed: 0 });
  k.clock.ms += 4 * 86_400_000;
  expect(await sweepWorktrees(k.t)).toEqual({ removed: 1, kept: 1, failed: 1 });
  expect(k.ports.kept).toEqual([
    { r: P, kept: { items: [{ title: "Kept", unsaved: "uncommitted changes", machineId: "lab-a", path: "/w/s2" }] }, text: "Cleanup kept 1 worktree with unsaved work" },
  ]);
  // Kept once is told once; the offline one is tried each night, then given up on.
  for (let night = 0; night < 6; night++) await sweepWorktrees(k.t);
  expect(k.ports.kept.length).toBe(1);
  expect(k.ports.told).toEqual([
    {
      r: P,
      text: "Stopped trying to remove the worktrees of finished agents T3 on lab-a after 7 nightly tries: the machine was offline or git refused. If the machine is still in use, delete them by hand under ~/.fleetd/node/worktrees.",
    },
  ]);
  expect(unsaved("2 commit(s) not pushed")).toBe("2 unpushed commits");
  // 04:00 in the zone, the next one after now.
  expect(new Date(nextRunMs(Date.parse("2026-11-08T03:30:00Z"), "UTC")).toISOString()).toBe("2026-11-08T04:00:00.000Z");
  expect(new Date(nextRunMs(Date.parse("2026-11-08T05:00:00Z"), "Europe/Berlin")).toISOString()).toBe("2026-11-09T03:00:00.000Z");
  // A task queued under an order that closed is cancelled.
  k.ports.connected.clear();
  await k.spawn("Never");
  k.hub.db.conn.query("UPDATE workstreams SET data = json_set(data, '$.state', 'done') WHERE n = 1").run();
  expect(await cancelClosedQueued(k.t)).toBe(1);
  expect(k.t.get("T4")?.result?.tail).toBe("Cancelled: its order W1 is closed.");
});

test("the steer area's task_message stays the lead's message_agent, as Rust's steer::wire replaces the tasks' one", async () => {
  const k = tasksKit();
  const { registerLeadCalls } = await import("../src/hub/tasks/calls.ts");
  const steers = async () => ({ steered: true });
  leadCalls(k.hub).register("task_message", steers);
  registerLeadCalls(k.hub);
  expect(leadCalls(k.hub).handler("task_message")).toBe(steers);
  expect(leadCalls(k.hub).handler("task_spawn")).toBeDefined();
});

test("the GitHub notices go out to every agent on the machine at once, as brief sends", async () => {
  const k = tasksKit();
  await k.spawn("One", "read");
  await k.spawn("Two", "read");
  let inFlight = 0;
  let most = 0;
  k.ports.sendBrief = async (_thread, message) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await Bun.sleep(10);
    inFlight -= 1;
    k.ports.briefs.push(message);
  };
  await k.t.githubReach("lab-a", false);
  expect(k.ports.briefs.length).toBe(2);
  expect(most).toBe(2);
  expect(k.ports.briefs[0]?.startsWith("This machine can't reach GitHub right now")).toBe(true);
});
