import { afterAll, expect, test } from "bun:test";
import { serve, stop } from "../src/hub/http/index.ts";
import { link, NodeCommandError } from "../src/hub/link/index.ts";
import { closeReason } from "../src/shared/node_link.ts";
import { build } from "../src/hub/serve/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { FakeNode, nodeKey } from "./fake-node.ts";
import { hubHome } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
const server = serve(hub, tools, 0);
const url = `ws://127.0.0.1:${server.port}/node/link`;
const links = link(hub);
afterAll(async () => {
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  home.done();
});

const types = () => events(hub).page(0).events.map((e) => `${e.type} ${e.machineId ?? ""}`.trim());

/** Enrolls `machineId` with a fresh code and links it; resolves once the hub announced it. */
async function linked(machineId: string, options: ConstructorParameters<typeof FakeNode>[1] = {}) {
  const { token } = hub.auth.nodes.createEnrollToken(machineId, "test");
  const node = new FakeNode(url, { machineId, enrollToken: token, ...options });
  await node.tag("welcome");
  return node;
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

test("a node that isn't enrolled is refused with the fix in the close reason", async () => {
  const node = new FakeNode(url, { machineId: "stranger" });
  const closed = await node.closed;
  expect(closed).toEqual({ code: 4001, reason: "stranger is not enrolled: run fleetd pair --worker stranger on the hub" });
});

test("a node on another protocol is told which side to update", async () => {
  const node = new FakeNode(url, { machineId: "old", protocol: 99 });
  const closed = await node.closed;
  expect(closed.code).toBe(4002);
  expect(closed.reason).toContain("the hub runs an older fleetd than this machine");
});

test("an enroll token links once; the machine is online once its runner answers", async () => {
  const node = await linked("worker-1", { capabilities: ["browser", "session_host"], fingerprint: "fp1" });
  const welcome = await node.tag("welcome");
  expect(welcome).toMatchObject({ hubId: links.hubId, protocol: 1, capabilities: ["session_route", "link_deflate"] });
  await until(() => types().includes("machine.online worker-1"));
  expect(links.can("worker-1", "browser")).toBe(true);
  expect(links.can("worker-1", "mac_tool")).toBe(false);
  expect(links.lacks("worker-1", "mac_tool")).toBe(true);
  expect(links.linkId("worker-1")).toBeNumber();
  expect(links.ready("worker-1")).toBe(true);
  const machine = store(hub).machineGet("worker-1");
  expect(machine).toMatchObject({ machineId: "worker-1", status: "online", nodeVersion: "0.0.0-test", boxPubKey: "Ym94" });
  expect(machine?.degradedReason).toBeUndefined();
  expect(hub.auth.nodes.nodeFingerprint("worker-1")).toBe("fp1");

  // The same key links again with no token; the old link is replaced.
  const again = new FakeNode(url, { machineId: "worker-1", key: node.key, capabilities: ["browser"] });
  await again.tag("welcome");
  expect(await node.closed).toEqual({ code: 4003, reason: "a newer link for this machine took over" });
  expect(links.can("worker-1", "session_host")).toBe(false);
  await until(() => types().includes("machine.linked worker-1"));

  // A used token is refused, after the signature checked out.
  const { token } = hub.auth.nodes.createEnrollToken("worker-2", "test");
  hub.auth.nodes.enrollNode(token, "worker-2", nodeKey().pubKey);
  const late = new FakeNode(url, { machineId: "worker-2", enrollToken: token });
  expect(await late.closed).toEqual({
    code: 4001,
    reason: "enrollment token was already used. Fix: on the hub, run fleetd pair --worker worker-2 for a new code",
  });
  again.close();
  await again.closed;
});

test("a logged-out runner leaves the machine degraded with its problem", async () => {
  const node = await linked("worker-3", { runner: "logged_out" });
  await until(() => types().includes("machine.degraded worker-3"));
  expect(store(hub).machineGet("worker-3")).toMatchObject({ status: "degraded", degradedReason: "claude is logged out" });
  expect(links.ready("worker-3")).toBe(false);
  // The node pushes its runner when the login comes back.
  node.send({ t: "machine_event", seq: 1, at: new Date().toISOString(), event: { type: "runner_info", runner: "claude", login: "logged_in" } });
  await until(() => types().includes("machine.online worker-3"));
  node.close();
  await node.closed;
});

test("request() resolves with the reply its id names, and fails as lost when the link drops", async () => {
  const node = await linked("worker-4");
  const seen: string[] = [];
  const off = links.on("thread_event", (machineId, frame) => {
    seen.push(`${machineId} ${frame.t}`);
  });
  const action = links.request("worker-4", { t: "node_action", action: "probe" });
  const asked = await node.next((f) => f.t === "node_action");
  // Another machine's answer, or a wrong tag, isn't this request's.
  node.send({ t: "cmd_result", id: asked.id, exitCode: 0 });
  node.send({ t: "node_action_result", id: asked.id, ok: true, message: "probed" });
  expect(await action).toMatchObject({ t: "node_action_result", ok: true, message: "probed", id: asked.id as string });

  node.send({ t: "thread_event", seq: 1, at: "x", threadId: "t1", event: {} });
  await until(() => seen.length === 1);
  expect(seen).toEqual(["worker-4 thread_event"]);
  off();

  await expect(links.request("nowhere", { t: "cmd_check", cwd: "/", argv: ["true"] })).rejects.toThrow(
    "nowhere's node is not linked to the hub",
  );
  const pending = links.request("worker-4", { t: "cmd_check", cwd: "/", argv: ["sleep", "9"], timeoutSec: 60 });
  await node.next((f) => f.t === "cmd_check");
  node.close();
  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(NodeCommandError);
  expect((error as NodeCommandError).reason).toBe("lost");
  expect(links.linkId("worker-4")).toBeUndefined();
});

test("a request with no answer fails as no_reply after its wait", async () => {
  const node = await linked("worker-5");
  const error = await links
    .request("worker-5", { t: "node_action", action: "probe" }, { waitSec: 0.05 })
    .catch((e: NodeCommandError) => e);
  expect((error as NodeCommandError).reason).toBe("no_reply");
  expect((error as NodeCommandError).message).toBe("worker-5's node did not answer within 0.05 s");
  node.close();
  await node.closed;
});

test("a link_deflate node gets compressed frames and its own compressed frames are read", async () => {
  const node = await linked("worker-6", { capabilities: ["link_deflate"] });
  await until(() => types().includes("machine.online worker-6"));
  const long = links.request("worker-6", { t: "node_action", action: "probe", padding: "p".repeat(200) });
  const asked = await node.next((f) => f.t === "node_action");
  expect(asked.binary).toBe(true);
  node.send({ t: "node_action_result", id: asked.id, ok: true, message: "m".repeat(300) });
  expect((await long).message).toBe("m".repeat(300));
  node.close();
  await node.closed;
});

test("a heartbeat keeps the status; a low disk pauses new agents; silence takes the machine offline", async () => {
  const saved = links.timings;
  links.timings = { ...saved, silenceMs: 150 };
  const node = await linked("worker-7");
  await until(() => types().includes("machine.online worker-7"));
  const disk = (free: number) => ({ cpus: 8, load1: 1, disk: { freeBytes: free, totalBytes: 1e12, minFreeBytes: 100e9 } });
  node.send({ t: "hb", at: new Date().toISOString(), load: disk(14e9), busy: { threads: 1, screens: 0, uploads: 0, hosted: 0 } });
  await until(() => links.paused("worker-7") !== undefined);
  expect(links.paused("worker-7")).toBe("Paused new agents: 14 GB free on worker-7");
  expect(links.busy("worker-7")).toEqual({ threads: 1, screens: 0, uploads: 0, hosted: 0 });
  node.send({ t: "hb", at: new Date().toISOString(), load: disk(500e9) });
  await until(() => links.paused("worker-7") === undefined);
  const guard = events(hub)
    .page(0)
    .events.filter((e) => e.type === "machine.guard")
    .map((e) => [e.summary, e.data]);
  expect(guard).toEqual([
    ["Paused new agents: 14 GB free on worker-7", { paused: true }],
    ["New agents start again on worker-7", { paused: false }],
  ]);
  const closed = await node.closed;
  expect(closed).toEqual({ code: 4008, reason: "no frame for 0 s" });
  expect(store(hub).machineGet("worker-7")?.status).toBe("offline");
  expect(types()).toContain("machine.offline worker-7");
  links.timings = saved;
});

test("a node removed from the hub is ended at its next heartbeat", async () => {
  const node = await linked("worker-8");
  hub.auth.nodes.revokeNode("worker-8");
  node.send({ t: "hb", at: new Date().toISOString() });
  expect(await node.closed).toEqual({ code: 4001, reason: "worker-8 was removed from this hub: its node key is revoked" });
});

test("onLinked hears each welcome; a slept node's span is kept", async () => {
  const heard: string[] = [];
  const off = links.onLinked(({ machineId, hello }) => heard.push(`${machineId} ${hello.nodeVersion}`));
  const node = await linked("worker-9");
  expect(heard).toEqual(["worker-9 0.0.0-test"]);
  off();
  node.send({ t: "slept", fromMs: 1_000, toMs: 647_000 });
  await until(() => types().includes("machine.slept worker-9"));
  expect(store(hub).machineGet("worker-9")?.lastSlept).toEqual({ fromMs: 1_000, toMs: 647_000 });
  expect(events(hub).page(0).events.find((e) => e.type === "machine.slept")?.summary).toBe("worker-9 slept 10m46s");
  node.close();
  await node.closed;
});

test("a long close reason is cut at 123 bytes on a character", () => {
  expect(closeReason("é".repeat(100))).toBe(`${"é".repeat(59)}...`);
  expect(Buffer.byteLength(closeReason("x".repeat(500)))).toBe(122);
});

test("a lead call is answered on its link with a lead_result for its id", async () => {
  const node = await linked("worker-10");
  node.send({ t: "lead_call", id: "call-1", cwd: "/nowhere", call: { op: "factory_status" } });
  const result = await node.next((f) => f.t === "lead_result");
  expect(result.id).toBe("call-1");
  expect(result.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  node.close();
  await node.closed;
});

test("cmd_check gets its cmd_result; the hub beats every heartbeatMs", async () => {
  const saved = links.timings;
  links.timings = { ...saved, heartbeatMs: 20 };
  const node = await linked("worker-11");
  await node.tag("hb");
  const run = links.commands.run("worker-11", { cwd: "/srv", argv: ["git", "status"], timeoutSec: 5 });
  const asked = await node.next((f) => f.t === "cmd_check");
  expect(asked).toMatchObject({ cwd: "/srv", argv: ["git", "status"], timeoutSec: 5 });
  node.send({ t: "cmd_result", id: asked.id, exitCode: 0, outputTail: "clean", timedOut: false });
  expect(await run).toMatchObject({ exitCode: 0, outputTail: "clean" });
  await expect(links.commands.run("worker-11", { cwd: "rel", argv: ["x"] })).rejects.toThrow("cwd must be absolute, got rel");
  links.timings = saved;
  node.close();
  await node.closed;
});

test("start() takes a machine the store says is online offline when no node links", async () => {
  const saved = links.timings;
  links.timings = { ...saved, silenceMs: 30 };
  store(hub).machineUpsert({ machineId: "ghost", name: "ghost", tags: [], status: "online", lastSeenAt: "2026-11-08T00:00:00.000Z", nodeVersion: "1" });
  links.start();
  await until(() => store(hub).machineGet("ghost")?.status === "offline");
  expect(store(hub).machineGet("ghost")?.lastSeenAt).toBe("2026-11-08T00:00:00.000Z");
  links.timings = saved;
});

test("secret, gated and resumed runs get their own replies; spans and clone progress reach on()", async () => {
  const node = await linked("worker-12");
  const pairs = [
    [{ t: "secret_deliver", sink: { kind: "env" }, sealed: "c2VhbGVk", secretKey: "token" }, { t: "secret_result", fingerprint: "ab12cd34" }],
    [{ t: "gated_run", argv: ["make"], cwd: "/srv", timeoutSec: 5 }, { t: "gated_result", exitCode: 0, outputTail: "", timedOut: false }],
    [{ t: "gated_resume", requestId: "r1", timeoutSec: 5 }, { t: "gated_result", exitCode: null, outputTail: "", timedOut: false, unknown: "restarted" }],
  ] as const;
  for (const [ask, answer] of pairs) {
    const reply = links.request("worker-12", ask as never);
    const asked = await node.next((f) => f.t === ask.t && !f.answered);
    asked.answered = true;
    node.send({ ...answer, id: asked.id });
    expect(await reply).toMatchObject({ ...answer, id: asked.id as string });
  }
  const seen: string[] = [];
  const offs = [links.on("spans", (m, f) => seen.push(`${m} ${f.t}`)), links.on("clone_progress", (m, f) => seen.push(`${m} ${f.t}`))];
  node.send({ t: "spans", fromRid: 1, toRid: 1, spans: [] });
  node.send({ t: "clone_progress", id: "c1", phase: "receiving", percent: 10 });
  await until(() => seen.length === 2);
  expect(seen).toEqual(["worker-12 spans", "worker-12 clone_progress"]);
  for (const off of offs) off();
  node.close();
  await node.closed;
});

test("start() makes the activity tracker, so the executor's first thread events have somewhere to go", async () => {
  const { start } = await import("../src/hub/link/loops.ts");
  const fresh = hubHome();
  const built = build(fresh.dir, { host: "127.0.0.1", port: 0 });
  expect((built.hub as unknown as { areas: Map<string, unknown> }).areas.has("activity")).toBe(false);
  start(built.hub);
  expect((built.hub as unknown as { areas: Map<string, unknown> }).areas.has("activity")).toBe(true);
  built.hub.shutdown.abort();
  built.hub.db.close();
  fresh.done();
});

test("the usage soft brake pauses new agents at its figure, holds above the lift, and resumes below it", async () => {
  const node = await linked("worker-13");
  const resets = new Date(Date.now() + 3_600_000).toISOString();
  const beat = (utilization: number) =>
    node.send({
      t: "hb",
      at: new Date().toISOString(),
      load: { cpus: 8, load1: 1, limits: [{ limitType: "five_hour", utilization, resetsAt: resets, status: "allowed" }] },
    });
  beat(0.95);
  await until(() => links.paused("worker-13") !== undefined);
  expect(links.paused("worker-13")).toStartWith("Paused new agents: 5-hour limit 95% on worker-13");
  beat(0.87);
  await Bun.sleep(30);
  expect(links.paused("worker-13")).toStartWith("Paused new agents: 5-hour limit 87% on worker-13");
  beat(0.5);
  await until(() => links.paused("worker-13") === undefined);
  const guard = events(hub)
    .page(0)
    .events.filter((e) => e.type === "machine.guard" && e.machineId === "worker-13")
    .map((e) => e.data);
  expect(guard).toEqual([{ paused: true }, { paused: false }]);
  node.close();
  await node.closed;
});
