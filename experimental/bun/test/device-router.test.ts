import { expect, test } from "bun:test";
import type { Broker } from "../src/node/browser/index.ts";
import { hostOf, Router, type Screens, type SessionKind } from "../src/node/device/router.ts";
import type { BrowserCallFrame } from "../src/shared/screens_wire.ts";

const frame = (op: string, extra: Record<string, unknown> = {}): BrowserCallFrame => ({ id: op, cwd: "/w", call: { op, ...extra } });

/** A browser broker with one session map, as the router uses it. */
function fakeBroker() {
  const live = new Map<string, { id: string }>();
  const broker = {
    live: (thread: string) => live.get(thread),
    count: () => live.size,
    async open(thread: string) {
      live.set(thread, { id: "Bbrowser" });
      return { sessionId: "Bbrowser", cdp: "ws://proxy", startMs: 1 };
    },
    async end(thread: string) {
      live.delete(thread);
      return { sessionId: "Bbrowser", kind: "browser", files: [] };
    },
  };
  return { broker: broker as unknown as Broker, live };
}

/** A kind of screen that keeps what it was asked. */
function fakeScreens(kindOf: (frame: BrowserCallFrame) => SessionKind) {
  const live = new Map<string, { id: string; kind: SessionKind }>();
  const calls: string[] = [];
  const ended: string[] = [];
  const screens: Screens = {
    async handle(thread, f) {
      calls.push(`${thread}:${f.call.op}:${String(f.call.kind ?? "")}`);
      if (f.call.op === "session_start") live.set(thread, { id: `S${thread}`, kind: kindOf(f) });
      if (f.call.op === "session_end") live.delete(thread);
      return { op: f.call.op };
    },
    live: (thread) => live.get(thread),
    count: () => live.size,
    endScreen(thread, id) {
      if (live.get(thread)?.id !== id) return false;
      live.delete(thread);
      return true;
    },
    ended: (thread) => void ended.push(thread),
    shutdown: async () => {},
  };
  return { screens, live, calls, ended };
}

test("each call goes to the screen of its kind, and one agent session holds one screen at a time", async () => {
  const { broker } = fakeBroker();
  const router = new Router(broker);
  const android = fakeScreens(() => "android");
  const desktops = fakeScreens((f) => (f.call.kind === "mac" ? "mac" : "linux_desktop"));

  // A kind nobody filled in refuses, saying why.
  await expect(router.handle("t1", frame("session_start", { kind: "android" }))).rejects.toThrow("hosts no Android sessions");
  await expect(router.handle("t1", frame("session_start", { kind: "linux_desktop" }))).rejects.toThrow("no desktop sessions");
  await expect(router.handle("t1", frame("session_start", { kind: "mac" }))).rejects.toThrow("lends no Mac screen");
  await expect(router.handle("t1", frame("session_start", { kind: "ios" }))).rejects.toThrow("mac sim start");
  await expect(router.handle("t1", frame("device"))).rejects.toThrow("No iOS session is open.");

  router.android = android.screens;
  router.desktops = desktops.screens;
  expect(await router.handle("t1", frame("session_start", { purpose: "p" }))).toMatchObject({ op: "session_start", sessionId: "Bbrowser" });
  expect(router.open("t1")).toEqual({ kind: "browser", id: "Bbrowser" });
  await expect(router.handle("t1", frame("session_start", { kind: "android" }))).rejects.toThrow(
    "Browser session Bbrowser is open.",
  );
  expect(await router.handle("t1", frame("session_end"))).toMatchObject({ op: "session_end" });

  expect(await router.handle("t1", frame("session_start", { kind: "android" }))).toEqual({ op: "session_start" });
  // Its calls follow it there without naming the kind; a browser's own calls are refused.
  expect(await router.handle("t1", frame("device", { args: ["snapshot"] }))).toEqual({ op: "device" });
  await expect(router.handle("t1", frame("fill_credential"))).rejects.toThrow("not available in Android sessions");
  await expect(router.handle("t1", frame("session_start", { kind: "mac" }))).rejects.toThrow("Android session St1 is open.");
  expect(await router.handle("t1", frame("session_end"))).toEqual({ op: "session_end" });
  expect(android.calls).toEqual(["t1:session_start:android", "t1:device:", "t1:session_end:"]);

  // The desktop tool goes to the desktops: as a Linux desktop, or the Mac's screen while that is open.
  await router.handle("t2", frame("session_start", { kind: "mac" }));
  expect(router.kindOf("t2", frame("desktop"))).toBe("mac");
  expect(router.kindOf("t3", frame("desktop"))).toBe("linux_desktop");
  expect(await router.handle("t2", frame("desktop", { action: "screenshot" }))).toEqual({ op: "desktop" });
  await expect(router.handle("t2", frame("purchase_fill"))).rejects.toThrow("is for browser sessions");
  await expect(router.handle("t2", frame("device"))).rejects.toThrow("this is a desktop session");
  await router.handle("t3", frame("session_start", { kind: "linux_desktop" }));
  expect(router.count()).toBe(2);

  // The hub's end of a screen finds it whatever its kind; an agent session that ended takes all of them.
  expect(router.endScreen("t2", "Swrong")).toBe(false);
  expect(router.endScreen("t2", "St2")).toBe(true);
  router.ended("t3");
  expect(desktops.ended).toEqual(["t3"]);
  expect(android.ended).toEqual(["t3"]);
});

test("the hub places a call by what its screen runs on", () => {
  expect(hostOf(frame("session_start"))).toBe("browser");
  expect(hostOf(frame("session_start", { kind: "android" }))).toBe("android");
  expect(hostOf(frame("session_start", { kind: "linux_desktop" }))).toBe("desktop");
  expect(hostOf(frame("session_start", { kind: "mac" }))).toBe("mac");
  expect(hostOf(frame("desktop"))).toBe("desktop");
  expect(hostOf(frame("session_end"))).toBe("browser");
});
