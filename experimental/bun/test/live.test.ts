// Ports crates/fleetd/src/hub/app_ws/live/tests.rs, and a live subscription end to end over /app.
import { afterAll, expect, test } from "bun:test";
import { StreamText } from "../src/hub/executor/activity.ts";
import { activity } from "../src/hub/executor/activity.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leadLaneStatus, taskLaneStatus } from "../src/hub/app_ws/live/lanes.ts";
import { type LaneNow, LIVE_MAX_FRAME_BYTES, Pump, type TickInput } from "../src/hub/app_ws/live/pump.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { LaneStatus, LiveFrame, Task } from "../src/shared/contracts.ts";
import type { ThreadEvent } from "../src/shared/sessions.ts";
import { FakeApp } from "./fake-app.ts";
import { insertKey, tempHome } from "./helpers.ts";

const lane = (id: string, status: LaneStatus, cmd: string | undefined, samples: number[]): LaneNow => ({
  lane: {
    laneId: id,
    status,
    ...(cmd ? { activity: { activity: { kind: "command", text: cmd }, since: "2026-10-18T10:00:00.000Z" } } : {}),
    tokens: { input: 10, output: 2, cacheRead: 0, live: false },
    spark: { endAt: "2026-10-18T10:00:00.000Z", samples },
  },
});
const tick = (lanes: LaneNow[]): TickInput => ({ nowMs: 1_000, lanes, boardComplete: true });
const ids = (f: LiveFrame) => f.lanes.map((l) => l.laneId);

test("only what changed is sent after the full frame", () => {
  const pump = new Pump();
  const first = pump.frame(tick([lane("T1", "working", "cargo test", [0, 16]), lane("T2", "queued", undefined, [0, 0])]));
  expect(first?.full).toBe(true);
  expect(first?.lanes).toHaveLength(2);
  expect(pump.frame(tick([lane("T1", "working", "cargo test", [0, 16]), lane("T2", "queued", undefined, [0, 0])]))).toBeUndefined();
  const moved = pump.frame(tick([lane("T1", "working", "git push", [0, 16]), lane("T2", "queued", undefined, [0, 0])]));
  expect(moved?.full).toBe(false);
  expect(ids(moved as LiveFrame)).toEqual(["T1"]);
  expect(moved?.lanes[0]?.spark).toBeUndefined();
  const spark = pump.frame(tick([lane("T1", "working", "git push", [0, 16]), lane("T2", "queued", undefined, [0, 32])]));
  expect(ids(spark as LiveFrame)).toEqual(["T2"]);
  expect(spark?.lanes[0]?.spark).toBeDefined();
});

test("streamed text is sent once, in order", () => {
  const pump = new Pump();
  const withText = (total: number, tail: string) => {
    const l = lane("lead:lab-a/p1", "working", undefined, []);
    return tick([{ ...l, text: new StreamText("m1", tail, total) }]);
  };
  expect(pump.frame(withText(5, "Hello"))?.text?.[0]?.append).toBe("Hello");
  expect(pump.frame(withText(11, "Hello world"))?.text?.[0]?.append).toBe(" world");
  expect(pump.frame(withText(11, "Hello world"))).toBeUndefined();
});

test("a frame stays under its byte limit and the rest waits", () => {
  const pump = new Pump();
  const long = "x".repeat(150);
  const lanes = (n: number) => Array.from({ length: n }, (_, i) => lane(`T${i + 1}`, "working", long, Array(30).fill(255)));
  const first = pump.frame(tick(lanes(60))) as LiveFrame;
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(LIVE_MAX_FRAME_BYTES);
  expect(first.lanes.length).toBeLessThan(60);
  const second = pump.frame(tick(lanes(60))) as LiveFrame;
  expect(first.lanes.length + second.lanes.length).toBe(60);
});

test("lane statuses follow the task's state and its thread", () => {
  const task = (state: Task["state"], extra: Partial<Task> = {}) => ({ state, ...extra }) as Task;
  const thread = { threadRef: { machineId: "devbox", threadId: "t1" } } as Partial<Task>;
  expect(taskLaneStatus(task("queued"), undefined)).toBe("queued");
  expect(taskLaneStatus(task("running"), undefined)).toBe("starting");
  expect(taskLaneStatus(task("running", thread), "running")).toBe("working");
  expect(taskLaneStatus(task("running", thread), "waiting")).toBe("waiting");
  expect(taskLaneStatus(task("running", thread), "failed")).toBe("stalled");
  expect(taskLaneStatus(task("idle", { parked: {} as Task["parked"] }), undefined)).toBe("parked");
  expect(leadLaneStatus("idle", false, "running")).toBe("working");
  expect(leadLaneStatus("working", false, undefined)).toBe("working");
  expect(leadLaneStatus("stopped", false, undefined)).toBe("cancelled");
  expect(leadLaneStatus("idle", true, "running")).toBe("parked");
});

const home = tempHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(hub, tools, 0);
afterAll(async () => {
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  home.done();
});

test("a board subscription over /app: the full frame, then the running task's activity as it changes", async () => {
  store(hub).machineUpsert({ machineId: "devbox", name: "devbox", tags: [], status: "online", lastSeenAt: "2026-11-08T00:00:00.000Z", nodeVersion: "1" });
  hub.db.conn.run("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'p1', '', '', ?)", [
    JSON.stringify({ machineId: "devbox", projectId: "p1", title: "fleetd", workspaceRoot: "/w/p1" }),
  ]);
  const task = {
    taskId: "T1",
    projectRef: { machineId: "devbox", projectId: "p1" },
    workstreamId: "W1",
    state: "running",
    threadRef: { machineId: "devbox", threadId: "t1" },
  };
  hub.db.conn.run("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (1, 'devbox', 'p1', 'W1', 'running', 't1', ?)", [
    JSON.stringify(task),
  ]);
  const feed = (event: unknown) => activity(hub).onThreadEvent("devbox", { sessionId: "t1", at: "2026-11-08T00:00:00.000Z", event: event as ThreadEvent });
  feed({
    type: "snapshot",
    summary: { sessionId: "t1", projectId: "p1", title: "t", status: "running", activeRunId: "r1" },
    messages: [],
    items: [],
    runs: [{ id: "r1", status: "running", ordinal: 1 }],
    truncated: false,
  });
  feed({ type: "item", id: "i1", runId: "r1", status: "running", title: "", startedAt: "2026-11-08T00:00:00.000Z", updatedAt: "2026-11-08T00:00:00.000Z", kind: { type: "command", command: "bun test" } });

  const key = insertKey(hub.db, [{ role: "read", machines: "*" }], "viewer");
  const app = new FakeApp(`ws://127.0.0.1:${server.port}/app`);
  await app.send({ t: "auth", key });
  await app.tag("ready");
  await app.send({ t: "live", board: true });
  const full = await app.tag("live");
  expect(full.full).toBe(true);
  expect(full.machines).toMatchObject([{ machineId: "devbox", name: "devbox", status: "online", running: 0 }]);
  // The stored thread row says nothing yet, so the running task's lane is still starting: its activity comes with it.
  expect(full.lanes).toMatchObject([{ laneId: "T1", status: "starting", activity: { activity: { kind: "command", text: "bun test" } } }]);
  feed({ type: "item", id: "i2", runId: "r1", status: "running", title: "", startedAt: "2026-11-08T00:00:01.000Z", updatedAt: "2026-11-08T00:00:01.000Z", kind: { type: "file_change", toolName: "Edit", path: "/w/p1/src/a.ts" } });
  const next = await app.next((f) => f.t === "live" && !f.full && (f.lanes as unknown[]).length > 0);
  expect(next.lanes).toMatchObject([{ laneId: "T1", activity: { activity: { kind: "edit", path: "src/a.ts" } } }]);
  // `live` with nothing in scope stops it; a bad one is refused.
  await app.send({ t: "live", board: false });
  await app.send({ t: "live" });
  expect(await app.tag("error")).toMatchObject({ code: "invalid", message: "Unknown or malformed message." });
  app.close();
});

// Through the executor: a node's thread events reach the tracker by the executor's thread sink, as the Rust
// executor feeds its watches. Skips until hub/executor feeds each thread event to the tracker (`feedActivity`).
const wired = typeof (executors(hub) as unknown as { feedActivity?: unknown }).feedActivity === "function";
test.skipIf(!wired)("a node's thread events reach a live lane through the executor", async () => {
  const { FakeNode } = await import("./fake-node.ts");
  const { token } = hub.auth.nodes.createEnrollToken("devbox", "test");
  const node = new FakeNode(`ws://127.0.0.1:${server.port}/node/link`, { machineId: "devbox", enrollToken: token });
  await node.tag("welcome");
  hub.db.conn.run("INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (2, 'devbox', 'p1', 'W1', 'running', 't2', ?)", [
    JSON.stringify({ taskId: "T2", projectRef: { machineId: "devbox", projectId: "p1" }, workstreamId: "W1", state: "running", threadRef: { machineId: "devbox", threadId: "t2" } }),
  ]);
  const at = new Date().toISOString();
  // The executor reads thread events of the sessions it follows, so it follows this one first.
  const views = (executors(hub) as unknown as { views?: { pin?(r: unknown): boolean } }).views;
  views?.pin?.({ machineId: "devbox", threadId: "t2" });
  const send = (event: unknown) => node.send({ t: "thread_event", sessionId: "t2", at, event });
  send({
    type: "snapshot",
    summary: { sessionId: "t2", projectId: "p1", title: "t", status: "running", activeRunId: "r1" },
    messages: [],
    items: [],
    runs: [{ id: "r1", status: "running", ordinal: 1 }],
    truncated: false,
  });
  send({ type: "item", id: "i1", runId: "r1", status: "running", title: "", startedAt: at, updatedAt: at, kind: { type: "command", command: "cargo build" } });
  const key = insertKey(hub.db, [{ role: "read", machines: "*" }], "viewer-2");
  const app = new FakeApp(`ws://127.0.0.1:${server.port}/app`);
  await app.send({ t: "auth", key });
  await app.tag("ready");
  await app.send({ t: "live", board: false, agent: "T2" });
  const frame = await app.next((f) => f.t === "live" && (f.lanes as { activity?: unknown }[]).some((l) => l.activity));
  expect(frame.lanes).toMatchObject([{ laneId: "T2", activity: { activity: { kind: "command", text: "cargo build" } } }]);
  app.close();
  node.close();
  await node.closed;
});

test("live frames carry the slot board, cut to what the key may see", async () => {
  const { slots } = await import("../src/hub/app_ws/live/lanes.ts");
  const { state } = await import("../src/hub/slots/index.ts");
  const board = state(hub);
  const rows = [
    { projectRef: { machineId: "devbox", projectId: "p1" } },
    { projectRef: { machineId: "devbox", projectId: "theirs" } },
    { projectRef: { machineId: "other", projectId: "p9" } },
  ];
  const fake = { ...board, perProject: rows, perMachine: [{ machineId: "devbox" }, { machineId: "other" }] } as never;
  const area = (hub as unknown as { areas: Map<string, { state(): unknown }> }).areas.get("slots");
  if (!area) throw new Error("no slot board");
  const real = area.state.bind(area);
  area.state = () => fake;
  hub.db.conn.run(
    "INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_ownerown', 'Own', 'owner', 1), ('p_otherrrr', 'Oth', 'member', 2)",
  );
  hub.db.conn.run("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('devbox', 'theirs', 1, 'p_otherrrr')");
  const reader = { keyId: "k", name: "r", prefix: "fld_aaaaaa", createdAt: "2026-11-08T00:00:00.000Z", grants: [{ role: "read" as const, machines: ["devbox"] }] };
  const cut = slots(hub, reader);
  area.state = real;
  expect(cut?.perProject as unknown).toEqual([{ projectRef: { machineId: "devbox", projectId: "p1" } }]);
  expect(cut?.perMachine as unknown).toEqual([{ machineId: "devbox" }]);
});

test("a lead's lane takes its state from hub/leads, parked by the usage layer included", async () => {
  const { agentLanes } = await import("../src/hub/app_ws/live/lanes.ts");
  const { leads } = await import("../src/hub/leads/index.ts");
  hub.db.conn.run(
    "INSERT OR REPLACE INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'lt1', '2026-11-08T00:00:00.000Z', 0)",
  );
  const owner = { keyId: "k", name: "o", prefix: "fld_aaaaaa", createdAt: "2026-11-08T00:00:00.000Z", grants: [{ role: "read" as const, machines: "*" as const }] };
  const lane = () => agentLanes(hub, owner, "lead:devbox/p1")[0]?.lane;
  // No thread row yet: the lead is starting.
  expect(lane()?.status).toBe("starting");
  const area = leads(hub);
  const before = area.parkedOf;
  area.parkedOf = () => ({ since: "2026-11-08T00:00:00.000Z" }) as never;
  expect(lane()?.status).toBe("parked");
  area.parkedOf = before;
});
