// A Revyl screen on the agent's node (node/revyl): started where the hub routes a phone start, driven by the agent's
// `revyl` commands with the team's key held back, watched and taken over by a person, and stopped at Revyl however it
// ends: session_end, the agent's session ending, idling out, or the node restarting. A stand-in `revyl` answers
// (revyl_standin.ts): nothing reaches Revyl or spends anything.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NodeBoxKey } from "../src/node/identity.ts";
import { IDLE_MS, inCwd, RevylScreens, start as startRevyl } from "../src/node/revyl/index.ts";
import { router } from "../src/node/device/router.ts";
import { start as startRoute } from "../src/node/session_route/index.ts";
import { seal } from "../src/shared/sealed_box.ts";
import { GOOD, standIn } from "./revyl_standin.ts";
import { testNode } from "./node_helpers.ts";

const box = new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)));
const sealedKey = () => Buffer.from(seal(Buffer.from(box.publicKey(), "base64"), new TextEncoder().encode(GOOD))).toString("base64");

let done: (() => void)[] = [];
afterEach(() => {
  for (const d of done) d();
  done = [];
});

function rig(opts: { startOut?: string } = {}) {
  const s = standIn(opts);
  const t = testNode("devbox");
  done.push(s.done, t.done);
  let now = Date.parse("2026-11-08T12:00:00.000Z");
  const reports: Record<string, unknown>[] = [];
  t.link.answer = async (op, args) => {
    if (op === "session_route") return { runner: "devbox", here: true, revyl: { platform: "android", sealed: sealedKey(), why: "devbox's screen slots are full (1 of 1), so this one is Revyl's" } };
    if (op === "browser_session") reports.push(args);
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    return {};
  };
  startRoute(t.node);
  const r = startRevyl(t.node, { bin: s.bin, boxKey: box, now: () => now });
  const begin = () => t.local.call("session_start", { kind: "android", purpose: "check the checkout" }, "t1") as Promise<Record<string, unknown>>;
  return { s, t, r, reports, begin, advance: (ms: number) => (now += ms) };
}

const states = (reports: Record<string, unknown>[]) => reports.map((r) => r.state);

test("a routed start: Revyl's device, reported as the agent's screen with source revyl", async () => {
  const { s, t, reports, begin } = rig();
  const started = await begin();
  expect(started).toMatchObject({ op: "session_start", kind: "android", source: "revyl", sessionId: expect.stringMatching(/^B[0-9a-f]{32}$/) });
  expect(String(started.note)).toContain("revyl device tap");
  expect(s.lines()[0]).toMatch(/^device start --platform android --timeout 1800 --open=false --json key=set /);
  expect(reports[0]).toMatchObject({ state: "live", kind: "android", source: "revyl", threadId: "t1" });
  expect(router(t.node).live("t1")).toBe(true);
  expect(readdirSync(join(t.node.home, "revyl", "live"))).toHaveLength(1);
  await expect(begin()).rejects.toThrow("is open");
});

test("the agent's revyl: its own screen by coordinates, the key never in what comes back", async () => {
  const { s, t, begin } = rig();
  await begin();
  const tap = (await t.local.call("revyl", { argv: ["device", "tap", "--x", "120", "--y", "300"] }, "t1")) as Record<string, unknown>;
  expect(tap).toMatchObject({ op: "revyl", exitCode: 0 });
  expect(s.lines().at(-1)).toMatch(/^device tap --x 120 --y 300 --session-id rs-0001 key=set /);
  const info = (await t.local.call("revyl", { argv: ["device", "info"] }, "t1")) as Record<string, unknown>;
  expect(JSON.stringify(info)).not.toContain(GOOD);
  await expect(t.local.call("revyl", { argv: ["device", "tap", "--target", "Login"] }, "t1")).rejects.toThrow("AI-driven actions are off");
  await expect(t.local.call("revyl", { argv: ["feedback", "--type", "bug", "x"] }, "t1")).rejects.toThrow("never send feedback");
  await expect(t.local.call("revyl", { argv: ["device", "info"] }, "t2")).rejects.toThrow("No Revyl screen is open");
  await expect(t.local.call("session_start", { kind: "android", purpose: "again" }, "t1")).rejects.toThrow("is open");
});

test("the agent's revyl runs outside its folder, so Revyl's .revyl/ stays out of its repo; its files land in its folder", async () => {
  const { t, begin } = rig();
  await begin();
  const cwd = mkdtempSync(join(t.node.home, "agent-"));
  const shot = (await router(t.node).handle("t1", { id: "x", cwd, call: { op: "revyl", argv: ["device", "screenshot", "--out", "a.png"] } })) as Record<string, unknown>;
  expect(shot).toMatchObject({ exitCode: 0 });
  expect(readdirSync(cwd)).toEqual(["a.png"]);
  expect(existsSync(join(t.node.home, "revyl", "home", ".revyl"))).toBe(true);
  expect(inCwd(["build", "upload", "-f", "app.apk"], "/w")).toEqual(["build", "upload", "-f", "/w/app.apk"]);
  expect(inCwd(["build", "upload", "--file=/b/app.apk"], "/w")).toEqual(["build", "upload", "--file=/b/app.apk"]);
  expect(inCwd(["device", "hierarchy", "--out=h.json"], "/w")).toEqual(["device", "hierarchy", "--out=/w/h.json"]);
});

test("a person watches and takes over: frames from screenshots, a click taps; the agent waits meanwhile", async () => {
  const { s, t, r, reports, begin } = rig();
  const { sessionId } = (await begin()) as { sessionId: string };
  const screen = r.byId(sessionId)!;
  const frame = await r.shot(screen);
  expect(frame).toMatchObject({ seq: 1, width: 2, height: 3 });
  // The 2-pixel frame of a screen `device start` said is 1 unit wide: two pixels to a unit.
  expect(screen.scale).toBe(2);
  // Revyl's PNG goes out as the JPEG a frame is.
  expect([...frame!.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  t.link.deliver({ t: "browser_control", sessionId, control: "human", by: "ana" });
  expect(reports.at(-1)).toMatchObject({ state: "live", control: "human" });
  await expect(t.local.call("revyl", { argv: ["device", "screenshot", "--out", "a.png"] }, "t1")).rejects.toThrow("A person has control");
  t.link.deliver({ t: "browser_input", sessionId, input: { kind: "mouse", action: "pressed", button: "left", x: 50, y: 70 } });
  await r.input({ sessionId, input: { kind: "mouse", action: "released", button: "left", x: 50, y: 70 } });
  expect(s.lines().at(-1)).toMatch(/^device tap --x 25 --y 35 --session-id rs-0001 key=set/);
  t.link.deliver({ t: "browser_control", sessionId, control: "agent", by: "ana" });
  await t.local.call("revyl", { argv: ["device", "info"] }, "t1");
  expect(reports.at(-1)).toMatchObject({ control: "agent" });
});

test("session_end stops Revyl's minutes, then Revyl's video is the recording", async () => {
  const { s, t, r, reports, begin } = rig();
  await begin();
  const ended = (await t.local.call("session_end", {}, "t1")) as Record<string, unknown>;
  expect(ended).toMatchObject({ op: "session_end", kind: "android", source: "revyl" });
  expect(ended.note).toBeUndefined();
  expect(s.lines().some((l) => l.startsWith("device stop --session-id rs-0001 key=set"))).toBe(true);
  expect(readdirSync(join(t.node.home, "revyl", "live"))).toEqual([]);
  await r.settled();
  expect(s.lines().some((l) => l.startsWith("session download rs-0001 --include-full-video --no-clips"))).toBe(true);
  expect(states(reports)).toEqual(["live", "uploading", "uploading", "recorded"]);
  expect(reports.at(-1)).toMatchObject({ files: [{ file: "video_mp4", bytes: 6 }], source: "revyl" });
  expect(router(t.node).live("t1")).toBe(false);
});

test("the agent's session ends, or the screen idles out: stopped at Revyl", async () => {
  const one = rig();
  await one.begin();
  router(one.t.node).ended("t1");
  await one.r.settled();
  expect(one.s.lines().some((l) => l.startsWith("device stop --session-id rs-0001"))).toBe(true);

  const two = rig();
  await two.begin();
  two.advance(IDLE_MS - 1);
  await two.r.housekeep();
  expect(two.s.lines().some((l) => l.startsWith("device stop"))).toBe(false);
  two.advance(1);
  await two.r.housekeep();
  await two.r.settled();
  expect(two.s.lines().some((l) => l.startsWith("device stop --session-id rs-0001"))).toBe(true);
  expect(two.reports.find((x) => x.state === "uploading")?.note).toBe("ended after 30 minutes without a command");
});

test("the node restarts: shutdown stops its screens; a crash's leftovers stop at the next start", async () => {
  const one = rig();
  await one.begin();
  await one.r.shutdown();
  expect(one.s.lines().some((l) => l.startsWith("device stop --session-id rs-0001"))).toBe(true);
  expect(one.reports.at(-1)).toMatchObject({ state: "lost", note: "the node restarted, so its Revyl screen was stopped" });

  const two = rig();
  await two.begin();
  // The node went down without ending it: a new one on the same home stops it from its record.
  const again = new RevylScreens(two.t.node, { bin: two.s.bin, boxKey: box });
  expect(await again.sweep()).toBe(1);
  await again.shutdown();
  expect(two.s.lines().filter((l) => l.startsWith("device stop --session-id rs-0001"))).toHaveLength(1);
  expect(existsSync(join(two.t.node.home, "revyl", "live")) && readdirSync(join(two.t.node.home, "revyl", "live")).length).toBe(0);
  expect(two.reports.at(-1)).toMatchObject({ state: "lost" });
});

test("an iOS start is the hub's to route: its refusal (the way to mac sim start) comes back as it is", async () => {
  const { t } = rig();
  t.link.answer = async (op) => {
    if (op === "session_route") throw Object.assign(new Error("iOS screens are gone: start one with mac sim start"), { toJSON: () => ({ code: "invalid", message: "iOS screens are gone: start one with mac sim start" }) });
    return {};
  };
  await expect(t.local.call("session_start", { kind: "ios", purpose: "p" }, "t1")).rejects.toThrow("mac sim start");
  expect(t.link.calls.filter((c) => c.op === "session_route")).toHaveLength(1);
});

test("Revyl refuses over billing: the agent hears not to retry or work around it", async () => {
  const { begin, reports } = rig({ startOut: '{"billing_notice":"Your free minutes are used up","billing_url":"https://example.invalid"}' });
  await expect(begin()).rejects.toThrow("over the team's plan or billing");
  expect(reports).toEqual([]);
});
