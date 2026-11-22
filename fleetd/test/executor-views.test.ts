// The executor's followed sessions (crates/fleetd/src/hub/executor/fake_node_tests.rs's tail test, thread_view_tests.rs):
// a read follows the session, fetches the outputs its snapshot cut, and the tools answer from it.
import { expect, test } from "bun:test";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { actionsOf, newView, applyThreadEvent, tailOf, nodeRetrySummary } from "../src/hub/executor/thread_view.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { SessionOutput, SessionSummary, ThreadEvent } from "../src/shared/sessions.ts";
import { AT, key, kit } from "./work-kit.ts";

const settle = () => Bun.sleep(5);

const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: id,
  projectId: "app",
  title: `work ${id}`,
  status: "idle",
  model: "claude-haiku-5-5",
  effort: "low",
  runtimeMode: "full-access",
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

/** A node whose calls wait for the test's answer. */
async function node() {
  const k = kit();
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void calls.push(f) });
  const reply = (frame: HubToNodeSession, ok: SessionOutput) => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { ok } });
  await settle();
  reply(calls.shift()!, { kind: "done" });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", {
    t: "machine_event",
    seq: 1,
    at: AT,
    event: { type: "snapshot", projects: [{ projectId: "app", title: "App", workspaceRoot: "/w", updatedAt: AT }], sessions: [session("s1", { latestRun: { id: "r1", status: "completed", ordinal: 1 } })] },
  });
  await settle();
  return { ...k, ex, calls, reply };
}

const item = (output: string, omitted: boolean) => ({
  id: "i1",
  runId: "r1",
  status: "completed" as const,
  title: "",
  startedAt: "2026-10-17T10:01:00.000Z",
  completedAt: "2026-10-17T10:01:30.000Z",
  updatedAt: "2026-10-17T10:01:30.000Z",
  kind: { type: "command" as const, command: "npm test", output, ...(omitted ? { outputOmitted: true } : {}), exitCode: 0 },
});

test("a tail follows the session and fetches cut outputs; the tools answer from the follow", async () => {
  const { ex, calls, reply, ok, refused } = await node();
  const r = { machineId: "devbox", threadId: "s1" };
  const tail = ex.views.tail(r, 10, undefined);
  await settle();
  const follow = calls.shift()!;
  expect(follow.call).toEqual({ op: "follow", sessionId: "s1" });
  reply(follow, { kind: "done" });
  ex.handleFrame("devbox", {
    t: "thread_event",
    sessionId: "s1",
    at: "2026-10-17T10:03:00.000Z",
    event: {
      type: "snapshot",
      summary: session("s1"),
      truncated: false,
      runs: [{ id: "r1", status: "completed", ordinal: 1 }],
      messages: [{ id: "m1", runId: "r1", role: "assistant", text: "OK", createdAt: "2026-10-17T10:02:00.000Z" }],
      items: [item("…tail", true)],
    },
  });
  await settle();
  const read = calls.shift()!;
  expect(read.call).toEqual({ op: "read_item", sessionId: "s1", itemId: "i1" });
  reply(read, { kind: "item", item: item("all 12 tests passed", false) });
  const got = await tail;
  expect(got.thread.headline).toBe("OK");
  expect(got.items[0]?.kind).toBe("message");
  expect(got.items[1]?.kind === "action" && got.items[1].action.outputTail).toBe("all 12 tests passed");
  expect(ex.views.progress(r)).toBeDefined();

  // The tools read the same follow, without asking the node again.
  const tool = await ok(key("read"), "thread_tail", r);
  expect(tool.items.map((i: { kind: string }) => i.kind)).toEqual(["message", "action"]);
  expect(tool.thread.headline).toBe("OK");
  const actions = await ok(key("read"), "actions_list", r);
  expect(actions.actions).toEqual([
    { at: "2026-10-17T10:01:30.000Z", kind: "command", status: "completed", summary: "npm test", outputTail: "all 12 tests passed", exitCode: 0, failed: false },
  ]);
  const work = await ok(key("read"), "agent_work", { ...r, limit: 1 });
  expect(work.steps).toEqual([{ kind: "message", id: "m1", at: "2026-10-17T10:02:00.000Z", role: "assistant", text: "OK" }]);
  expect(work.before).toBe("2026-10-17T10:02:00.000Z|m1");
  const older = await ok(key("read"), "agent_work", { ...r, before: work.before });
  expect(older.steps.map((s: { id: string }) => s.id)).toEqual(["i1"]);
  expect(older.before).toBeUndefined();
  expect(await refused(key("read"), "agent_work", { ...r, before: "nonsense" })).toBe("invalid");
  expect(calls).toEqual([]);

  // The link drops: the follow ends, the machine is offline and reads fail at once.
  ex.detachLink("devbox", 1);
  expect(ex.views.progress(r)).toBeUndefined();
  expect(await refused(key("read"), "agent_work", r)).toBe("machine_offline");
  await expect(ex.views.tail(r, 10, undefined)).rejects.toThrow("has no live node link");
});

test("an active session is followed at once, and released when it stops", async () => {
  const { ex, calls } = await node();
  ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "session_updated", ...session("s1", { status: "running", activeRunId: "r2" }) } });
  await settle();
  expect(calls.shift()?.call).toEqual({ op: "follow", sessionId: "s1" });
  const r = { machineId: "devbox", threadId: "s1" };
  expect(ex.views.isFollowed(r)).toBe(true);
  expect(ex.views.pin(r)).toBe(true);
  // The run ends: the follow is released, so it idles out a minute after its last read instead of staying pinned.
  ex.handleFrame("devbox", { t: "machine_event", seq: 3, at: AT, event: { type: "session_updated", ...session("s1", { status: "idle" }) } });
  await settle();
  const w = (ex.views as unknown as { watches: Map<string, { pinned: boolean }> }).watches.get("devbox\u0000s1");
  expect(w?.pinned).toBe(false);
});

test("a session that ran on through a dropped link is followed again once the new link's replay is in", async () => {
  const { ex, calls, reply } = await node();
  const r = { machineId: "devbox", threadId: "s1" };
  ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "session_updated", ...session("s1", { status: "running", activeRunId: "r2" }) } });
  await settle();
  expect(calls.shift()?.call).toEqual({ op: "follow", sessionId: "s1" });
  ex.detachLink("devbox", 1);
  expect(ex.views.isFollowed(r)).toBe(false);
  // Back: the run streamed text only while the link was down, so the replay after the cursor holds nothing of s1.
  ex.attach("devbox", { linkId: 2, send: (f) => void calls.push(f) });
  await settle();
  const subscribe = calls.shift()!;
  expect(subscribe.call).toMatchObject({ op: "subscribe", after: 2 });
  reply(subscribe, { kind: "done" });
  await ex.awaitLive("devbox");
  expect(calls).toEqual([]);
  ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "caught_up" } });
  await settle();
  expect(calls.shift()?.call).toEqual({ op: "follow", sessionId: "s1" });
  expect(ex.views.isFollowed(r)).toBe(true);
  expect(calls).toEqual([]);
});

test("a follow again after a dropped link asks only for what changed since its copy, and puts that onto it", async () => {
  const { ex, calls, reply } = await node();
  const r = { machineId: "devbox", threadId: "s1" };
  const msg = (id: string, minute: number) => ({ id, runId: "r2", role: "assistant" as const, text: id, createdAt: `2026-10-17T10:0${minute}:00.000Z` });
  ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "session_updated", ...session("s1", { status: "running", activeRunId: "r2" }) } });
  await settle();
  const first = calls.shift()!;
  expect(first.call).toEqual({ op: "follow", sessionId: "s1" });
  reply(first, { kind: "done" });
  const snapshot = (messages: ReturnType<typeof msg>[], since?: string) =>
    ex.handleFrame("devbox", {
      t: "thread_event",
      sessionId: "s1",
      at: AT,
      event: { type: "snapshot", summary: session("s1"), truncated: false, runs: [{ id: "r2", status: "running", ordinal: 2 }], messages, items: [], ...(since ? { since } : {}) },
    });
  snapshot([msg("m1", 1), msg("m2", 2)]);
  await settle();
  ex.detachLink("devbox", 1);
  ex.attach("devbox", { linkId: 2, send: (f) => void calls.push(f) });
  await settle();
  reply(calls.shift()!, { kind: "done" });
  await ex.awaitLive("devbox");
  ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "caught_up" } });
  await settle();
  // A minute before the newest it holds, so a step of the node's clock loses nothing.
  const again = calls.shift()!;
  expect(again.call).toEqual({ op: "follow", sessionId: "s1", since: "2026-10-17T10:01:00.000Z" });
  reply(again, { kind: "done" });
  snapshot([msg("m2", 2), msg("m3", 3)], "2026-10-17T10:01:00.000Z");
  await settle();
  const w = (ex.views as unknown as { watches: Map<string, { view: { messages: Map<string, unknown> } }> }).watches.get("devbox\u0000s1")!;
  expect([...w.view.messages.keys()]).toEqual(["m1", "m2", "m3"]);
  expect(ex.views.progress(r)).toBeDefined();
});

function followed() {
  const view = newView();
  const event = (e: ThreadEvent) => applyThreadEvent(view, e);
  const it = (id: string, minute: number, status: string, kind: unknown) => ({
    id,
    runId: "r1",
    status,
    title: "",
    startedAt: `2026-10-17T10:0${minute}:00.000Z`,
    completedAt: `2026-10-17T10:0${minute}:30.000Z`,
    updatedAt: `2026-10-17T10:0${minute}:30.000Z`,
    kind,
  });
  event({
    type: "snapshot",
    summary: session("s1"),
    truncated: false,
    runs: [{ id: "r1", status: "running", ordinal: 1 }],
    messages: [
      { id: "m1", runId: "r1", role: "user", text: "fix the lint", createdAt: "2026-10-17T10:00:00.000Z" },
      { id: "m2", runId: "r1", role: "assistant", text: "Done.", createdAt: "2026-10-17T10:09:00.000Z" },
    ],
    items: [
      it("i1", 1, "completed", { type: "command", command: "npm test", output: "ok", exitCode: 0 }),
      it("i2", 2, "completed", { type: "command", command: "npm run lint", output: "1 error", outputOmitted: true, exitCode: 1 }),
      it("i3", 3, "completed", { type: "file_change", toolName: "Edit", path: "src/a.ts" }),
      it("p1", 4, "completed", { type: "permission", requestId: "q1", toolName: "Bash", summary: "rm" }),
      it("i4", 5, "completed", { type: "api_retry", attempt: 2, maxRetries: 10, errorStatus: 529, error: "overloaded" }),
      it("c1", 6, "completed", { type: "compaction", trigger: "auto" }),
      it("s1", 7, "running", { type: "starting", text: "Starting its computer: boat.dev refused the box. Trying again in 30 s, by itself." }),
    ] as never,
  });
  return view;
}

test("actions are the agent's work, newest first; the tail mixes messages and actions", () => {
  const view = followed();
  const actions = actionsOf(view, 10, false);
  // The permission prompt and the compaction are bookkeeping, not work.
  expect(actions.map(([id]) => id)).toEqual(["s1", "i4", "i3", "i2", "i1"]);
  // A start that keeps failing is a step of its own, running, with why and when it goes again.
  expect(actions[0]?.[1]).toMatchObject({ kind: "other", status: "running", summary: "Starting its computer: boat.dev refused the box. Trying again in 30 s, by itself.", failed: false });
  expect(actions[1]?.[1]).toMatchObject({ kind: "other", summary: "API retry 2/10: 529 overloaded", failed: false });
  expect(actions[3]?.[1]).toMatchObject({ kind: "command", status: "completed", exitCode: 1, failed: true });
  expect(actions[2]?.[1].summary).toBe("src/a.ts");
  expect(actionsOf(view, 10, true).map(([id]) => id)).toEqual(["i2"]);
  const [rows, truncated] = tailOf(view, 3, undefined);
  expect(truncated).toBe(false);
  expect(rows.map(([id, r]) => [id, r.kind])).toEqual([
    ["m2", "message"],
    ["s1", "action"],
    ["i4", "action"],
  ]);
  const [messages] = tailOf(view, 10, ["message"]);
  expect(messages.length).toBe(2);
  expect(messages[1]?.[1].kind === "message" && messages[1][1].role).toBe("user");
  expect(nodeRetrySummary(2, 3, 30000, "overloaded")).toBe("node retry 2/3 in 30 s: overloaded");
  expect(nodeRetrySummary(1, 3, 1500, "network")).toBe("node retry 1/3 in 1500 ms: network");
});
