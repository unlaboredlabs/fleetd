import { afterAll, expect, test } from "bun:test";
import { normalize, projectIndexForCwd } from "../src/hub/lead_calls/cwd.ts";
import { LeadCalls, leadCalls, onLeadCallFrame, type LeadCaller, type LeadResultFrame } from "../src/hub/lead_calls/index.ts";
import { check, checkCall, checkFanOut, NODE_OPS, WORKER_OPS } from "../src/hub/lead_calls/policy.ts";
import { build } from "../src/hub/serve/index.ts";
import { NotImplemented, ToolError } from "../src/shared/errors.ts";
import { hubHome } from "./helpers.ts";

const home = hubHome();
const { hub } = build(home.dir, { host: "127.0.0.1", port: 0 });
afterAll(() => {
  hub.db.close();
  home.done();
});

const db = hub.db.conn;
const project = (machineId: string, projectId: string, root: string, at: string) =>
  db
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, '', ?, ?)")
    .run(machineId, projectId, at, JSON.stringify({ projectId, workspaceRoot: root, machineId }));
project("devbox", "p1", "/work/app", "2026-11-08T10:00:00Z");
project("devbox", "p2", "/work/app/tools", "2026-11-08T09:00:00Z");
project("devbox", "p3", "/work/other", "2026-11-08T08:00:00Z");
db.query("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?, ?, ?, ?, 1)").run(
  "devbox",
  "p1",
  "th-lead",
  "2026-11-08T10:00:00Z",
);
const task = (n: number, threadId: string, projectId: string) =>
  db
    .query("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (?, 'devbox', ?, 'W1', 'running', ?, ?)")
    .run(n, projectId, threadId, JSON.stringify({ taskId: `T${n}`, projectRef: { machineId: "devbox", projectId } }));
task(4, "th-task", "p1");
task(5, "th-other", "p3");
// A task restarted fresh: its old thread is still its own.
db.query("INSERT INTO task_threads (machine_id, thread_id, n) VALUES ('devbox', 'th-old', 4)").run();
db.query("INSERT INTO memory_refreshes (machine_id, project_id, thread_id) VALUES ('devbox', 'p1', 'th-refresh')").run();

const calls = leadCalls(hub);
const seen: LeadCaller[] = [];
for (const op of ["decide", "ask_lead", "remember", "forget", "task_spawn", "browser_session"]) {
  calls.register(op, (caller, call) => {
    seen.push(caller);
    if (call.key === "boom") throw new Error("crash");
    if (call.key === "no") throw new ToolError("invalid", "not that key", "pick another");
    if (call.key === "later") throw new NotImplemented("src/hub/navi (factory status)");
    return { echoed: call.op };
  });
}
const DECIDE = { op: "decide" as const, key: "a.b", value: "v" };
const SPAWN = { op: "task_spawn", workstreamId: "W1", title: "t", prompt: "p" };
const SESSION = {
  op: "browser_session",
  sessionId: `B${"0".repeat(32)}`,
  threadId: "th-1",
  purpose: "check the page",
  state: "live",
  startedAt: "2026-11-08T10:00:00Z",
};
const answer = (cwd: string, call: Record<string, unknown>, threadId?: string, machineId = "devbox") =>
  calls.answer(machineId, { id: "c1", cwd, call: call as never, ...(threadId === undefined ? {} : { threadId }) });
const error = (frame: LeadResultFrame) => ("error" in frame ? frame.error : undefined);

test("cwd matching: the deepest root wins, siblings sharing a prefix don't count", () => {
  expect(normalize("/a/b/../c/./d/")).toBe("/a/c/d");
  expect(normalize("a/../../b")).toBe("../b");
  expect(normalize("")).toBe(".");
  const roots = ["/a/b", "/a/bc", "/a/b/tools/sub"];
  expect(projectIndexForCwd(roots, "/a/b/src")).toBe(0);
  expect(projectIndexForCwd(roots, "/a/b/tools/sub/x")).toBe(2);
  expect(projectIndexForCwd(roots, "/a/bc")).toBe(1);
  expect(projectIndexForCwd(roots, "/a/bcd")).toBeUndefined();
  expect(projectIndexForCwd(roots, "/")).toBeUndefined();
  expect(projectIndexForCwd(["/"], "/x")).toBe(0);
  expect(projectIndexForCwd(["rel"], "rel")).toBeUndefined();
});

test("a person's shell acts on the project its cwd is in, and the result carries the op", async () => {
  const frame = await answer("/work/app/tools/x", DECIDE);
  expect(frame).toEqual({ id: "c1", result: { echoed: "decide", op: "decide" } });
  expect(seen.at(-1)).toEqual({ projectRef: { machineId: "devbox", projectId: "p2" }, by: "lead:devbox/p2", agent: { kind: "person" } });
});

test("a cwd outside every workspace is refused, naming the roots", async () => {
  expect(error(await answer("/elsewhere", DECIDE))).toEqual({
    code: "forbidden",
    message: "/elsewhere is not inside any project workspace on devbox",
    fix: "run fleetd from the project's workspace or a worktree under it (/work/app, /work/app/tools, /work/other)",
  });
  expect(error(await answer("/x", DECIDE, undefined, "laptop"))?.message).toBe(
    "the hub knows no projects on laptop yet, so it cannot tell which project /x belongs to",
  );
});

test("a writer's worktree outside every workspace is known by its session", async () => {
  const frame = await answer("/home/u/.fleetd/node/worktrees/x", { op: "ask_lead", question: "?" }, "th-task");
  expect("result" in frame).toBe(true);
  expect(seen.at(-1)?.agent).toEqual({ kind: "task", taskId: "T4" });
  expect(seen.at(-1)?.threadId).toBe("th-task");
  // Its earlier thread, from before a fresh restart.
  await answer("/nowhere", { op: "ask_lead", question: "?" }, "th-old");
  expect(seen.at(-1)?.agent).toEqual({ kind: "task", taskId: "T4" });
});

test("a session acting from another project's workspace is refused", async () => {
  expect(error(await answer("/work/app", DECIDE, "th-other"))).toEqual({
    code: "forbidden",
    message: "this session works for project devbox/p3, not for the project its working directory is in",
    fix: "act only on your own project, from its workspace",
  });
});

test("leads, tasks and the memory refresh are told apart, and the policy holds", async () => {
  expect("result" in (await answer("/work/app", SPAWN, "th-lead"))).toBe(true);
  expect(seen.at(-1)?.agent).toEqual({ kind: "lead" });
  expect(error(await answer("/work/app", SPAWN, "th-task"))?.message).toBe(
    "T4 is a task, and a task's agent can't start agents: fleetd runs one level, a lead and its tasks.",
  );
  expect(error(await answer("/work/app", DECIDE, "th-task"))?.message).toBe("decide is a lead's call, and T4 is a task.");
  expect(error(await answer("/work/app", { op: "ask_lead", question: "?" }, "th-lead"))?.code).toBe("invalid");
  expect("result" in (await answer("/work/app", { op: "remember", scope: "user", text: "a lesson" }, "th-refresh"))).toBe(true);
  expect(error(await answer("/work/app", { op: "forget", scope: "user", entry: "a lesson" }, "th-refresh"))?.message).toBe(
    "The nightly refresh only adds to user memory: it never replaces or removes an entry there.",
  );
  expect(error(await answer("/work/app", DECIDE, "th-refresh"))?.code).toBe("forbidden");
  expect(error(await answer("/work/app", DECIDE, "th-nobody"))).toEqual({
    code: "forbidden",
    message: "session th-nobody is neither a project's lead nor a task, so it can't make fleetd's lead calls",
    fix: "a person runs these commands from their own shell; agents use their fleetd tools",
  });
});

test("an op nobody registered, a refusal and a crash", async () => {
  expect(error(await answer("/work/app", { op: "close", workstreamId: "W1", why: "done" }))).toEqual({
    code: "forbidden",
    message: "this hub does not take lead-side calls yet",
    fix: "carry on without this call and say so in your result",
  });
  expect(error(await answer("/work/app", { ...DECIDE, key: "no" }))).toEqual({ code: "invalid", message: "not that key", fix: "pick another" });
  const quiet = console.error;
  console.error = () => {};
  const crashed = await answer("/work/app", { ...DECIDE, key: "boom" });
  console.error = quiet;
  expect(error(crashed)).toEqual({ code: "failed", message: "the hub failed while handling this call", fix: "try again shortly" });
  // A part not ported yet is said as such, never "try again": it can't work on this hub.
  expect(error(await answer("/work/app", { ...DECIDE, key: "later" }))).toEqual({
    code: "failed",
    message: "not ported to Bun yet: src/hub/navi (factory status) (experimental/bun/PORT_MAP.md)",
    fix: "carry on without this call and say so in your result",
  });
});

test("a runner's browser call for a session it hosts is answered in the agent's name", async () => {
  calls.setHosts((runner, threadId) =>
    runner === "runner1" && threadId === "key-1"
      ? { projectRef: { machineId: "devbox", projectId: "p3" }, agent: { kind: "task", taskId: "T5" }, threadId: "th-other" }
      : undefined,
  );
  const frame = await answer("/anywhere", { ...SESSION, threadId: "key-1" }, "key-1", "runner1");
  expect("result" in frame).toBe(true);
  expect(seen.at(-1)).toEqual({
    projectRef: { machineId: "devbox", projectId: "p3" },
    by: "lead:devbox/p3",
    agent: { kind: "task", taskId: "T5" },
    threadId: "th-other",
  });
  // Anything else from the runner is its own, and it has no projects.
  expect(error(await answer("/anywhere", DECIDE, "key-1", "runner1"))?.code).toBe("forbidden");
});

test("the link's frame is answered as a lead_result", async () => {
  const sent = await new Promise<unknown>((resolve) =>
    onLeadCallFrame(hub, "devbox", { id: "n7", cwd: "/work/app", call: DECIDE }, resolve),
  );
  expect(sent).toEqual({ t: "lead_result", id: "n7", result: { echoed: "decide", op: "decide" } });
  expect(leadCalls(hub)).toBe(calls);
  expect(new LeadCalls(hub).handler("decide")).toBeUndefined();
});

test("the policy's lists and the fan-out cap", () => {
  for (const op of [...WORKER_OPS, ...NODE_OPS]) expect(() => check({ kind: "task", taskId: "T3" }, op)).not.toThrow();
  expect(() => check({ kind: "lead" }, "review_verdict")).toThrow("review_verdict is a review task's own verdict");
  expect(() => check({ kind: "person" }, "review_verdict")).not.toThrow();
  expect(() => check({ kind: "lead" }, "wait_ci")).toThrow("wait_ci wakes the task that asked");
  expect(() => checkCall({ kind: "memory_refresh" }, { op: "remember", scope: "user", replaces: "x" })).toThrow();
  expect(() => checkCall({ kind: "memory_refresh" }, { op: "remember", scope: "project", replaces: "x" })).not.toThrow();
  expect(() => checkFanOut(31, 4)).not.toThrow();
  expect(() => checkFanOut(32, 4)).toThrow("This project already has 32 open tasks, the most one lead may have at once (32).");
  expect(() => checkFanOut(40, 28)).not.toThrow();
});
