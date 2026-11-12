import { afterAll, expect, test } from "bun:test";
import { appWs } from "../src/hub/app_ws/index.ts";
import { doctor } from "../src/hub/doctor/index.ts";
import { updates } from "../src/hub/update/tools.ts";
import { serve, stop } from "../src/hub/http/index.ts";
import { build } from "../src/hub/serve/index.ts";
import { events, type NewEvent } from "../src/hub/store/events.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";
import { FakeApp } from "./fake-app.ts";
import { deflateBomb, hubHome, insertKey } from "./helpers.ts";

const home = hubHome();
const { hub, tools } = build(home.dir, { host: "127.0.0.1", port: 0 });
tools.add("fleetd_status", () => ({ machines: [], projects: [], attention: [], cursor: events(hub).head() }) as never);
// setup_list runs the doctor's first pass: its probes are stand-ins, so the answer never waits on the runner's own gh.
const probes = doctor(hub);
probes.health = async () => ({ ok: true });
probes.runCmd = async () => ({ ran: false, error: "ENOENT" });
const server = serve(hub, tools, 0);
const url = `ws://127.0.0.1:${server.port}/app`;
afterAll(async () => {
  hub.shutdown.abort();
  await stop(server);
  hub.db.close();
  home.done();
});

const all = [{ role: "admin" as const, machines: "*" as const }];
const append = (machineId: string | undefined, summary: string) =>
  events(hub).append({ at: new Date().toISOString(), type: "machine.online", ...(machineId ? { machineId } : {}), summary } as NewEvent);

async function authed(key: string, features?: string[]) {
  const app = new FakeApp(url);
  await app.send({ t: "auth", key, ...(features ? { features } : {}) });
  const ready = await app.tag("ready");
  return { app, ready };
}

test("a refused key gets the refusal, then the close as unauthorized", async () => {
  const app = new FakeApp(url);
  await app.send({ t: "auth", key: `fld_${"a".repeat(52)}` });
  expect(await app.tag("error")).toMatchObject({ code: "forbidden", message: "unknown agent key" });
  expect(await app.closed).toEqual({ code: 4401, reason: "unauthorized" });
});

test("before auth a call is refused by its id; a malformed frame says what to send", async () => {
  const app = new FakeApp(url);
  await app.send({ t: "call", id: "c1", tool: "hub_info", input: {} });
  expect(await app.tag("error")).toMatchObject({ id: "c1", code: "forbidden", message: "Not authenticated.", fix: "Send {t:auth,key} first." });
  await app.send({ t: "nonsense", id: "c2" });
  expect(await app.tag("error")).toMatchObject({ id: "c2", code: "invalid", message: "Unknown or malformed message." });
  await app.send("not json");
  expect(await app.tag("error")).toMatchObject({ code: "invalid", fix: "Send {t:auth|snapshot|events}." });
  app.close();
});

test("auth, ready, snapshot and calls", async () => {
  const key = insertKey(hub.db, all, "desk");
  const { app, ready } = await authed(key);
  expect(ready).toMatchObject({ protocol: PROTOCOL_VERSION, version: "0.0.0" });
  expect(ready.features).toContain("deflate");
  await app.send({ t: "snapshot" });
  expect(await app.tag("snapshot")).toMatchObject({ machines: [], projects: [], attention: [] });
  await app.send({ t: "call", id: "1", tool: "no_such_tool", input: {} });
  expect(await app.tag("error")).toMatchObject({ id: "1", code: "not_found", message: "No tool no_such_tool." });
  await app.send({ t: "call", id: "2", tool: "fleetd_status", input: {} });
  expect(await app.tag("result")).toMatchObject({ id: "2", output: { machines: [] } });
  await app.send({ t: "call", id: "3", tool: "hub_links_get", input: {} });
  expect(await app.next((f) => f.id === "3")).toMatchObject({ t: "result", output: { links: [], issued: [] } });
  app.close();
});

test("events stream from the cursor, then as they happen, only for machines the key reads", async () => {
  const before = append("devbox", "before");
  append("secret-box", "not for this key");
  const key = insertKey(hub.db, [{ role: "read", machines: ["devbox"] }], "reader");
  const { app } = await authed(key);
  await app.send({ t: "events", cursor: before.seq - 1 });
  expect(await app.tag("event")).toMatchObject({ seq: before.seq, summary: "before", machineId: "devbox" });
  const hubWide = append(undefined, "the hub's own");
  append("secret-box", "still not");
  const after = append("devbox", "after");
  expect(await app.tag("event")).toMatchObject({ seq: hubWide.seq });
  expect(await app.tag("event")).toMatchObject({ seq: after.seq, summary: "after" });
  expect(app.frames.filter((f) => f.t === "event").map((f) => f.summary)).toEqual(["before", "the hub's own", "after"]);
  // A new `events` replaces the stream.
  await app.send({ t: "events", cursor: after.seq });
  const last = append("devbox", "last");
  expect(await app.tag("event")).toMatchObject({ seq: last.seq });
  app.close();
});

test("the upgrade's own auth answers ready and snapshot before any frame; the client's own are skipped", async () => {
  const key = insertKey(hub.db, all, "phone");
  const app = new FakeApp(url, { authorization: `Bearer ${key}`, "x-fleetd-features": "presence, deflate" });
  expect(await app.tag("ready")).toMatchObject({ binary: false });
  expect(await app.tag("snapshot")).toBeDefined();
  await app.send({ t: "auth", key, features: ["deflate"] });
  await app.send({ t: "snapshot" });
  await app.send({ t: "call", id: "x", tool: "fleetd_status", input: {} });
  await app.next((f) => f.id === "x");
  expect(app.frames.filter((f) => f.t === "ready" || f.t === "snapshot").length).toBe(2);
  app.close();
});

test("deflate: frames after ready may come compressed", async () => {
  const key = insertKey(hub.db, all, "zip");
  const { app, ready } = await authed(key, ["deflate"]);
  expect(ready.binary).toBe(false);
  await app.send({ t: "call", id: "z", tool: "fleetd_status", input: {} });
  const result = await app.next((f) => f.id === "z");
  expect(result.binary).toBe(true);
  expect(result.output).toMatchObject({ machines: [] });
  app.close();
});

test("a compressed frame that inflates past the cap, or isn't DEFLATE, closes the connection as bad data", async () => {
  const key = insertKey(hub.db, all, "zip-bad");
  for (const frame of [await deflateBomb(65), new Uint8Array(16).fill(0xff)]) {
    const { app } = await authed(key, ["deflate"]);
    app.ws.send(frame);
    expect(await app.closed).toEqual({ code: 1007, reason: "a compressed frame does not inflate" });
  }
});

test("a key revoked on this hub closes its connections as unauthorized", async () => {
  const key = insertKey(hub.db, all, "lost");
  const { app } = await authed(key);
  hub.db.conn.query("UPDATE agent_keys SET revoked_ms = 1 WHERE name = 'lost'").run();
  hub.auth.revokedSome();
  expect(await app.tag("error")).toMatchObject({ code: "forbidden" });
  expect(await app.closed).toEqual({ code: 4401, reason: "unauthorized" });
});

test("presence: a human key's focused minute with input on a known project is one app.presence event", async () => {
  hub.db.conn
    .query("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'p1', '', '', '{}')")
    .run();
  const key = insertKey(hub.db, all, "ada");
  hub.db.conn.query("UPDATE agent_keys SET kind = 'human' WHERE name = 'ada'").run();
  const { app } = await authed(key);
  const head = events(hub).head();
  const project = { machineId: "devbox", projectId: "p1" };
  await app.send({ t: "presence", focused: true, input: true, project });
  await app.send({ t: "presence", focused: true, input: true, project });
  await app.send({ t: "presence", focused: false, input: true, project: { machineId: "devbox", projectId: "nope" } });
  await app.send({ t: "call", id: "sync", tool: "fleetd_status", input: {} });
  await app.next((f) => f.id === "sync");
  const presence = events(hub)
    .page(head)
    .events.filter((e) => e.type === "app.presence");
  expect(presence).toHaveLength(1);
  expect(presence[0]).toMatchObject({ machineId: "devbox", projectId: "p1", summary: "app in use", data: { by: "ada" } });
  app.close();
});

test("the seam: on(type) serves an area's message, sendTo answers it, onClose hears the end", async () => {
  const ws = appWs(hub);
  let closed = 0;
  const off = ws.on("chat", (conn, message) => {
    ws.sendTo(conn, { t: "chat_delta", echo: message.project });
    ws.onClose(conn, () => closed++);
  });
  const key = insertKey(hub.db, all, "chatter");
  const { app } = await authed(key);
  await app.send({ t: "screen_thumbs", on: true });
  expect(await app.tag("error")).toMatchObject({ code: "failed", message: "fleetd doesn't do this yet: src/hub/browser (app message screen_thumbs)" });
  await app.send({ t: "chat", project: { machineId: "devbox", projectId: "p1" } });
  expect(await app.tag("chat_delta")).toMatchObject({ echo: { machineId: "devbox", projectId: "p1" } });
  ws.broadcast({ t: "hello_all" });
  await app.tag("hello_all");
  app.close();
  await app.closed;
  for (let i = 0; i < 100 && closed === 0; i++) await Bun.sleep(5);
  expect(closed).toBe(1);
  off();
});

test("each frame runs on the key as it is now: a person lowered to member loses admin on their open connection", async () => {
  const key = insertKey(hub.db, all, "demoted");
  hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_demotedd', 'Dem', 'owner', 5)");
  hub.db.conn.run("UPDATE agent_keys SET kind = 'human', person_id = 'p_demotedd' WHERE name = 'demoted'");
  const { app } = await authed(key);
  // setup_list wants admin: an admin's call passes the role and is answered.
  await app.send({ t: "call", id: "a1", tool: "setup_list", input: {} });
  expect(await app.next((f) => f.id === "a1")).toMatchObject({ t: "result" });
  hub.db.conn.run("UPDATE people SET role = 'member' WHERE person_id = 'p_demotedd'");
  await app.send({ t: "call", id: "a2", tool: "setup_list", input: {} });
  expect(await app.next((f) => f.id === "a2")).toMatchObject({ t: "error", code: "forbidden" });
  app.close();
});

test("a deflate connection whose key is revoked still gets the refusal before the close", async () => {
  const key = insertKey(hub.db, all, "zip-lost");
  const { app } = await authed(key, ["deflate"]);
  hub.db.conn.query("UPDATE agent_keys SET revoked_ms = 1 WHERE name = 'zip-lost'").run();
  hub.auth.revokedSome();
  expect(await app.tag("error")).toMatchObject({ code: "forbidden", message: expect.stringContaining("was revoked") });
  expect(await app.closed).toEqual({ code: 4401, reason: "unauthorized" });
});

test("a cursor past head streams new events from head", async () => {
  const key = insertKey(hub.db, all, "ahead");
  const { app } = await authed(key);
  await app.send({ t: "events", cursor: events(hub).head() + 1000 });
  await app.send({ t: "call", id: "sync", tool: "fleetd_status", input: {} });
  await app.next((f) => f.id === "sync");
  const next = append("devbox", "after a restore");
  expect(await app.tag("event")).toMatchObject({ seq: next.seq, summary: "after a restore" });
  app.close();
});

test("a presence frame with a malformed project is refused as malformed", async () => {
  const key = insertKey(hub.db, all, "badpresence");
  const { app } = await authed(key);
  await app.send({ t: "presence", focused: true, input: true, project: { machineId: "Dev Box" } });
  expect(await app.tag("error")).toMatchObject({ code: "invalid", message: "Unknown or malformed message." });
  app.close();
});

/** A hub of its own, with the snapshot's status tool: the test stops it. */
function ownHub() {
  const home = hubHome();
  const built = build(home.dir, { host: "127.0.0.1", port: 0 });
  built.tools.add("fleetd_status", () => ({ machines: [], projects: [], attention: [], cursor: 0 }) as never);
  const server = serve(built.hub, built.tools, 0);
  const done = async () => {
    built.hub.shutdown.abort();
    await stop(server);
    built.hub.db.close();
    home.done();
  };
  return { hub: built.hub, url: `ws://127.0.0.1:${server.port}/app`, done };
}

test("a hub that stops closes its apps as going away, saying it restarts; with no update, the snapshot has none", async () => {
  const own = ownHub();
  updates(own.hub);
  const app = new FakeApp(own.url);
  await app.send({ t: "auth", key: insertKey(own.hub.db, all, "desk") });
  await app.tag("ready");
  await app.send({ t: "snapshot" });
  expect("update" in (await app.tag("snapshot"))).toBe(false);
  await own.done();
  expect(await app.closed).toEqual({ code: 1001, reason: "hub restarting" });
});

test("while an update restarts the hub, the snapshot has it and the close names the build the hub comes back on", async () => {
  const own = ownHub();
  const from = "0.0.0-nightly.202611070900+aaaaaaa";
  const to = "0.0.0-nightly.202611081000+bbbbbbb";
  updates(own.hub).driveForTest({
    id: "U1",
    channel: "edge",
    to,
    startedAt: "2026-11-08T10:00:00.000Z",
    parts: [
      { part: "hub", name: "the hub", from, state: "restarting" },
      { part: "node", machineId: "devbox", name: "devbox", from, state: "waiting" },
    ],
  });
  const app = new FakeApp(own.url);
  await app.send({ t: "auth", key: insertKey(own.hub.db, [{ role: "read", machines: "*" }], "phone") });
  await app.tag("ready");
  await app.send({ t: "snapshot" });
  const { update } = (await app.tag("snapshot")) as unknown as { update: { state: string; hub: string; machines: { state: string }[] } };
  expect([update.state, update.hub, update.machines[0]!.state]).toEqual(["updating", "restarting", "waiting"]);
  await own.done();
  expect(await app.closed).toEqual({ code: 1001, reason: `updating to ${to}` });
});
