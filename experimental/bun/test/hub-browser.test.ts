import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { live } from "../src/hub/browser/live.ts";
import { endOutlived, get, prune, tellNodes } from "../src/hub/browser/store.ts";
import { Pace } from "../src/hub/browser/pace.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { addMachine, addProject, agent, as, caller, fakeSocket, testHub, tick } from "./screens_helpers.ts";

const S1 = "B11111111111111111111111111111111";
const S2 = "B22222222222222222222222222222222";
let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

function setup() {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox");
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["browser", "session_end", "screen_settings"]);
  return t;
}

const report = (state: string, extra: Record<string, unknown> = {}) => ({
  op: "browser_session",
  sessionId: S1,
  threadId: "t1",
  purpose: "check the page",
  state,
  control: "agent",
  startedAt: "2026-11-08T12:00:00.000Z",
  ...extra,
});

test("a node's session report is filed under its project and task, and tells the app", async () => {
  setup();
  const answer = await t.calls.call(agent("devbox", "p1", "T7"), report("live"));
  expect(answer).toEqual({ result: { sessionId: S1, state: "live" } });
  expect(get(t.hub, S1)).toMatchObject({ projectRef: { machineId: "devbox", projectId: "p1" }, taskId: "T7", state: "live" });
  expect(t.events.appended.at(-1)).toMatchObject({ type: "browser.session", summary: "screen of T7: live", threadId: "t1" });
  // Another project's session is refused; a person's shell gets nothing.
  expect((await t.calls.call(agent("devbox", "p2"), report("live"))).error?.code).toBe("forbidden");
  expect((await t.calls.call({ ...agent("devbox", "p1"), agent: { kind: "person" } }, report("live"))).error?.code).toBe(
    "forbidden",
  );
});

test("a recording uploads in pieces, records only with every byte, and reads back", async () => {
  setup();
  const who = agent("devbox", "p1");
  await t.calls.call(who, report("live"));
  const piece = (offset: number, text: string) => ({
    op: "browser_recording_part",
    sessionId: S1,
    file: "actions",
    offset,
    dataB64: Buffer.from(text).toString("base64"),
  });
  expect((await t.calls.call(who, piece(0, "hello "))).result).toEqual({ sessionId: S1, file: "actions", bytes: 6 });
  // A gap is refused; a piece again replaces what it wrote.
  expect((await t.calls.call(who, piece(9, "x"))).error?.fix).toBe("send the piece at offset 6");
  await t.calls.call(who, piece(6, "world"));
  await t.calls.call(who, piece(6, "there"));
  const short = await t.calls.call(who, report("recorded", { files: [{ file: "actions", bytes: 99 }] }));
  expect(short.error?.message).toContain("holds 11 bytes");
  await t.calls.call(who, report("recorded", { files: [{ file: "actions", bytes: 11 }] }));
  // Final: a late live report changes nothing.
  expect((await t.calls.call(who, report("live"))).result).toEqual({ sessionId: S1, state: "recorded" });
  const got = await t.tools.call(t.hub, caller("read"), "browser_recording_get", { sessionId: S1, file: "actions" });
  expect(got).toMatchObject({ output: { dataB64: Buffer.from("hello there").toString("base64"), done: true, bytes: 11 } });
  // Knowing an id gives nothing on a machine the key can't read.
  const other = await t.tools.call(t.hub, caller("read", { machines: ["elsewhere"] }), "browser_recording_get", {
    sessionId: S1,
    file: "actions",
  });
  expect(other).toMatchObject({ error: { error: { code: "not_found" } } });
});

test("takeover goes to the node and changes only once it reports", async () => {
  setup();
  const who = agent("devbox", "p1");
  await t.calls.call(who, report("live"));
  await t.calls.call(who, { op: "browser_takeover", sessionId: S1, reason: "a captcha" });
  expect(t.events.appended.at(-1)).toMatchObject({ attention: "loud", summary: "Needs you on its screen: a captcha" });
  const person = caller("operate", { kind: "human", name: "phone" });
  const call = t.tools.call(t.hub, person, "browser_control", { sessionId: S1, control: "human" });
  await tick();
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_control", sessionId: S1, control: "human", by: "human:phone" });
  await t.calls.call(who, report("live", { control: "human" }));
  expect(await call).toMatchObject({ output: { session: { control: "human" } } });
  expect(get(t.hub, S1)?.takeoverReason).toBeUndefined();
  // An agent's key can't take a screen over.
  expect(await t.tools.call(t.hub, caller("operate"), "browser_control", { sessionId: S1, control: "human" })).toMatchObject({
    error: { error: { code: "forbidden" } },
  });
});

test("one node frame reaches every watcher; a slow one skips to the newest, and the slowest's budget is told", async () => {
  setup();
  await t.calls.call(agent("devbox", "p1"), report("live"));
  const person = caller("read", { kind: "human" });
  const fast = fakeSocket();
  const slow = fakeSocket();
  await t.app.deliver(as(fast, person), { t: "browser_watch", session: S1 });
  await t.app.deliver(as(slow, person), { t: "browser_watch", session: S1, acks: true });
  expect(t.link.sent("devbox").filter((f: { t: string }) => f.t === "browser_watch")).toEqual([
    { t: "browser_watch", sessionId: S1, on: true },
    { t: "browser_watch", sessionId: S1, on: true },
  ]);
  const frame = (seq: number) => ({ t: "browser_frame", sessionId: S1, seq, jpegB64: "AAAA", width: 1, height: 1, control: "agent" });
  for (let seq = 1; seq <= 5; seq++) t.link.deliver("devbox", frame(seq));
  expect(fast.sent.map((f) => (f as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5]);
  // The acking one has two in flight, then waits: its slot keeps only the newest.
  expect(slow.sent.map((f) => (f as { seq: number }).seq)).toEqual([1, 2]);
  await t.app.deliver(as(slow, person), { t: "browser_frame_ack", seq: 2 });
  expect(slow.sent.map((f) => (f as { seq: number }).seq)).toEqual([1, 2, 5]);
  // A frame of a node that isn't the session's goes nowhere.
  t.link.link("other", ["browser"]);
  t.link.deliver("other", frame(6));
  expect(fast.sent).toHaveLength(5);
  // The node links again: it hears of the watch again.
  t.link.link("devbox", ["browser"]);
  expect(t.link.sent("devbox")).toEqual([{ t: "browser_watch", sessionId: S1, on: true }]);
  t.app.close(fast);
  t.app.close(slow);
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_watch", sessionId: S1, on: false });
  expect(live(t.hub).watchers(S1)).toBe(0);
});

test("a watch of a session that ended, or with no node, is refused on the socket", async () => {
  setup();
  const person = caller("read", { kind: "human" });
  const socket = fakeSocket();
  await t.app.deliver(as(socket, person), { t: "browser_watch", session: "nope" });
  expect(socket.sent).toEqual([{ t: "error", code: "not_found", message: "No screen nope.", fix: "Call browser_sessions for the project's screens." }]);
});

test("a person's input goes to the node only while they drive", async () => {
  setup();
  const who = agent("devbox", "p1");
  await t.calls.call(who, report("live"));
  const person = caller("operate", { kind: "human" });
  const socket = fakeSocket();
  const input = { kind: "key", key: "a" };
  await t.app.deliver(as(socket, person), { t: "browser_input", session: S1, input });
  expect((socket.sent[0] as { code: string }).code).toBe("invalid");
  await t.calls.call(who, report("live", { control: "human" }));
  await t.app.deliver(as(socket, person), { t: "browser_input", session: S1, input });
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_input", sessionId: S1, input });
  expect(live(t.hub).lastInput(S1)).toBe(t.clock.now());
});

test("a screen whose task ended is ended on the hub, and its node told once per link", async () => {
  setup();
  t.hub.db.conn
    .query(
      "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (7, 'devbox', 'p1', 'W1', 'cancelled', '{}')",
    )
    .run();
  await t.calls.call(agent("devbox", "p1", "T7"), report("live"));
  // The report's event wakes the hub's loop, which ends it and tells its node.
  await tick();
  expect(get(t.hub, S1)).toMatchObject({ state: "lost", note: "its task ended with it still open, so the hub ended it" });
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "session_end", threadId: "t1", sessionId: S1 });
  expect(endOutlived(t.hub)).toBe(0);
  // Told once per link: again after the node links again.
  const told = new Map<string, number>();
  expect(tellNodes(t.hub, told)).toBe(1);
  expect(tellNodes(t.hub, told)).toBe(0);
  t.link.link("devbox", ["session_end"]);
  expect(tellNodes(t.hub, told)).toBe(1);
});

test("retention expires old recordings and a project's oldest past its size", async () => {
  setup();
  const who = agent("devbox", "p1");
  const [OLD, NEW] = [`B${"a".repeat(32)}`, `B${"c".repeat(32)}`];
  for (const [id, day] of [[OLD, "2026-09-01"], [NEW, "2026-11-07"]] as const) {
    await t.calls.call(who, report("live", { sessionId: id, startedAt: `${day}T00:00:00.000Z` }));
    await t.calls.call(who, { op: "browser_recording_part", sessionId: id, file: "dom", offset: 0, dataB64: "AAAA" });
    await t.calls.call(who, report("recorded", { sessionId: id, startedAt: `${day}T00:00:00.000Z`, files: [{ file: "dom", bytes: 3 }] }));
  }
  expect(prune(t.hub)).toBe(1);
  expect(get(t.hub, OLD)).toMatchObject({ state: "expired", files: [] });
  expect(get(t.hub, NEW)?.state).toBe("recorded");
  const set = await t.tools.call(t.hub, caller("admin", { machines: ["devbox"] }), "browser_retention_set", {
    retentionDays: 7,
    maxGbPerProject: 1,
  });
  expect(set).toMatchObject({ error: { error: { code: "forbidden" } } });
});

test("screens_count counts live screens and those asking for a person", async () => {
  setup();
  const who = agent("devbox", "p1");
  await t.calls.call(who, report("live"));
  await t.calls.call(who, report("live", { sessionId: S2 }));
  await t.calls.call(who, { op: "browser_takeover", sessionId: S2, reason: "sign in" });
  expect(await t.tools.call(t.hub, caller("read"), "screens_count", {})).toEqual({ output: { live: 2, asking: 1 } });
  expect(await t.tools.call(t.hub, caller("read", { machines: ["x"] }), "screens_count", {})).toEqual({
    output: { live: 0, asking: 0 },
  });
});

test("a thumbnail round watches each live screen for one frame and makes it small", async () => {
  setup();
  await t.calls.call(agent("devbox", "p1"), report("live"));
  const viewer = fakeSocket();
  await t.app.deliver(as(viewer, caller("read", { kind: "human" })), { t: "screen_thumbs", on: true });
  const jpeg = await new Bun.Image(
    await new Bun.Image(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"))
      .resize(1280, 800)
      .png()
      .bytes(),
  )
    .jpeg({ quality: 80 })
    .bytes();
  // Showing the page starts a round at once: a short watch of each live screen.
  await tick();
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_watch", sessionId: S1, on: true });
  t.link.deliver("devbox", {
    t: "browser_frame",
    sessionId: S1,
    seq: 1,
    jpegB64: Buffer.from(jpeg).toString("base64"),
    width: 1280,
    height: 800,
    control: "agent",
  });
  await Bun.sleep(50);
  expect(t.link.sent("devbox").at(-1)).toEqual({ t: "browser_watch", sessionId: S1, on: false });
  expect(viewer.sent[0]).toMatchObject({ t: "screen_thumb", sessionId: S1, width: 640, height: 400 });
});

test("pace: a slow link sends a big frame alone and says what it carries", () => {
  // Ported from app_ws/pace.rs: 1 Mbit/s, 300 ms round trips, a frame every 100 ms, for 30 s.
  const FRAME = 100_000;
  const pace = new Pace();
  const bytesPerMs = 125;
  const rtt = 300;
  let wireFree = 0;
  const acks: [number, number][] = [];
  let waiting: number | undefined;
  let seq = 0;
  let went = 0;
  for (let now = 0, next = 0; now < 30_000; now += 5) {
    acks.sort((a, b) => a[0] - b[0]);
    while (acks[0] && acks[0][0] <= now) {
      const [, s] = acks.shift()!;
      if (s === 0) pace.pong(now);
      else pace.acked(s, now);
    }
    if (now >= next) {
      waiting = ++seq;
      next += 100;
    }
    if (waiting !== undefined) {
      if (pace.room(now).ok) {
        if (pace.ping(now)) acks.push([Math.max(wireFree, now) + rtt, 0]);
        pace.sent(waiting, FRAME, now);
        wireFree = Math.max(wireFree, now) + FRAME / bytesPerMs;
        acks.push([wireFree + rtt, waiting]);
        waiting = undefined;
        went += 1;
      } else pace.waited(now);
    }
  }
  expect(went).toBeGreaterThanOrEqual(32);
  expect(went).toBeLessThanOrEqual(40);
  const kbps = pace.kbps();
  expect(kbps).toBeGreaterThanOrEqual(800);
  expect(kbps).toBeLessThanOrEqual(1100);
});

test("a node's browser call decodes as the contract has it before it reaches the disk", async () => {
  setup();
  const who = agent("devbox", "p1");
  const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const sentinel = join(t.hub.config.home, "sentinel");
  mkdirSync(join(t.hub.config.home, "browser"), { recursive: true });
  writeFileSync(sentinel, "keep");
  for (const sessionId of ["x/../../sentinel", "..", "../sentinel", "B" + "0".repeat(31), "b" + "0".repeat(32)]) {
    for (const call of [
      report("lost", { sessionId }),
      { op: "browser_recording_part", sessionId, file: "actions", offset: 0, dataB64: "AAAA" },
      { op: "browser_takeover", sessionId, reason: "x" },
    ]) {
      const answer = await t.calls.call(who, call);
      expect(answer.error).toMatchObject({ code: "invalid", message: expect.stringContaining("sessionId") });
    }
  }
  expect(existsSync(sentinel)).toBe(true);
  expect(existsSync(join(t.hub.db.path ?? join(t.hub.config.home, "hub.sqlite")))).toBe(true);
  await t.calls.call(who, report("live"));
  for (const file of ["toString", "__proto__", "constructor", "nope"]) {
    const part = await t.calls.call(who, { op: "browser_recording_part", sessionId: S1, file, offset: 0, dataB64: "AAAA" });
    expect(part.error).toMatchObject({ code: "invalid", message: expect.stringContaining("file") });
    const recorded = await t.calls.call(who, report("recorded", { files: [{ file, bytes: 1 }] }));
    expect(recorded.error).toMatchObject({ code: "invalid", message: expect.stringContaining("files[0].file") });
  }
  expect((await t.calls.call(who, report("gone"))).error).toMatchObject({ code: "invalid", message: expect.stringContaining("state") });
  expect((await t.calls.call(who, report("live", { files: [{ file: "dom", bytes: -1 }] }))).error?.code).toBe("invalid");
});

test("the hub's loops bind the live view to the hub's own /app when nothing else is bound", async () => {
  const { tempHome } = await import("./helpers.ts");
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { HubDb } = await import("../src/hub/store/db.ts");
  const { appWs: realAppWs } = await import("../src/hub/app_ws/index.ts");
  const { appBound, appWs: boundApp } = await import("../src/hub/browser/app.ts");
  const home = tempHome();
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, HubDb.open(home.dir), t?.clock ?? { now: () => Date.now() });
  try {
    expect(appBound(hub)).toBe(false);
    startBrowser(hub);
    expect(appBound(hub)).toBe(true);
    expect(boundApp(hub)).toBe(realAppWs(hub) as never);
  } finally {
    hub.shutdown.abort();
    hub.db.close();
    home.done();
  }
});
