// The heartbeat's `load.hosts` (src/node/hosts, Rust's node/hosts.rs): each kind of screen's line, in plain words, and
// its idle timeout. No switch turns a kind on or off: a machine hosts every kind it can run.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostCheck } from "../src/shared/contracts.ts";
import { deviceDir, type KvmCheck } from "../src/node/device/sdk.ts";
import { android, browser, forget, lines, listed, macScreen, start } from "../src/node/hosts/index.ts";
import { noSharedPlaywright, tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

noSharedPlaywright();

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

test("a browser named where no Chrome is isn't ready; one not installed yet is, whatever an older node.json's switch says", () => {
  const h = home();
  const named = browser(h, { chrome: "/nowhere/chrome" });
  expect(named).toMatchObject({ host: "browser", ready: false, off: "missing", idleMinutes: 30 });
  expect(named).not.toHaveProperty("on");
  expect(named.detail).toContain("not there");
  expect(browser(h, {})).toMatchObject({ ready: true, detail: "Chrome not installed yet: the node installs it with the first screen" });
  expect(browser(h, {})).not.toHaveProperty("off");
  // No switch: an older node.json's `enabled: false` changes nothing.
  expect(browser(h, { enabled: false })).toEqual(browser(h, {}));
});

test.skipIf(!linuxX64)("android is fleetd's own emulator, placeable wherever KVM opens with no opt-in", () => {
  const h = home();
  // Not installed yet: the first session installs it where KVM opens.
  expect(android(h, kvmOk)).toMatchObject({ ready: true, idleMinutes: 30 });
  expect(android(h, kvmOk)).not.toHaveProperty("on");
  const noKvm = android(h, kvmNo);
  expect(noKvm).toMatchObject({ ready: false, off: "missing" });
  expect(noKvm.detail).toContain("no /dev/kvm");
  // An install that failed is tried again by the next session, so it stays placeable where KVM opens.
  mkdirSync(deviceDir(h), { recursive: true });
  writeFileSync(join(deviceDir(h), "state.json"), JSON.stringify({ installing: false, failed: "the download broke" }));
  const failed = android(h, kvmOk);
  expect(failed.ready).toBe(true);
  expect(failed.detail).toContain("the download broke");
  writeFileSync(join(deviceDir(h), "state.json"), JSON.stringify({ installing: true }));
  expect(android(h, kvmOk)).toMatchObject({ ready: false, off: "installing" });
});

test("the Mac screen is the agents' Mac's own, never ready on another machine", () => {
  if (process.platform !== "darwin") expect(macScreen(true)).toMatchObject({ host: "mac", ready: false, off: "unsupported", idleMinutes: 5 });
  // A Mac that isn't the agents' Mac lends no screen, and the gate isn't asked.
  expect(macScreen(false, () => { throw new Error("asked"); }, true)).toMatchObject({ ready: false, off: "unsupported" });
});

test("on the agents' Mac, the Mac screen is ready while nothing stands in the way, else says what does and how to clear it", () => {
  const clear = macScreen(true, () => undefined, true);
  expect(clear).toMatchObject({ host: "mac", ready: true, idleMinutes: 5 });
  expect(clear).not.toHaveProperty("on");
  expect(clear.detail).toContain("on the Mac's screen, unlocked");
  const locked = macScreen(true, () => ({ message: "the Mac's screen is locked: unlock it at the Mac as agents" }), true);
  expect(locked).toMatchObject({ ready: false, off: "missing", detail: "the Mac's screen is locked: unlock it at the Mac as agents" });
  expect(locked.fix).toBeUndefined();
  const grant = macScreen(true, () => ({ message: "fleetd needs Screen Recording", fix: "open 'x-apple.systempreferences:…'" }), true);
  expect(grant).toMatchObject({ ready: false, off: "missing", fix: "open 'x-apple.systempreferences:…'" });
});

test("the Android line is ready only while the node lists Android sessions, which agents can then drive", () => {
  const lines = [{ host: "browser", ready: true, detail: "ok" }, { host: "android", ready: true, detail: "ready" }];
  const held = listed(lines, ["browser"]);
  expect(held[0]).toEqual(lines[0]!);
  expect(held[1]).toMatchObject({ ready: false, off: "missing" });
  expect(held[1]?.detail).toContain("not offered yet");
  expect(listed(lines, ["browser", "session_android"])).toEqual(lines);
  // One not ready keeps its own reason.
  const off = { host: "android", ready: false, off: "installing", detail: "Installing the Android emulator" };
  expect(listed([off], [])).toEqual([off]);
});

test("lines are read at most every few minutes, and again once forgotten", () => {
  const h = home();
  const first = lines(h, { browser: { chrome: "/nowhere/chrome" } } as never, kvmOk, 1_000);
  expect(lines(h, { browser: {} } as never, kvmOk, 2_000)).toBe(first);
  expect(lines(h, { browser: {} } as never, kvmOk, 1_000 + 300_000).before[0]?.ready).toBe(true);
  forget(h);
  expect(lines(h, { browser: { chrome: "/nowhere/chrome" } } as never, kvmOk, 1_000 + 300_001).before[0]?.ready).toBe(false);
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
  expect(hosts[0]).toMatchObject({ ready: true, idleMinutes: 30 });
  expect(hosts[3]?.ready).toBe(false);
  // Where KVM opens, with no opt-in, Android still waits for node/device to list its sessions.
  if (linuxX64) {
    expect(hosts[1]).toMatchObject({ ready: false, off: "missing" });
    t.node.area("caps").contribute(() => ["session_android"]);
    forget(t.node.home);
    expect((await fill())[1]).toMatchObject({ ready: true });
  }
});

test("the agents' Mac says only its own screen", async () => {
  const t = nodeWith({ agentsMac: true });
  start(t.node, kvmOk);
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  expect(((hb.load as { hosts?: HostCheck[] }).hosts ?? []).map((c) => c.host)).toEqual(["mac"]);
});

test("an older node.json's switches turn nothing off: a Linux machine still lists browser and Android as it can", async () => {
  const t = nodeWith({ browser: { enabled: false }, device: { enabled: false }, desktop: { enabled: false } });
  t.node.area("caps").contribute(() => ["session_android"]);
  start(t.node, kvmOk);
  const hb = { load: { cpus: 4, load1: 0, limits: [] }, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
  await t.node.area("hb").fill(hb as never);
  const hosts = (hb.load as { hosts?: HostCheck[] }).hosts ?? [];
  expect(hosts.find((c) => c.host === "browser")).toMatchObject({ ready: true });
  if (linuxX64) expect(hosts.find((c) => c.host === "android")).toMatchObject({ ready: true });
  else expect(hosts.find((c) => c.host === "android")).toMatchObject({ ready: false, off: "unsupported" });
  expect(hosts.some((c) => c.off === "off")).toBe(false);
});
