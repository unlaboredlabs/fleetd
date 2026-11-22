// Phone screens' device controls (W804): each control's commands on an iOS simulator and an Android emulator, the
// device state the screen reports, the models a person may start on the agents' Mac, a person ahead in the Mac's
// line, and `mac sim <control>`'s arguments.
import { expect, test } from "bun:test";
import { simControlArgs } from "../src/cli/mac_tool.ts";
import { AndroidDevice, androidPlan } from "../src/node/device/controls.ts";
import { type ControlTools, controlsOf, foldable, latLon, panelOf, plan, pngSize, SimDevice, turned } from "../src/node/device/ios/controls.ts";
import { modelsOf } from "../src/node/device/ios/sims.ts";
import type { Runtime } from "../src/node/device/ios/simctl.ts";
import { Queue } from "../src/node/mac_tool/queue.ts";
import { iosHost } from "../src/node/mac_tool/index.ts";
import { tempHome } from "./helpers.ts";

const UDID = "A5D9CF4B-BAAB-4D2E-A626-3BDB344076C1";
const IPHONE = "iPhone 17 on iOS 27.2";
const DUO = "iPhone Duo on iOS 27.2";
const upright = { orientation: "portrait", appearance: "light" } as const;

/** A PNG's first 24 bytes: its signature and IHDR's width and height. */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(32);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}

test("a Duo folds and an iPhone doesn't: its controls, and the panel each pose lights", () => {
  expect(foldable(DUO)).toBe(true);
  expect(foldable(IPHONE)).toBe(false);
  expect(controlsOf(IPHONE)).toEqual(["rotate_left", "rotate_right", "shake", "home", "lock", "appearance", "screenshot", "location"]);
  expect(controlsOf(DUO).at(-1)).toBe("fold");
  expect(panelOf(DUO, "closed")).toBe("primary");
  expect(panelOf(DUO, "half-open")).toBe("primary-1");
  expect(panelOf(DUO, "open")).toBe("primary-1");
  expect(panelOf(IPHONE, "open")).toBeUndefined();
});

test("four left turns come back upright, through each landscape and upside down; a right turn undoes a left", () => {
  const seen = [];
  let o: string = "portrait";
  for (let i = 0; i < 4; i++) seen.push((o = turned(o, "left")));
  expect(seen).toEqual(["landscape_left", "portrait_upside_down", "landscape_right", "portrait"]);
  expect(turned(turned("portrait", "left"), "right")).toBe("portrait");
  expect(turned("portrait", "right")).toBe("landscape_right");
});

test("each iOS control's commands, as tried on the real Mac", () => {
  expect(plan(IPHONE, UDID, upright, "rotate_left")).toEqual({
    steps: [{ agentDevice: ["orientation", "landscape-left"] }],
    next: { ...upright, orientation: "landscape_left" },
  });
  expect(plan(IPHONE, UDID, upright, "rotate_right").steps).toEqual([{ agentDevice: ["orientation", "landscape-right"] }]);
  expect(plan(IPHONE, UDID, upright, "shake").steps).toEqual([{ simctl: ["spawn", UDID, "notifyutil", "-p", "com.apple.UIKit.SimulatorShake"] }]);
  expect(plan(IPHONE, UDID, upright, "home").steps).toEqual([{ helper: "button", arg: "home" }]);
  expect(plan(IPHONE, UDID, upright, "lock").steps).toEqual([{ helper: "button", arg: "lock" }]);
  expect(plan(IPHONE, UDID, upright, "appearance", "dark")).toEqual({ steps: [{ simctl: ["ui", UDID, "appearance", "dark"] }], next: { ...upright, appearance: "dark" } });
  // No value: the other one.
  expect(plan(IPHONE, UDID, { ...upright, appearance: "dark" }, "appearance").next.appearance).toBe("light");
  expect(plan(IPHONE, UDID, upright, "location", "48.8584, 2.2945").steps).toEqual([{ simctl: ["location", UDID, "set", "48.8584,2.2945"] }]);
  expect(plan(DUO, UDID, { ...upright, fold: "closed" }, "fold", "half-open")).toEqual({
    steps: [{ helper: "fold", arg: "half-open" }],
    next: { ...upright, fold: "half-open" },
  });
  expect(plan(IPHONE, UDID, upright, "screenshot").steps).toEqual([]);
});

test("a control a device doesn't take, or a value it can't use, is refused before anything runs", () => {
  expect(() => plan(IPHONE, UDID, upright, "fold", "open")).toThrow("no fold control");
  expect(() => plan(IPHONE, UDID, upright, "back")).toThrow("no back control");
  expect(() => plan(DUO, UDID, { ...upright, fold: "closed" }, "fold", "flat")).toThrow("closed, half-open, open");
  expect(() => plan(IPHONE, UDID, upright, "appearance", "sepia")).toThrow("light or dark");
  expect(() => latLon("91,0")).toThrow();
  expect(() => latLon("48.8")).toThrow();
  expect(() => latLon(",2")).toThrow();
  expect(latLon("-33.86,151.21")).toEqual([-33.86, 151.21]);
});

/** A simulator's tools that record what ran. */
function tools(opts: { noSession?: boolean } = {}) {
  const home = tempHome();
  const ran: string[][] = [];
  let opened = !opts.noSession;
  const t: ControlTools = {
    async simctl(args) {
      ran.push(["simctl", ...args]);
      if (args[0] === "ui" && args.length === 3) return "dark\n";
      if (args[1] === UDID && args[2] === "screenshot") await Bun.write(args.at(-1)!, png(1398, 2034));
      return "";
    },
    helpers: async () => ({ fold: "/h/fold-helper", button: "/h/button" }),
    async agentDevice(args) {
      ran.push(["agent-device", ...args]);
      if (args[0] === "open") opened = true;
      return opened ? { ok: true, said: "", ms: 1 } : { ok: false, said: '{"code":"SESSION_NOT_FOUND"}', ms: 1 };
    },
    shots: home.dir,
  };
  return { t, ran, done: home.done };
}

test("a Duo settles closed with its appearance read, folds, turns, and screenshots its lit panel", async () => {
  const { t, ran, done } = tools();
  try {
    const dev = new SimDevice(UDID, DUO, t);
    await dev.settle();
    expect(dev.report()).toEqual({
      controls: controlsOf(DUO),
      orientation: "portrait",
      appearance: "dark",
      fold: "closed",
      folds: ["closed", "half-open", "open"],
    });
    expect(ran).toEqual([
      ["simctl", "ui", UDID, "appearance"],
      ["simctl", "spawn", UDID, "/h/fold-helper", "closed"],
    ]);
    expect(dev.display()).toBe("primary");
    await dev.apply("fold", "open");
    expect(dev.display()).toBe("primary-1");
    await dev.apply("rotate_left");
    const shot = await dev.apply("screenshot");
    expect(shot).toMatchObject({ width: 1398, height: 2034 });
    expect(ran.slice(2).map((r) => r.slice(0, 5))).toEqual([
      ["simctl", "spawn", UDID, "/h/fold-helper", "open"],
      ["agent-device", "orientation", "landscape-left"],
      ["simctl", "io", UDID, "screenshot", "--display=primary-1"],
    ]);
    expect(dev.report()).toMatchObject({ orientation: "landscape_left", fold: "open" });
  } finally {
    done();
  }
});

test("a simulator nobody opened an agent-device session on gets one for its turn, as a person's taps do", async () => {
  const { t, ran, done } = tools({ noSession: true });
  try {
    const dev = new SimDevice(UDID, IPHONE, t);
    await dev.apply("rotate_right");
    expect(ran).toEqual([
      ["agent-device", "orientation", "landscape-right"],
      ["agent-device", "open"],
      ["agent-device", "orientation", "landscape-right"],
      // Closed again at once: the agent's own open is never refused for it.
      ["agent-device", "close"],
    ]);
    expect(dev.state.orientation).toBe("landscape_right");
    // An iPhone's screenshot names no panel.
    await dev.apply("screenshot");
    expect(ran.at(-1)!.slice(0, 5)).toEqual(["simctl", "io", UDID, "screenshot", `${t.shots}/${UDID}-control.png`]);
  } finally {
    done();
  }
});

test("a simulator the agent's agent-device session holds is turned in that session, by name", async () => {
  const { t, done } = tools();
  const ran: string[][] = [];
  try {
    const dev = new SimDevice(UDID, IPHONE, {
      ...t,
      async agentDevice(args) {
        ran.push(args);
        if (args[0] === "open") return { ok: false, said: 'Device is already in use by workspace session "cwd:98c15ef49d81c4f9:ios".', ms: 1 };
        return args.includes("--session") ? { ok: true, said: "", ms: 1 } : { ok: false, said: "SESSION_NOT_FOUND", ms: 1 };
      },
    });
    await dev.apply("rotate_left");
    expect(ran).toEqual([["orientation", "landscape-left"], ["open"], ["orientation", "--session", "cwd:98c15ef49d81c4f9:ios", "landscape-left"]]);
    expect(dev.state.orientation).toBe("landscape_left");
  } finally {
    done();
  }
});

test("a runner still finishing an earlier command is given a moment, then the turn goes", async () => {
  const { t, done } = tools();
  let busy = 2;
  try {
    const dev = new SimDevice(
      UDID,
      IPHONE,
      { ...t, agentDevice: async () => (busy-- > 0 ? { ok: false, said: "The iOS runner is still finishing a previous command", ms: 1 } : { ok: true, said: "", ms: 1 }) },
      1,
    );
    await dev.apply("rotate_left");
    expect(dev.state.orientation).toBe("landscape_left");
  } finally {
    done();
  }
});

test("a control that fails leaves the device as it was, and the next one still runs", async () => {
  const { t, done } = tools();
  try {
    const dev = new SimDevice(UDID, IPHONE, { ...t, agentDevice: async () => ({ ok: false, said: "the runner is gone", ms: 1 }) });
    await expect(dev.apply("rotate_left")).rejects.toThrow("the runner is gone");
    expect(dev.state.orientation).toBe("portrait");
    await dev.apply("appearance", "dark");
    expect(dev.state.appearance).toBe("dark");
  } finally {
    done();
  }
});

test("a PNG's size is read from its header", () => {
  expect(pngSize(png(2853, 2007))).toEqual([2853, 2007]);
  expect(pngSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
});

test("Android: a turn locks the rotation to fleetd's, Home and Back are key events, a screenshot is screencap's PNG", async () => {
  expect(androidPlan("rotate_left", 0)).toEqual({
    adb: [
      ["shell", "settings", "put", "system", "accelerometer_rotation", "0"],
      ["shell", "settings", "put", "system", "user_rotation", "1"],
    ],
    rotation: 1,
  });
  expect(androidPlan("rotate_right", 0).rotation).toBe(3);
  expect(androidPlan("home", 2)).toEqual({ adb: [["shell", "input", "keyevent", "KEYCODE_HOME"]], rotation: 2 });
  expect(androidPlan("back", 0).adb).toEqual([["shell", "input", "keyevent", "KEYCODE_BACK"]]);
  expect(() => androidPlan("shake", 0)).toThrow("no shake control");
  const ran: string[][] = [];
  const dev = new AndroidDevice({
    run: async (args) => (ran.push(args), { code: 0, stdout: "", stderr: "" }),
    bytes: async (args) => (ran.push(args), png(1080, 2400)),
  });
  await dev.apply("rotate_left");
  expect(dev.report()).toEqual({ controls: ["rotate_left", "rotate_right", "home", "back", "screenshot"], orientation: "landscape_left" });
  expect(await dev.apply("screenshot")).toMatchObject({ width: 1080, height: 2400 });
  expect(ran.at(-1)).toEqual(["exec-out", "screencap", "-p"]);
  const failing = new AndroidDevice({ run: async () => ({ code: 1, stdout: "", stderr: "device offline" }), bytes: async () => new Uint8Array() });
  await expect(failing.apply("home")).rejects.toThrow("device offline");
});

const type = (name: string, productFamily: string) => ({ identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/ /g, "-")}`, name, productFamily });
const runtime = (identifier: string, types: ReturnType<typeof type>[]): Runtime => ({
  identifier,
  name: "iOS 27.2",
  version: "27.2",
  isAvailable: true,
  platform: "iOS",
  supportedDeviceTypes: types,
});

test("the models a person may start: plain iPhones newest first, the other iPhones, the Duo, the iPads; each with its runtimes", () => {
  const general = runtime("com.apple.CoreSimulator.SimRuntime.iOS-27-2", [
    type("iPhone 17 Pro", "iPhone"),
    type("iPhone 16", "iPhone"),
    type("iPhone 17", "iPhone"),
    type("iPad Pro 13-inch (M5)", "iPad"),
    type("Apple Watch Ultra 3 (49mm)", "Watch"),
  ]);
  const duo = runtime("com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4", [type("iPhone Duo", "iPhone")]);
  const models = modelsOf([duo, general]);
  expect(models.map((m) => [m.name, m.family])).toEqual([
    ["iPhone 17", "iphone"],
    ["iPhone 16", "iphone"],
    ["iPhone 17 Pro", "iphone"],
    ["iPhone Duo", "foldable"],
    ["iPad Pro 13-inch (M5)", "ipad"],
  ]);
  expect(models.find((m) => m.name === "iPhone Duo")!.runtimes).toEqual([{ id: "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4", name: "iOS 27.2" }]);
});

test("the Mac's ios line is ready once its simulators are and it has read its models", () => {
  const sims = { models: modelsOf([runtime("r", [type("iPhone 17", "iPhone")])]), live: 1, max: 2 };
  expect(iosHost(true, sims)).toEqual({ host: "ios", ready: true, detail: "1 iPhone and iPad models", idleMinutes: 30, sims });
  expect(iosHost(false, sims)).toMatchObject({ host: "ios", ready: false, off: "installing", sims });
  expect(iosHost(true, undefined)).toMatchObject({ ready: false });
});

test("a person goes ahead of every agent in the Mac's line, behind the people already in it (D239)", () => {
  const q = new Queue();
  expect(q.ask("T1", 0)).toBe(1);
  expect(q.ask("T2", 0)).toBe(2);
  expect(q.turn("screen-a", true, 2, 2, 0, true)).toEqual({ now: false, place: 1, full: true });
  expect(q.turn("screen-b", true, 2, 2, 0, true)).toEqual({ now: false, place: 2, full: true });
  expect(q.ask("T3", 0)).toBe(5);
  // A slot frees: the first person takes it, and the line moves up.
  expect(q.turn("screen-a", true, 1, 2, 0, true)).toEqual({ now: true });
  q.leave("screen-a");
  expect(q.turn("T1", true, 1, 2, 0)).toEqual({ now: false, place: 2, full: false });
  // Not waiting, a person is told the place they'd take: behind the people only.
  expect(q.turn("screen-c", false, 2, 2, 0, true)).toEqual({ now: false, place: 2, full: true });
});

test("mac sim <control>'s arguments", () => {
  expect(simControlArgs(["rotate", "left"])).toEqual({ control: "rotate_left" });
  expect(simControlArgs(["rotate"])).toBeInstanceOf(Error);
  expect(simControlArgs(["shake"])).toEqual({ control: "shake" });
  expect(simControlArgs(["lock", "now"])).toBeInstanceOf(Error);
  expect(simControlArgs(["appearance"])).toEqual({ control: "appearance" });
  expect(simControlArgs(["appearance", "dark"])).toEqual({ control: "appearance", value: "dark" });
  expect(simControlArgs(["location", "48.8584,2.2945"])).toEqual({ control: "location", value: "48.8584,2.2945" });
  expect(simControlArgs(["location", "48.8584", "2.2945"])).toEqual({ control: "location", value: "48.8584,2.2945" });
  expect(simControlArgs(["location", "paris"])).toBeInstanceOf(Error);
  expect(simControlArgs(["fold", "half-open"])).toEqual({ control: "fold", value: "half-open" });
  expect(simControlArgs(["fold", "flat"])).toBeInstanceOf(Error);
  expect(simControlArgs(["screenshot", "shots/duo.png"])).toEqual({ control: "screenshot", to: "shots/duo.png" });
});
