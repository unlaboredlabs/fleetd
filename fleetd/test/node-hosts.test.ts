// The heartbeat's `load.hosts` (src/node/hosts, Rust's node/hosts.rs): each kind of screen's line, in plain words, its
// switch and idle timeout, and a kind turned on since the node started waiting for the restart.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCheck } from "../src/shared/contracts.ts";
import { deviceDir, type KvmCheck } from "../src/node/device/sdk.ts";
import { android, browser, forget, gate, lines, listed, macScreen, start } from "../src/node/hosts/index.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

const kvmOk: KvmCheck = () => ({ ok: {} as never });
const kvmNo: KvmCheck = () => ({ err: { why: "no /dev/kvm" } as never });
const linuxX64 = process.platform === "linux" && process.arch === "x64";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const home = () => {
  const h = tempHome();
  cleanups.push(() => h.done());
  return h.dir;
};

test("a browser turned off, or named where no Chrome is, isn't ready; one not installed yet is", () => {
  const h = home();
  expect(browser(h, { enabled: false })).toMatchObject({ host: "browser", ready: false, off: "off", on: false, idleMinutes: 30 });
  const named = browser(h, { chrome: "/nowhere/chrome" });
  expect(named).toMatchObject({ ready: false, off: "missing", on: true, idleMinutes: 30 });
  expect(named.detail).toContain("not there");
  expect(browser(h, {})).toMatchObject({ ready: true, detail: "Chrome not installed yet: the node installs it with the first screen" });
  expect(browser(h, {})).not.toHaveProperty("off");
});

test.skipIf(!linuxX64)("android is fleetd's own emulator, and only where set up", () => {
  const h = home();
  expect(android(h, { enabled: false }, kvmOk)).toMatchObject({ ready: false, off: "off", on: false });
  const unset = android(h, {}, kvmOk);
  expect(unset).toMatchObject({ ready: false, off: "off", on: false });
  expect(unset.detail).toContain("turn Android on");
  // Opted in: the first session installs it where KVM opens.
  expect(android(h, { enabled: true }, kvmOk)).toMatchObject({ ready: true, on: true });
  const noKvm = android(h, { enabled: true }, kvmNo);
  expect(noKvm).toMatchObject({ ready: false, off: "missing" });
  expect(noKvm.detail).toContain("no /dev/kvm");
  // An install that failed is tried again by the next session, so it stays placeable where KVM opens.
  mkdirSync(deviceDir(h), { recursive: true });
  writeFileSync(join(deviceDir(h), "state.json"), JSON.stringify({ installing: false, failed: "the download broke" }));
  const failed = android(h, { enabled: true }, kvmOk);
  expect(failed.ready).toBe(true);
  expect(failed.detail).toContain("the download broke");
  writeFileSync(join(deviceDir(h), "state.json"), JSON.stringify({ installing: true }));
  expect(android(h, { enabled: true }, kvmOk)).toMatchObject({ ready: false, off: "installing" });
});

test("the Mac screen is a Mac's own, never ready elsewhere, and off unless turned on", () => {
  const on = macScreen({ enabled: true });
  if (process.platform !== "darwin") {
    expect(on).toMatchObject({ host: "mac", ready: false, off: "unsupported", on: false, idleMinutes: 5 });
  } else {
    expect(on).toMatchObject({ host: "mac", on: true });
    expect(macScreen({})).toMatchObject({ ready: false, off: "off", on: false });
  }
});

test("on a Mac, the Mac screen is ready while nothing stands in the way, else says what does and how to clear it", () => {
  const clear = macScreen({ enabled: true }, () => undefined, true);
  expect(clear).toMatchObject({ host: "mac", ready: true, on: true, idleMinutes: 5 });
  expect(clear.detail).toContain("on the Mac's screen, unlocked");
  const locked = macScreen({ enabled: true }, () => ({ message: "the Mac's screen is locked: unlock it at the Mac as agents" }), true);
  expect(locked).toMatchObject({ ready: false, off: "missing", detail: "the Mac's screen is locked: unlock it at the Mac as agents" });
  expect(locked.fix).toBeUndefined();
  const grant = macScreen({ enabled: true }, () => ({ message: "fleetd needs Screen Recording", fix: "open 'x-apple.systempreferences:…'" }), true);
  expect(grant).toMatchObject({ ready: false, off: "missing", fix: "open 'x-apple.systempreferences:…'" });
  // Off in node.json: the gate isn't asked.
  expect(macScreen({}, () => { throw new Error("asked"); }, true)).toMatchObject({ ready: false, off: "off", on: false });
});

test("a kind turned on since the node started waits for its restart; a browser or desktop already runs", () => {
  const ready = (host: string): HostCheck => ({ host, ready: true, detail: "ok" });
  const started = { device: {}, mac: {}, desktop: {} } as never;
  const now = { device: { enabled: true }, browser: { enabled: true }, desktop: { enabled: true } } as never;
  const gated = gate([ready("browser"), ready("android"), ready("desktop"), ready("mac")], started, now);
  expect(gated.map((c) => [c.host, c.ready, c.off])).toEqual([
    ["browser", true, undefined],
    ["android", false, "restarting"],
    ["desktop", true, undefined],
    ["mac", true, undefined],
  ]);
  expect(gated[1]?.detail).toContain("turned on: it starts when this machine's node restarts");
  // A browser that was off waits too.
  expect(gate([ready("browser")], { browser: { enabled: false } } as never, now)[0]).toMatchObject({ off: "restarting" });
  // Nothing turned on: as it was.
  expect(gate([ready("android")], now, now)[0]?.ready).toBe(true);
});

test("the Android line is ready only while the node lists Android sessions, which agents can then drive", () => {
  const lines = [{ host: "browser", ready: true, detail: "ok" }, { host: "android", ready: true, detail: "ready" }];
  const held = listed(lines, ["browser"]);
  expect(held[0]).toEqual(lines[0]!);
  expect(held[1]).toMatchObject({ ready: false, off: "missing" });
  expect(held[1]?.detail).toContain("not offered yet");
  expect(listed(lines, ["browser", "session_android"])).toEqual(lines);
  // One not ready keeps its own reason.
  const off = { host: "android", ready: false, off: "off", detail: "Android screens are off in node.json" };
  expect(listed([off], [])).toEqual([off]);
});

test("lines are read at most every few minutes, and again once node.json changes", () => {
  const h = home();
  const first = lines(h, { browser: { enabled: false } } as never, kvmOk, 1_000);
  expect(lines(h, { browser: {} } as never, kvmOk, 2_000)).toBe(first);
  expect(lines(h, { browser: {} } as never, kvmOk, 1_000 + 300_000).before[0]?.ready).toBe(true);
  forget(h);
  expect(lines(h, { browser: { enabled: false } } as never, kvmOk, 1_000 + 300_001).before[0]?.ready).toBe(false);
});

function nodeWith(config: Record<string, unknown>) {
  const t = testNode("devbox", config);
  cleanups.push(() => t.done());
  writeFileSync(join(t.node.home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, ...config }));
  return t;
}

test("each heartbeat carries every kind's line, around the desktop's, in Rust's order", async () => {
  // An older node.json's idle timeout is ignored: every screen ends after 30 idle minutes.
  const t = nodeWith({ screenIdleMinutes: 20 });
  // node/desktop's line, as its own heartbeat part adds it.
  t.node.area("hb").contribute((hb) => {
    if (hb.load) hb.load.hosts = [...(hb.load.hosts ?? []), { host: "desktop", ready: true, detail: "Xvfb" }];
  });
  start(t.node, kvmOk);
  const fill = async () => {
    const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
    await t.node.area("hb").fill(hb as never);
    return (hb.load as { hosts?: HostCheck[] }).hosts ?? [];
  };
  const hosts = await fill();
  expect(hosts.map((c) => c.host)).toEqual(["browser", "android", "desktop", "mac"]);
  expect(hosts[0]).toMatchObject({ ready: true, on: true, idleMinutes: 30 });
  expect(hosts[3]?.ready).toBe(false);
  // Opted in where KVM opens, Android still waits for node/device to list its sessions.
  writeFileSync(join(t.node.home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, screenIdleMinutes: 20, device: { enabled: true } }));
  forget(t.node.home);
  Object.assign(t.node.config, { device: { enabled: true } });
  if (linuxX64) {
    expect((await fill())[1]).toMatchObject({ ready: false, off: "missing" });
    t.node.area("caps").contribute(() => ["session_android"]);
    expect((await fill())[1]).toMatchObject({ ready: true, on: true });
  }
});

test("the agents' Mac says only its own screen", async () => {
  const t = nodeWith({ agentsMac: true });
  start(t.node, kvmOk);
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect(((hb.load as { hosts?: HostCheck[] }).hosts ?? []).map((c) => c.host)).toEqual(["mac"]);
});

test("Android turned on in node.json since the node started reads as restarting", async () => {
  const t = nodeWith({});
  writeFileSync(join(t.node.home, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, device: { enabled: true } }));
  start(t.node, kvmOk);
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  const line = ((hb.load as { hosts?: HostCheck[] }).hosts ?? []).find((c) => c.host === "android");
  if (linuxX64) expect(line).toMatchObject({ ready: false, off: "restarting", on: true });
  else expect(line).toMatchObject({ ready: false, off: "unsupported" });
});
