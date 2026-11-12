// The executor against a fake node link (crates/fleetd/src/hub/executor/fake_node_tests.rs's link side), and the
// tools on its caches (executor/tools.rs), and fleetd_status's quiet hours (hub/attention).
import { expect, test } from "bun:test";
import { parseQuietHours, quietUntil, quietWindows } from "../src/hub/attention/index.ts";
import { executorHooks } from "../src/hub/executor/hooks.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import type { Machine } from "../src/shared/contracts.ts";
import type { SessionSummary } from "../src/shared/sessions.ts";
import { AT, key, kit } from "./work-kit.ts";

const machine = (status: Machine["status"] = "online"): Machine => ({
  machineId: "devbox",
  name: "devbox",
  nodeVersion: "1",
  status,
  lastSeenAt: AT,
});

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

/** A node that answers the hub's calls with `answer`, and records what it was sent. */
function fakeNode(k: ReturnType<typeof kit>, linkId = 1) {
  const sent: HubToNodeSession[] = [];
  const ex = executors(k.hub);
  ex.attach("devbox", {
    linkId,
    send(frame) {
      sent.push(frame);
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { ok: { kind: "done" } } }));
    },
  });
  let seq = 0;
  const event = (e: Parameters<typeof ex.handleMachineEvent>[2]) =>
    ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: e });
  return { sent, ex, event };
}

const settle = () => Bun.sleep(5);

test("a link subscribes from a fresh snapshot, goes live, and the stream fills the caches", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine());
  const node = fakeNode(k);
  await node.ex.awaitLive("devbox");
  expect(node.sent).toEqual([{ t: "session_call", id: expect.any(String), call: { op: "subscribe", caughtUp: true } }]);
  expect(node.ex.isConnected("devbox")).toBe(true);

  node.event({
    type: "snapshot",
    projects: [{ projectId: "app", title: "App", workspaceRoot: "/w/app", updatedAt: AT }],
    sessions: [session("s1", { latestAssistantTail: "Done.\nmore" })],
  });
  await settle();
  // A first snapshot is a baseline: caches, no events.
  expect(store(k.hub).projectGet({ machineId: "devbox", projectId: "app" })).toMatchObject({
    title: "App",
    workspaceRoot: "/w/app",
    threads: { running: 0, waiting: 0, idle: 1, failed: 0 },
  });
  expect(store(k.hub).threadGet({ machineId: "devbox", threadId: "s1" })?.thread).toMatchObject({ status: "idle", headline: "Done." });
  expect(events(k.hub).head()).toBe(0);
  expect(store(k.hub).cursorGet("devbox")).toBe(1);

  node.event({
    type: "session_updated",
    ...session("s1", { status: "running", activeRunId: "r1", latestRun: { id: "r1", status: "running", ordinal: 1 } }),
  });
  await settle();
  expect(events(k.hub).page(0).events.map((e) => [e.type, e.threadId, e.summary])).toEqual([
    ["thread.started", "s1", `"work s1" on devbox started`],
  ]);

  // The tools read the caches.
  const status = await k.ok(key("read"), "fleetd_status", {});
  expect(status.machines.map((m: Machine) => m.machineId)).toEqual(["devbox"]);
  expect(status.projects.map((p: { projectId: string }) => p.projectId)).toEqual(["app"]);
  expect(status.cursor).toBe(1);
  expect(status.notify.coalesceSec).toBe(1200);
  const got = await k.ok(key("read"), "project_get", { machineId: "devbox", projectId: "app" });
  expect([got.stale, got.threads.map((t: { threadId: string; status: string }) => [t.threadId, t.status])]).toEqual([false, [["s1", "running"]]]);

  // The node removes the project: the cache drops it, with an event.
  node.event({ type: "project_removed", projectId: "app" });
  await settle();
  expect(store(k.hub).projectGet({ machineId: "devbox", projectId: "app" })).toBeUndefined();
  expect(events(k.hub).page(1).events.map((e) => [e.type, e.summary])).toEqual([["project.removed", `Project "App" on devbox was removed`]]);
});

test("an older link never takes over, and a dropped one leaves the machine stale", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine());
  const node = fakeNode(k, 2);
  await node.ex.awaitLive("devbox");
  const late: HubToNodeSession[] = [];
  node.ex.attach("devbox", { linkId: 1, send: (f) => void late.push(f) });
  expect(late).toEqual([]);
  node.ex.detachLink("devbox", 1);
  expect(node.ex.isConnected("devbox")).toBe(true);
  node.ex.detachLink("devbox", 2);
  expect(node.ex.isConnected("devbox")).toBe(false);
  await expect(node.ex.call("devbox", "read", { op: "runner_info" }, 1000)).rejects.toThrow("has no live node link");
});

test("an old link's supervisor slow to stop leaves the new link live, and applies nothing after it took over", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine());
  const node = fakeNode(k, 1);
  await node.ex.awaitLive("devbox");
  // The old supervisor is held inside an event when its link drops.
  const applied: number[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const apply = node.ex.handleMachineEvent.bind(node.ex);
  node.ex.handleMachineEvent = async (m, seq, e, baseline) => {
    applied.push(seq ?? -1);
    if (seq === 1) await held;
    return apply(m, seq, e, baseline);
  };
  node.event({ type: "project_removed", projectId: "a" });
  await settle();
  expect(applied).toEqual([1]);
  // The new link subscribes and goes live; a frame queues for it while the old supervisor is still held.
  const fresh = fakeNode(k, 2);
  await fresh.ex.awaitLive("devbox");
  fresh.ex.handleFrame("devbox", { t: "machine_event", seq: 2, at: AT, event: { type: "project_removed", projectId: "b" } });
  release();
  await settle();
  expect(node.ex.isConnected("devbox")).toBe(true);
  expect(node.ex.liveSince("devbox")).toBe(k.clock.ms);
  // Only the new link's supervisor applied the frame, once.
  expect(applied).toEqual([1, 2]);
});

test("a heartbeating link whose sessions aren't live is attached again after 30 s; a live one is left alone", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine());
  const sent: HubToNodeSession[] = [];
  const ex = executors(k.hub);
  const sessions = {
    linkId: 7,
    send(frame: HubToNodeSession) {
      sent.push(frame);
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: { ok: { kind: "done" } } }));
    },
  };
  const subscribes = () => sent.filter((f) => f.t === "session_call" && (f.call as { op: string }).op === "subscribe").length;
  ex.attach("devbox", sessions);
  await ex.awaitLive("devbox");
  expect(subscribes()).toBe(1);
  const links = link(k.hub);
  const state: { sessions: typeof sessions; darkSince?: number } = { sessions };

  // Live: heartbeats leave it be, however long they come.
  links.reattachIfDark("devbox", state);
  k.clock.ms += 60_000;
  links.reattachIfDark("devbox", state);
  await settle();
  expect(subscribes()).toBe(1);

  // Its executor goes dark while the link stays up: heartbeats wait about 30 s, then attach it again.
  ex.goDarkForTest("devbox");
  expect(ex.isConnected("devbox")).toBe(false);
  const warn = console.warn;
  console.warn = () => {};
  links.reattachIfDark("devbox", state);
  k.clock.ms += 20_000;
  links.reattachIfDark("devbox", state);
  await settle();
  expect(subscribes()).toBe(1);
  k.clock.ms += 11_000;
  links.reattachIfDark("devbox", state);
  console.warn = warn;
  await ex.awaitLive("devbox");
  expect(subscribes()).toBe(2);
  expect(ex.isConnected("devbox")).toBe(true);
  // Attaching a live link again does nothing.
  ex.reattach("devbox", sessions);
  await settle();
  expect(subscribes()).toBe(2);
});

test("a call is answered by the reply with its id, or fails with the node's words, or times out", async () => {
  const k = kit();
  const ex = executors(k.hub);
  const sent: HubToNodeSession[] = [];
  ex.attach("devbox", { linkId: 1, send: (f) => void sent.push(f) });
  // The subscribe goes first; answer it so the link is live.
  await settle();
  ex.handleFrame("devbox", { t: "session_reply", id: sent[0]!.id, result: { ok: { kind: "done" } } });
  await ex.awaitLive("devbox");
  const asked = ex.call("devbox", "read", { op: "default_branch", projectId: "app" }, 1000);
  await settle();
  ex.handleFrame("devbox", { t: "session_reply", id: sent[1]!.id, result: { ok: { kind: "default_branch", branch: "main" } } });
  expect(await asked).toEqual({ kind: "default_branch", branch: "main" });
  const refused = ex.call("devbox", "stop", { op: "stop", sessionId: "s9" }, 1000);
  await settle();
  ex.handleFrame("devbox", { t: "session_reply", id: sent[2]!.id, result: { err: { code: "not_found", message: "no such session" } } });
  await expect(refused).rejects.toThrow("thread s9 is not known on machine devbox");
  await expect(ex.call("devbox", "read", { op: "runner_info" }, 20)).rejects.toThrow("no answer within 0 s");
});

test("project_get offline is the cache as of the last sighting; hooks add their fields; another's Navi is refused", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine("offline"));
  store(k.hub).projectsUpsertMany("devbox", [
    { machineId: "devbox", projectId: "app", title: "App", workspaceRoot: "/w", threads: { running: 0, waiting: 0, idle: 1, failed: 0 } as never, lastActivityAt: AT },
  ]);
  store(k.hub).threadUpsert({
    thread: { ...session("s1"), threadId: "s1", machineId: "devbox", headline: "", latestMessageTail: "the end", lastProgressAt: AT, stale: false, asOf: AT } as never,
  });
  executorHooks(k.hub).extendProjectGet(() => ({ fields: { lead: { state: "idle" } }, excludeThreads: new Set(["s2"]) }));
  const got = await k.ok(key("read"), "project_get", { machineId: "devbox", projectId: "app" });
  expect(got).toMatchObject({ stale: true, asOf: AT, next: "Cached as of 2026-10-17T10:00:00.000Z: devbox is offline.", lead: { state: "idle" } });
  expect(got.threads[0]).toMatchObject({ threadId: "s1", stale: true, asOf: AT });
  const tail = await k.ok(key("read"), "thread_tail", { machineId: "devbox", threadId: "s1" });
  expect(tail.items).toEqual([{ kind: "message", at: AT, role: "assistant", text: "the end" }]);
  expect(await k.refused(key("read"), "actions_list", { machineId: "devbox", threadId: "s1" })).toBe("machine_offline");
  expect(await k.refused(key("read"), "project_get", { machineId: "nope", projectId: "app" })).toBe("not_found");
  expect(await k.refused(key("read", { machines: ["laptop"] }), "project_get", { machineId: "devbox", projectId: "app" })).toBe("forbidden");
  // A project that was another person's Only me one is listed and read by anyone who reads its machine (D491).
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-owner', 'Owner', 'owner', 0), ('p-ada', 'Ada', 'member', 1)");
  k.hub.db.conn.run("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('devbox', 'app', 1, 'p-ada')");
  const bo = key("read", { human: true, person: { personId: "p-bo", name: "Bo" } });
  for (const reader of [key("read"), bo]) {
    expect((await k.ok(reader, "project_get", {})).projects.map((p: { projectId: string }) => p.projectId)).toEqual(["app"]);
    expect((await k.ok(reader, "project_get", { machineId: "devbox", projectId: "app" })).project).toMatchObject({ projectId: "app" });
  }
});

test("quiet hours end at the next local end, across midnight and in the policy's zone", () => {
  const ms = Date.parse;
  const quiet = parseQuietHours("23:00-08:00");
  expect(quiet).toEqual({ start: 1380, end: 480 });
  expect(parseQuietHours(" 01:30 - 02:00 ")).toEqual({ start: 90, end: 120 });
  expect(parseQuietHours("11pm-8am")).toBeUndefined();
  expect(parseQuietHours("08:00-08:00")).toBeUndefined();
  expect(quietUntil(ms("2026-10-17T23:30:00Z"), "UTC", quiet)).toBe(ms("2026-10-18T08:00:00Z"));
  expect(quietUntil(ms("2026-10-18T07:59:30Z"), "UTC", quiet)).toBe(ms("2026-10-18T08:00:00Z"));
  expect(quietUntil(ms("2026-10-18T08:00:00Z"), "UTC", quiet)).toBeUndefined();
  // 21:30 UTC is 23:30 in Berlin (CEST, +2).
  expect(quietUntil(ms("2026-10-17T21:30:00Z"), "Europe/Berlin", quiet)).toBe(ms("2026-10-18T06:00:00Z"));
  const w = (a: string, b: string) => ({ fromMs: ms(a), toMs: ms(b) });
  const t0 = ms("2026-10-17T12:00:00Z");
  expect(quietWindows(t0, "UTC", quiet)).toEqual([w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z")]);
  expect(quietWindows(ms("2026-10-18T01:15:30Z"), "UTC", quiet)).toEqual([
    w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z"),
    w("2026-10-18T23:00:00Z", "2026-10-19T08:00:00Z"),
  ]);
  expect(quietWindows(t0, "Europe/Berlin", quiet)).toEqual([w("2026-10-17T21:00:00Z", "2026-10-18T06:00:00Z")]);
  expect(quietWindows(t0, "UTC", undefined)).toEqual([]);
});

test("a busy link holds no more abort listeners than an idle one", async () => {
  const k = kit();
  store(k.hub).machineUpsert(machine());
  let net = 0;
  const add = AbortSignal.prototype.addEventListener;
  const remove = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (this: AbortSignal, ...args: Parameters<typeof add>) {
    if (args[0] === "abort") net++;
    return add.apply(this, args);
  };
  AbortSignal.prototype.removeEventListener = function (this: AbortSignal, ...args: Parameters<typeof remove>) {
    if (args[0] === "abort") net--;
    return remove.apply(this, args);
  };
  try {
    const node = fakeNode(k);
    await node.ex.awaitLive("devbox");
    await settle();
    const idle = net;
    for (let i = 0; i < 200; i++) {
      node.event({ type: "project_upserted", projectId: "app", title: "App", workspaceRoot: "/w", updatedAt: AT });
      await Bun.sleep(0);
    }
    await settle();
    expect(net).toBe(idle);
  } finally {
    AbortSignal.prototype.addEventListener = add;
    AbortSignal.prototype.removeEventListener = remove;
  }
});

test("a link that refuses the frame fails the call at once as offline", async () => {
  const k = kit();
  const ex = executors(k.hub);
  ex.attach("devbox", { linkId: 1, send: () => false });
  await expect(ex.call("devbox", "read", { op: "runner_info" }, 5000)).rejects.toThrow("has no live node link");
});

test("fleetd_status always carries chats and the slot board, as the Rust hub's does", async () => {
  const k = kit();
  // An empty hub: both keys, empty, never left out (the apps read them from the snapshot).
  const empty = await k.ok(key("read"), "fleetd_status", {});
  expect(empty.chats).toEqual([]);
  expect(empty.slots).toMatchObject({ cap: expect.any(Number), used: 0, queued: 0, perProject: [] });
  // With a project: its chat state, for a key that reads its machine only.
  store(k.hub).machineUpsert(machine());
  store(k.hub).projectsUpsertMany("devbox", [
    { machineId: "devbox", projectId: "app", title: "App", workspaceRoot: "/w", threads: { running: 0, waiting: 0, idle: 0, failed: 0 } as never, lastActivityAt: AT },
  ]);
  const one = await k.ok(key("read"), "fleetd_status", {});
  expect(one.chats.map((c: { projectRef: { projectId: string } }) => c.projectRef.projectId)).toEqual(["app"]);
  expect(Object.keys(one)).toEqual(expect.arrayContaining(["chats", "slots"]));
  const elsewhere = await k.ok(key("read", { machines: ["laptop"] }), "fleetd_status", {});
  expect([elsewhere.chats, elsewhere.slots.perProject]).toEqual([[], []]);
});
