// The team's own Revyl on the hub (hub/revyl): the key connected through a sealed value, tested and removed, never
// shown; each phone kind's route in all three modes; the line for the team's machines; and with no key, today's
// placement. A stand-in `revyl` answers (revyl_standin.ts): nothing reaches Revyl.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { boxKey } from "../src/hub/hub_links/store.ts";
import { choose, mask, refusal, routeOf } from "../src/shared/revyl.ts";
import { pngSize, inputArgv } from "../src/node/revyl/index.ts";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { addMachine, addProject, agent, caller, testHub } from "./screens_helpers.ts";
import { BAD, GOOD, standIn } from "./revyl_standin.ts";

let t: ReturnType<typeof testHub>;
let s: ReturnType<typeof standIn>;
const KEY = Buffer.alloc(32, 7).toString("base64");
const admin = caller("admin", { kind: "human", name: "ana" });
const member = caller("read", { kind: "human", name: "ben" });

beforeEach(() => {
  s = standIn();
  process.env.FLEETD_REVYL_BIN = s.bin;
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
});
afterEach(() => {
  delete process.env.FLEETD_REVYL_BIN;
  t?.done();
  s?.done();
});

const sealed = (key: string) => Buffer.from(seal(publicKeyOf(boxKey(t.hub)), new TextEncoder().encode(JSON.stringify({ key })))).toString("base64");
/** A tool call's output, or its refusal thrown. */
async function call(who: typeof admin, tool: string, input: Record<string, unknown> = {}): Promise<any> {
  const r = await t.tools.call(t.hub, who, tool, input);
  if ("output" in r) return r.output;
  throw new Error(r.error.kind === "tool" ? r.error.error.message : r.error.kind);
}

test("connect: the sealed key is kept sealed, checked at once, and never comes back", async () => {
  const before = await call(member, "revyl_get");
  expect(before).toMatchObject({ connected: false, routes: { ios: "ours_only", android: "ours_only" } });
  expect(before.boxPubKey).toBe(Buffer.from(publicKeyOf(boxKey(t.hub))).toString("base64"));
  await expect(call(member, "revyl_connect", { sealed: sealed(GOOD) })).rejects.toThrow();
  const on = await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  expect(on.connected).toBe(true);
  expect(on.check).toMatchObject({ ok: true });
  expect(on.routes).toEqual({ ios: "ours_first", android: "ours_first" });
  // Ran `revyl auth status` with the key in its environment and a home of its own, never on its command line.
  expect(s.lines()).toEqual([expect.stringMatching(/^auth status key=set home=.*\/revyl\/home$/)]);
  const stored = t.hub.db.conn.query<{ sealed: Uint8Array }, []>("SELECT sealed FROM revyl_account").get()!;
  expect(Buffer.from(stored.sealed).includes(Buffer.from(GOOD))).toBe(false);
  expect(JSON.stringify(on)).not.toContain(GOOD);
  expect(JSON.stringify(await call(member, "revyl_get"))).not.toContain(GOOD);
});

test("test: a refused key reads invalid_key, masked; no revyl command reads no_cli with Revyl's install line", async () => {
  const bad = await call(admin, "revyl_connect", { sealed: sealed(BAD) });
  expect(bad.check).toMatchObject({ ok: false, reason: "invalid_key" });
  expect(bad.check.message).toContain("Invalid API key");
  expect(JSON.stringify(bad)).not.toContain(BAD);
  process.env.FLEETD_REVYL_BIN = `${s.bin}-missing`;
  const missing = await call(admin, "revyl_test");
  expect(missing.check).toMatchObject({ ok: false, reason: "no_cli" });
  expect(missing.check.fix).toContain("https://revyl.com/install.sh");
});

test("disconnect: the key and routes go, and every live Revyl screen ends at its node", async () => {
  addMachine(t.hub, "devbox", { boxPubKey: KEY });
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["revyl"]);
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  await call(admin, "revyl_route_set", { kind: "android", route: "revyl_only" });
  t.hub.db.conn
    .query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, 'devbox', 'p1', 0, 'live', 0, ?)")
    .run("B11111111111111111111111111111111", JSON.stringify({ threadId: "t1", source: "revyl" }));
  const off = await call(admin, "revyl_disconnect");
  expect(off).toMatchObject({ connected: false, routes: { ios: "ours_only", android: "ours_only" } });
  expect(off.check).toBeUndefined();
  expect(t.link.sent("devbox")).toEqual([{ t: "session_end", threadId: "t1", sessionId: "B11111111111111111111111111111111" }]);
  await expect(call(admin, "revyl_route_set", { kind: "ios", route: "ours_first" })).rejects.toThrow("Revyl screens need a connected Revyl key.");
  // Connected again: the routes start from the default.
  expect((await call(admin, "revyl_connect", { sealed: sealed(GOOD) })).routes.android).toBe("ours_first");
});

test("the route rule: deterministic over how the team's machines stand", () => {
  expect(routeOf("revyl_only", false)).toBe("ours_only");
  expect(routeOf(undefined, true)).toBe("ours_first");
  expect(choose("ours_first", "free")).toBe("ours");
  expect(choose("ours_first", "full")).toBe("revyl");
  expect(choose("ours_first", "none")).toBe("revyl");
  expect(choose("ours_only", "free")).toBe("ours");
  expect(choose("ours_only", "full")).toBe("line");
  expect(choose("ours_only", "none")).toBe("ours");
  expect(choose("revyl_only", "free")).toBe("revyl");
});

test("an agent's revyl commands: coordinates and reads only; no AI targets, remote builds, feedback or billing", () => {
  expect(refusal(["device", "tap", "--x", "1", "--y", "2"])).toBeUndefined();
  expect(refusal(["device", "screenshot", "--out", "a.png"])).toBeUndefined();
  expect(refusal(["build", "upload", "--file", "app.apk"])).toBeUndefined();
  expect(refusal(["device", "tap", "--target", "Login"])).toContain("AI-driven actions are off");
  expect(refusal(["device", "start"])).toContain("fleetd starts and stops");
  expect(refusal(["device", "tap", "-s", "other", "--x", "1"])).toContain("fleetd sets -s itself");
  expect(refusal(["build"])).toContain("remote builds are off");
  expect(refusal(["build", "upload", "--url", "https://x"])).toContain("remote builds are off");
  expect(refusal(["feedback", "--type", "bug", "x"])).toContain("never send feedback");
  expect(refusal(["auth", "login"])).toContain("billing is the team's own");
  expect(refusal(["test", "run"])).toContain("isn't one fleetd runs");
  expect(refusal(["device", "tap", "--", "--x", "1"])).toContain("takes no `--`");
  expect(mask(`key ${GOOD} and rvl_other_123456`, GOOD)).toBe("key rvl_… and rvl_…");
});

test("a person's takeover: a click taps, a drag swipes, text types where they tapped, in the device's units", () => {
  const screen = { scale: 3, down: undefined as [number, number] | undefined, lastTap: undefined as [number, number] | undefined };
  expect(inputArgv({ kind: "mouse", action: "pressed", button: "left", x: 300, y: 600 }, screen)).toBeUndefined();
  expect(inputArgv({ kind: "mouse", action: "released", button: "left", x: 303, y: 601 }, screen)).toEqual(["device", "tap", "--x", "101", "--y", "200"]);
  expect(inputArgv({ kind: "text", text: "hi" }, screen)).toEqual(["device", "type", "--x", "101", "--y", "200", "--text", "hi"]);
  inputArgv({ kind: "mouse", action: "pressed", button: "left", x: 300, y: 900 }, screen);
  expect(inputArgv({ kind: "mouse", action: "released", button: "left", x: 310, y: 300 }, screen)).toEqual(["device", "swipe", "--x", "100", "--y", "300", "--direction", "up"]);
  expect(inputArgv({ kind: "key", action: "down", key: "Enter" }, screen)).toEqual(["device", "key", "--key", "ENTER"]);
  expect(pngSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3]))).toEqual([2, 3]);
});

// ---- routing through session_route ----

const androidReady = { host: "android", ready: true, detail: "ok" };
const hb = (hosts: unknown[], extra: Record<string, unknown> = {}) => ({ t: "hb", at: "2026-11-08T12:00:00.000Z", load: { cpus: 8, load1: 0, memTotalBytes: 16 * 2 ** 30, hosts, ...extra } });
const start = (kind: string, thread = "t1") => ({
  op: "session_route",
  host: kind,
  frame: { id: "c1", cwd: "/w", threadId: thread, call: { op: "session_start", kind, purpose: "check the app" } },
});

/** devbox runs agents and one Android emulator at a time; mac1 is the agents' Mac with 2 simulators. */
function fleet(opts: { androidLive?: number; sims?: { inUse: number; budget: number; waiting: number } } = {}) {
  addMachine(t.hub, "devbox", { boxPubKey: KEY });
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["browser", "session_seal", "session_host", "revyl"]);
  t.link.deliver("devbox", hb([androidReady]) as never);
  t.hub.db.conn.query("INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES ('devbox', 1, 1, 1)").run();
  for (let i = 0; i < (opts.androidLive ?? 0); i++) {
    t.hub.db.conn
      .query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, 'devbox', 'p1', 0, 'live', 0, ?)")
      .run(`B${String(i).repeat(32).slice(0, 32)}`, JSON.stringify({ threadId: `other${i}`, kind: "android" }));
  }
  addMachine(t.hub, "mac1", { boxPubKey: KEY, agentsMac: true });
  t.link.link("mac1", ["mac_tool", "agents_mac"]);
  t.link.deliver("mac1", hb([], opts.sims ? { sims: opts.sims } : {}) as never);
}

const route = (kind: string, thread?: string) => t.calls.call(agent("devbox", "p1", "T3"), start(kind, thread)) as Promise<{ result?: any; error?: any }>;

/** box2 hosts Android for other machines' agents, with `free` slots open. */
function box2(free: number) {
  addMachine(t.hub, "box2", { boxPubKey: KEY });
  addProject(t.hub, "box2", "p2");
  t.link.link("box2", ["browser", "session_seal", "session_host", "revyl"]);
  t.link.deliver("box2", hb([androidReady]) as never);
  t.hub.db.conn.query("INSERT INTO machine_roles (machine_id, agents, sessions, max_sessions) VALUES ('box2', 1, 1, ?)").run(free);
}

test("Android: ours_first counts only the agent's own machine (its node refuses one elsewhere); ours_only places as today", async () => {
  fleet({ androidLive: 1 });
  box2(4);
  const elsewhere = { runner: "box2", here: false, sealTo: KEY };
  expect((await route("android")).result).toEqual(elsewhere);
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  expect((await route("android", "t2")).result).toMatchObject({ runner: "devbox", here: true, revyl: { platform: "android", why: "devbox's screen slots are full (1 of 1), so this one is Revyl's" } });
  await call(admin, "revyl_route_set", { kind: "android", route: "ours_only" });
  expect((await route("android", "t3")).result).toEqual(elsewhere);
});

test("the line is per pool of slots: an agent whose own machine has room never waits behind one waiting elsewhere", async () => {
  fleet({ androidLive: 1 });
  box2(4);
  // Starts stay on their agent's machine: each agent's pool is its own machine.
  t.hub.db.conn.query("INSERT INTO machine_roles_settings (key, value) VALUES ('remote', 0)").run();
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  await call(admin, "revyl_route_set", { kind: "android", route: "ours_only" });
  expect((await route("android", "a")).error?.reason).toBe("queued");
  const theirs = (await t.calls.call(agent("box2", "p2", "T4"), start("android", "b"))) as { result?: unknown };
  expect(theirs.result).toEqual({ runner: "box2", here: true });
});

test("no key: phone starts go exactly as today", async () => {
  fleet({ androidLive: 1 });
  expect((await route("ios")).error).toMatchObject({ code: "invalid", message: expect.stringContaining("mac sim start") });
  expect((await route("android")).error?.message).toContain("Every machine that can host an Android emulator session is full");
  expect(s.lines()).toEqual([]);
});

test("ours_first: the team's machine while it has room, then Revyl; the key goes sealed to the agent's node", async () => {
  fleet({ sims: { inUse: 1, budget: 2, waiting: 0 } });
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  expect((await route("android")).result).toEqual({ runner: "devbox", here: true });
  expect((await route("ios")).error?.message).toContain("mac sim start");
  t.hub.db.conn.query("DELETE FROM session_places").run();
  t.link.deliver("mac1", hb([], { sims: { inUse: 2, budget: 2, waiting: 0 } }) as never);
  const ios = (await route("ios")).result;
  expect(ios).toMatchObject({ runner: "devbox", here: true, revyl: { platform: "ios", why: "all 2 of the agents' Mac's iOS simulators are in use, so this one is Revyl's" } });
  expect(JSON.stringify(ios)).not.toContain(GOOD);
  t.hub.db.conn
    .query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, 'devbox', 'p1', 0, 'live', 0, ?)")
    .run("B22222222222222222222222222222222", JSON.stringify({ threadId: "other", kind: "android" }));
  expect((await route("android", "t2")).result).toMatchObject({ revyl: { platform: "android", why: "devbox's screen slots are full (1 of 1), so this one is Revyl's" } });
});

test("a Revyl screen takes none of the agent's machine's slots", async () => {
  fleet();
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  t.hub.db.conn
    .query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data) VALUES (?, 'devbox', 'p1', 0, 'live', 0, ?)")
    .run("B33333333333333333333333333333333", JSON.stringify({ threadId: "t9", kind: "ios", source: "revyl" }));
  expect((await route("android")).result).toEqual({ runner: "devbox", here: true });
});

test("revyl_only: always Revyl, and refused on a node too old to drive it", async () => {
  fleet();
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  await call(admin, "revyl_route_set", { kind: "android", route: "revyl_only" });
  await call(admin, "revyl_route_set", { kind: "ios", route: "revyl_only" });
  expect((await route("android")).result).toMatchObject({ revyl: { platform: "android", why: "the team routes Android phone screens to Revyl" } });
  expect((await route("ios")).result).toMatchObject({ revyl: { platform: "ios" } });
  t.link.link("devbox", ["browser"]);
  expect((await route("android")).error?.message).toContain("fleetd is too old to drive one");
});

test("ours_only: the team's machines alone, and a full one puts agents in line, first come first served", async () => {
  fleet({ androidLive: 1, sims: { inUse: 2, budget: 2, waiting: 0 } });
  await call(admin, "revyl_connect", { sealed: sealed(GOOD) });
  await call(admin, "revyl_route_set", { kind: "android", route: "ours_only" });
  await call(admin, "revyl_route_set", { kind: "ios", route: "ours_only" });
  expect((await route("ios")).error).toMatchObject({ message: expect.stringContaining("mac sim start"), fix: expect.stringContaining("--wait") });
  const first = (await route("android", "a")).error;
  expect(first).toMatchObject({ reason: "queued", message: "You're waiting for an Android screen: devbox's screen slots are full (1 of 1)." });
  const second = (await route("android", "b")).error;
  expect(second?.message).toContain("1 agent is ahead of you");
  // A slot frees: the first in line gets it, and the second still waits even though asking first now.
  t.hub.db.conn.query("DELETE FROM browser_sessions").run();
  expect((await route("android", "b")).error?.reason).toBe("queued");
  expect((await route("android", "a")).result).toEqual({ runner: "devbox", here: true });
  expect(s.lines()).toEqual(["auth status key=set home=" + s.lines()[0]!.split("home=")[1]]);
});
