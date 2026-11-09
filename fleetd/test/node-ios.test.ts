// The agents' Mac's iOS simulators on the Bun node, against a stand-in `xcrun` (a shell script that keeps a log and
// prints what simctl would): nothing here starts a real simulator, and none of it needs a Mac.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { binDir as androidBin, entry, LENT, sessionDir, VERSION } from "../src/node/device/agent_device.ts";
import { blocksSimulators } from "../src/node/agents_mac/checks.ts";
import { healthFrom, Simulators, xcodeFrom } from "../src/node/device/ios/index.ts";
import { backoff, BACKOFF_MAX, deviceCpu, findGolden, type Golden, goldenPath, Pool, Refill, type Waiting, waitingWords } from "../src/node/device/ios/pool.ts";
import { devices, iosRuntimes, pick, Simctl, udidOf } from "../src/node/device/ios/simctl.ts";
import { MacSims, simConfig, simKey } from "../src/node/device/ios/sims.ts";
import { builtXctestrun, installWrapper, iosEnv, runnerDir, setDir, writeConfig, wrapperScript } from "../src/node/device/ios/wrapper.ts";
import { Host, jobEnv } from "../src/node/mac_tool/host.ts";
import { simBudget } from "../src/node/mac_tool/protocol.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const until = async (what: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
      name: "iOS 26.2",
      version: "26.2",
      isAvailable: true,
      platform: "iOS",
      supportedDeviceTypes: [{ identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17", productFamily: "iPhone" }],
    },
    {
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      name: "iOS 27.0",
      version: "27.0",
      isAvailable: true,
      platform: "iOS",
      supportedDeviceTypes: [
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17", name: "iPhone 17", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", name: "iPhone 18 Pro", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18", name: "iPhone 18", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-11", name: "iPhone 11", productFamily: "iPhone" },
        { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11", name: "iPad Air 11-inch", productFamily: "iPad" },
      ],
    },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-28-0", name: "iOS 28.0", version: "28.0", isAvailable: false, platform: "iOS", supportedDeviceTypes: [] },
    { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-12-0", name: "watchOS 12.0", version: "12.0", isAvailable: true, platform: "watchOS", supportedDeviceTypes: [] },
  ],
});

test("agents get the newest available iOS and its newest plain iPhone, or the type they name", () => {
  const runtimes = iosRuntimes(RUNTIMES);
  expect(runtimes.length).toBe(2);
  const [runtime, type] = pick(runtimes);
  expect([runtime.name, type.name]).toEqual(["iOS 27.0", "iPhone 18"]);
  expect(pick(runtimes, "iPhone 18 Pro")[1].identifier).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro");
  expect(() => pick(runtimes, "Pixel 9")).toThrow("no iOS runtime has the device type Pixel 9");
  expect(pick(runtimes, "iPad Air 11-inch").map((x) => x.name)).toEqual(["iOS 27.0", "iPad Air 11-inch"]);
  expect(() => pick([])).toThrow("no iOS runtime");
  // A runtime made for one device ("iPhone Duo") never gives the golden its device.
  const duo = iosRuntimes(
    JSON.stringify({
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2",
          name: "iOS 27.2",
          version: "27.2",
          isAvailable: true,
          platform: "iOS",
          supportedDeviceTypes: [
            { identifier: "a.iPhone-17", name: "iPhone 17" },
            { identifier: "a.iPhone-17-Pro", name: "iPhone 17 Pro" },
          ],
        },
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-2-iPhone19-4",
          name: "iOS 27.2",
          version: "27.2",
          isAvailable: true,
          platform: "iOS",
          supportedDeviceTypes: [{ identifier: "a.iPhone-Duo", name: "iPhone Duo" }],
        },
      ],
    }),
  );
  const [r, t] = pick(duo);
  expect([r.identifier, t.name]).toEqual(["com.apple.CoreSimulator.SimRuntime.iOS-27-2", "iPhone 17"]);
  expect(udidOf(" 0F3C2A1B-1111-2222-3333-444455556666\n")).toBe("0F3C2A1B-1111-2222-3333-444455556666");
  expect(udidOf("An error was encountered")).toBeUndefined();
  expect(devices(JSON.stringify({ devices: { b: [{ udid: "2", name: "y", state: "Booted" }], a: [{ udid: "1", name: "x", state: "Shutdown" }] } })).map((d) => d.udid)).toEqual(["1", "2"]);
  expect(xcodeFrom(RUNTIMES)).toEqual({ ok: "iOS 27.0" });
  expect(xcodeFrom(undefined)).toMatchObject({ fix: expect.stringContaining("xcodes install") });
});

test("a simulator's cpu is its launchd_sim and everything under it; failed boots back off", () => {
  const ps = [
    "    1     0   0.5 /sbin/launchd",
    "  500     1  12.0 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/launchd_sim /Users/me/n/device/ios/set/AAAA-1/data/var/run/launchd_bootstrap.plist",
    "  501   500  80.5 /RuntimeRoot/usr/libexec/backboardd",
    "  502   501   7.5 /RuntimeRoot/usr/libexec/assetsd",
    "  600     1   3.0 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/launchd_sim /Users/me/n/device/ios/set/BBBB-2/data/var/run/launchd_bootstrap.plist",
    "  601   600  90.0 /RuntimeRoot/usr/libexec/backboardd",
    "  700     1  50.0 /usr/bin/cargo build",
  ].join("\n");
  expect(deviceCpu(ps, "AAAA-1")).toBe(100);
  expect(deviceCpu(ps, "BBBB-2")).toBe(93);
  expect(deviceCpu(ps, "CCCC-3")).toBe(0);

  expect([backoff(1), backoff(2), backoff(5), backoff(6), backoff(1000)]).toEqual([60_000, 120_000, 960_000, BACKOFF_MAX, BACKOFF_MAX]);
  const refill = new Refill();
  const t0 = 1_000_000;
  expect(refill.mayBoot(t0)).toBe(true);
  refill.started(t0);
  expect(refill.mayBoot(t0)).toBe(false);
  refill.failed(t0, "simctl boot failed");
  refill.started(t0 + 60_000);
  refill.failed(t0 + 60_000, "simctl boot failed");
  const after = t0 + 60_000;
  expect(refill.mayBoot(after + 119_000)).toBe(false);
  expect(refill.wait(after + 1_000)).toEqual({ secs: 149, failing: "simctl boot failed", retryIn: 119 });
  expect(waitingWords(refill.wait(after + 1_000))[0]).toContain("keep failing to boot");
  expect(refill.mayBoot(after + 120_000)).toBe(true);
  refill.started(after + 120_000);
  refill.succeeded(after + 160_000);
  expect([refill.failures, refill.lastBoot]).toEqual([0, 40_000]);
  expect(waitingWords(refill.wait(after + 160_000))[0]).toBe("Starting a simulator for you; it is ready in about 40 s.");
  expect(simBudget(16 * 2 ** 30)).toBe(2);
});

test("an agent finds the iOS wrapper first and its own home; the wrapper switches to a lent clone's home", () => {
  const env = new Map(iosEnv("/n", "s1", "/usr/bin"));
  expect(env.get("PATH")).toBe("/n/device/ios/bin:/usr/bin");
  expect(env.get("AGENT_DEVICE_HOME")).toBe("/n/sessions/s1/agent-device");
  expect(env.get("FLEETD_DEVICE_CONTROL")).toBe("/n/sessions/s1/device-control");
  expect(env.get("FLEETD_RUNNER_STARTING")).toBe("/n/sessions/s1/runner-starting");
  expect(env.size).toBe(5);
  expect(new Map(iosEnv("/n", "s1")).get("PATH")).toBe("/n/device/ios/bin");

  const home = tempHome();
  cleanups.push(home.done);
  writeConfig(home.dir, "s1", "AAAA", join(home.dir, "ios-clones/AAAA"));
  const dir = sessionDir(home.dir, "s1");
  expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({ platform: "ios", udid: "AAAA" });
  expect(readFileSync(join(dir, LENT), "utf8")).toBe(join(home.dir, "ios-clones/AAAA"));
  writeConfig(home.dir, "s1", "BBBB");
  expect(existsSync(join(dir, LENT))).toBe(false);

  const script = wrapperScript("/n/pkg/bin/agent-device.mjs", "/n", "/n/run.xctestrun");
  expect(script).toContain("AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET='/n/device/ios/set'");
  expect(script).toContain("AGENT_DEVICE_IOS_XCTESTRUN_FILE='/n/run.xctestrun'");
  expect(wrapperScript("/e", "/n")).not.toContain("XCTESTRUN_FILE");
  if (!Bun.which("node")) return;
  // The wrapper runs a stand-in for agent-device that says which home it got.
  const fake = join(home.dir, "fake.mjs");
  writeFileSync(fake, "console.log(process.env.AGENT_DEVICE_HOME, process.env.AGENT_DEVICE_STATE_DIR)\n");
  const wrapper = join(home.dir, "agent-device");
  writeFileSync(wrapper, wrapperScript(fake, home.dir));
  chmodSync(wrapper, 0o755);
  writeFileSync(join(dir, LENT), "/clone/home");
  const ran = Bun.spawnSync([wrapper], { env: { ...process.env, AGENT_DEVICE_HOME: dir, FLEETD_DEVICE_CONTROL: "", FLEETD_RUNNER_STARTING: "" } });
  expect(ran.stdout.toString().trim()).toBe("/clone/home /clone/home/state");
});

test("the golden's runner is its newest simulator .xctestrun, and a golden counts only with it", () => {
  const home = tempHome();
  cleanups.push(home.done);
  expect(() => builtXctestrun(home.dir)).toThrow("built no simulator runner");
  const built = join(runnerDir(home.dir), "Build/Products");
  mkdirSync(built, { recursive: true });
  const old = join(built, "AgentDeviceRunner_iphonesimulator26.0-arm64.xctestrun");
  const fresh = join(built, "AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun");
  for (const f of [old, fresh, join(built, "AgentDeviceRunner.env.4711.iphonesimulator.xctestrun"), join(built, "AgentDeviceRunner_iphoneos.xctestrun")]) writeFileSync(f, "");
  utimesSync(old, new Date(1_000_000), new Date(1_000_000));
  expect(builtXctestrun(home.dir)).toBe(fresh);

  fakeAgentDevice(home.dir);
  const golden = writeGolden(home.dir, fresh);
  expect(findGolden(home.dir)).toEqual(golden);
  expect(findGolden(home.dir, "iPhone 18 Pro")).toBeUndefined();
  // An older node's golden of another type, or of a non-plain iPhone, is made again.
  writeFileSync(goldenPath(home.dir), JSON.stringify({ ...golden, deviceTypeName: "iPhone Duo" }));
  expect(findGolden(home.dir)).toBeUndefined();
  writeFileSync(goldenPath(home.dir), JSON.stringify({ ...golden, xctestrun: join(home.dir, "gone.xctestrun") }));
  expect(findGolden(home.dir)).toBeUndefined();
});

test("the doctor says where the Mac's simulators stand", () => {
  const xcode = () => ({ ok: "iOS 27.0" });
  const golden = { runtimeName: "iOS 27.0", deviceTypeName: "iPhone 18" } as Golden;
  expect(healthFrom({ enabled: true }, golden, { preparing: false })?.health.state).toBe("ready");
  expect(healthFrom({ enabled: true }, undefined, { preparing: true })).toMatchObject({ health: { state: "preparing" }, placeable: true });
  expect(healthFrom({}, undefined, { preparing: false }, xcode)?.health.state).toBe("wanted");
  expect(healthFrom({}, undefined, { preparing: false }, () => ({ err: "no Xcode" }))).toBeUndefined();
  expect(healthFrom({ enabled: true }, undefined, { preparing: false }, xcode, () => false)?.health.fix).toBe("brew install node");
  expect(healthFrom({ enabled: true }, undefined, { preparing: false, failed: "boom" }, xcode, () => true)).toMatchObject({
    health: { state: "unavailable", message: expect.stringContaining("boom") },
    placeable: true,
  });
});

/** agent-device's pinned install, its entry a stand-in. */
function fakeAgentDevice(home: string): void {
  mkdirSync(dirname(entry(home)), { recursive: true });
  writeFileSync(entry(home), "");
  mkdirSync(androidBin(home), { recursive: true });
  writeFileSync(join(androidBin(home), "agent-device"), "#!/bin/sh\n");
  writeFileSync(join(dirname(androidBin(home)), "VERSION"), VERSION);
}

function writeGolden(home: string, xctestrun: string): Golden {
  const golden: Golden = {
    udid: "60LDE000-0000-0000-0000-000000000000",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    runtimeName: "iOS 27.0",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-18",
    deviceTypeName: "iPhone 18",
    scale: 3,
    agentDevice: VERSION,
    xctestrun,
  };
  mkdirSync(dirname(goldenPath(home)), { recursive: true });
  writeFileSync(goldenPath(home), JSON.stringify(golden));
  installWrapper(home, xctestrun);
  return golden;
}

/** A stand-in `xcrun simctl --set <set> …`: each call logged, a fresh udid for a clone or create. */
function fakeXcrun(home: string): { xcrun: string; log: string } {
  const xcrun = join(home, "bin/xcrun");
  const log = join(home, "xcrun.log");
  const runtimes = join(home, "runtimes.json");
  writeFileSync(runtimes, RUNTIMES);
  mkdirSync(dirname(xcrun), { recursive: true });
  writeFileSync(
    xcrun,
    `#!/bin/sh
shift 3
echo "$@" >> '${log}'
case "$1" in
  list) if [ "$2" = runtimes ]; then cat '${runtimes}'; else echo '{"devices":{"r":[{"udid":"LEFT-OVER","name":"fleetd-x","state":"Booted"}]}}'; fi ;;
  clone|create) tr a-z A-Z < /proc/sys/kernel/random/uuid ;;
esac
exit 0
`,
  );
  chmodSync(xcrun, 0o755);
  return { xcrun, log };
}

test("mac sim start lends a warm clone within the Mac's budget of 2, and mac sim end deletes it", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  fakeAgentDevice(home.dir);
  const xctestrun = join(home.dir, "runner.xctestrun");
  writeFileSync(xctestrun, "");
  const golden = writeGolden(home.dir, xctestrun);
  const { xcrun, log } = fakeXcrun(home.dir);
  const started: string[] = [];
  const simulators = new Simulators(home.dir, { enabled: true }, {
    simctl: new Simctl(setDir(home.dir), xcrun),
    runner: async (_home, lent) => void started.push(lent.udid),
  });
  const sims = new MacSims(home.dir, simulators, 2, () => 64 * 2 ** 30);
  cleanups.push(() => sims.shutdown());
  expect(sims.budget()).toBe(2);
  expect(new MacSims(home.dir, simulators, undefined, () => 16 * 2 ** 30).budget()).toBe(2);

  await simulators.start();
  // The clone a stopped node left goes; the golden stays.
  expect(readFileSync(log, "utf8")).toContain("delete LEFT-OVER");
  expect(readFileSync(log, "utf8")).not.toContain(`delete ${golden.udid}`);
  await until(() => simulators.warm() === 1);

  const host = new Host(join(home.dir, "mac"), { open: () => null });
  host.sims = sims;
  const a = host.agent({ machineId: "devbox", projectId: "p1", threadId: "ta", taskId: "T1" });
  const [done] = await host.step(a, { step: "sim_start" });
  expect(done).toMatchObject({ step: "sim_start", device: "iPhone 18 on iOS 27.0" });
  const udid = (done as { udid: string }).udid;
  expect(started).toContain(udid);
  expect(JSON.parse(readFileSync(simConfig(home.dir, "T1"), "utf8"))).toEqual({ platform: "ios", udid });
  expect(readFileSync(join(sessionDir(home.dir, simKey("T1")), LENT), "utf8")).toBe(join(home.dir, "ios-clones", udid));
  // Its own again; another device type is refused while it holds this one.
  expect((await host.step(a, { step: "sim_start" }))[0]).toMatchObject({ udid });
  await expect(host.step(a, { step: "sim_start", device: "iPhone 18 Pro" })).rejects.toThrow("You hold a iPhone 18 on iOS 27.0 simulator already.");
  // Its jobs' agent-device and simctl are pointed at it.
  const env = jobEnv(a, "/c", [], { PATH: "/usr/bin" }, (path) => sims.env(a.name, path));
  expect(env.FLEETD_MAC_SIM).toBe(udid);
  expect(env.PATH!.startsWith(join(home.dir, "device/ios/bin:"))).toBe(true);

  await until(() => simulators.warm() === 1);
  const b = host.agent({ machineId: "devbox", projectId: "p1", threadId: "tb", taskId: "T2" });
  await host.step(b, { step: "sim_start" });
  await until(() => simulators.warm() === 1);
  // A third agent finds every simulator of the budget in use.
  const c = host.agent({ machineId: "devbox", projectId: "p2", threadId: "tc", taskId: "T3" });
  await expect(host.step(c, { step: "sim_start" })).rejects.toThrow("All 2 of the Mac's iOS simulators are in use by other agents.");

  expect((await host.step(a, { step: "sim_end" }))[0]).toEqual({ step: "sim_end", ended: true });
  expect((await host.step(a, { step: "sim_end" }))[0]).toEqual({ step: "sim_end", ended: false });
  await until(() => readFileSync(log, "utf8").includes(`delete ${udid}`));
  expect(existsSync(simConfig(home.dir, "T1"))).toBe(false);
  expect((await host.step(c, { step: "sim_start" }))[0]).toMatchObject({ step: "sim_start" });
  expect(sims.activity().map((s) => s.agent)).toEqual(["T2", "T3"]);

  // Another device type is made from nothing for the agent alone.
  sims.end("T3");
  const [own] = await host.step(c, { step: "sim_start", device: "iPhone 18 Pro" });
  expect(own).toMatchObject({ device: "iPhone 18 Pro on iOS 27.0" });
  expect(readFileSync(log, "utf8")).toContain("create fleetd-");

  // Nobody used T2's for the idle time: it goes.
  expect(sims.endIdle(0, Date.now() + 1)).toEqual(["T2", "T3"]);
  expect(sims.held.size).toBe(0);
});

test("simulators go to agents in the order they asked, and --no-wait says why there is none", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  fakeAgentDevice(home.dir);
  const xctestrun = join(home.dir, "runner.xctestrun");
  writeFileSync(xctestrun, "");
  writeGolden(home.dir, xctestrun);
  const { xcrun } = fakeXcrun(home.dir);
  const simulators = new Simulators(home.dir, { enabled: true }, { simctl: new Simctl(setDir(home.dir), xcrun), runner: async () => {} });
  const sims = new MacSims(home.dir, simulators, 2, () => 64 * 2 ** 30);
  cleanups.push(() => sims.shutdown());
  await simulators.start();
  const host = new Host(join(home.dir, "mac"), { open: () => null });
  host.sims = sims;
  const agent = (t: string) => host.agent({ machineId: "devbox", projectId: "p1", threadId: `t${t}`, taskId: t });
  const [a, b, c, d, e] = [agent("T1"), agent("T2"), agent("T3"), agent("T4"), agent("T5")];
  const start = async (who: typeof a, wait = true) => (await host.step(who, { step: "sim_start", wait }))[0];
  for (const who of [a, b]) {
    await until(() => simulators.warm() === 1);
    expect(await start(who)).toMatchObject({ step: "sim_start" });
  }
  // Both in use: the next agents wait in the order they asked.
  const full = "all 2 of the Mac's iOS simulators are in use by other agents";
  expect(await start(c)).toEqual({ step: "sim_queued", place: 1, secs: null, why: full });
  expect(await start(d)).toEqual({ step: "sim_queued", place: 2, secs: null, why: full });
  await expect(start(d, false)).rejects.toMatchObject({
    message: "All 2 of the Mac's iOS simulators are in use by other agents.",
    fix: "mac sim start without --no-wait waits its turn, or carry on without one",
  });
  // One ends: it is c's, however often d asks; e without waiting is told who is ahead.
  sims.end("T1");
  await until(() => simulators.warm() === 1);
  expect(await start(d)).toEqual({ step: "sim_queued", place: 2, secs: null, why: "the agents ahead of you get theirs first" });
  await expect(start(e, false)).rejects.toThrow("2 agents are waiting for the Mac's iOS simulators, and get theirs first.");
  expect(await start(c)).toMatchObject({ step: "sim_start" });
  expect(await start(d)).toEqual({ step: "sim_queued", place: 1, secs: null, why: full });
  // `mac sim end` leaves the line.
  expect((await host.step(d, { step: "sim_end" }))[0]).toEqual({ step: "sim_end", ended: false });
  expect(sims.queue.ask("T5", Date.now())).toBe(1);
});

test("first in line with the pool booting its clone, it waits for that one; a pool backing off says so", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  let waiting: Waiting = { secs: 40 };
  const pool = { lendOrWait: () => ({ waiting }), readyIn: () => 40 } as unknown as Simulators;
  const sims = new MacSims(home.dir, pool, 2);
  const agent = { name: "T1", project: "p" };
  expect(await sims.start(agent, undefined, true)).toEqual({ step: "sim_queued", place: 1, secs: 40, why: "yours is booting" });
  waiting = { secs: 40, failing: "simctl boot failed" };
  expect(await sims.start(agent, undefined, true)).toMatchObject({ place: 1, why: "the last boot failed (simctl boot failed); yours is booting again" });
  // Without waiting: why there is none, as before the line; the next one asking first is not behind T1.
  await expect(sims.start({ name: "T2", project: "p" })).rejects.toThrow("1 agents are waiting for the Mac's iOS simulators, and get theirs first.");
  waiting = { secs: 160, failing: "simctl boot failed", retryIn: 120 };
  await expect(sims.start(agent, undefined, true)).rejects.toThrow("keep failing to boot (simctl boot failed); it tries again in about 120 s");
  expect(sims.queue.ask("T2", Date.now())).toBe(1);
  sims.queue.leave("T2");
  waiting = { secs: 40 };
  await expect(sims.start(agent)).rejects.toMatchObject({
    message: "Starting a simulator for you; it is ready in about 40 s.",
    fix: "try mac sim start again in about 40 s",
  });
});

test("simulators wait for Developer Mode, and a Mac without them says so", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  writeFileSync(
    join(home.dir, "mac-health.json"),
    JSON.stringify({ user: "agents", checks: [{ id: "developer", state: "fail", message: "Developer Mode is off.", command: "sudo DevToolsSecurity -enable" }] }),
  );
  expect(blocksSimulators(home.dir)).toMatchObject({ message: "Developer Mode is off.", command: "sudo DevToolsSecurity -enable" });
  const simulators = new Simulators(home.dir, {}, { simctl: new Simctl(setDir(home.dir), "/nonexistent/xcrun") });
  const sims = new MacSims(home.dir, simulators, 2);
  const blocked = await sims.start({ name: "T1", project: "p" }).catch((e: { message: string; fix?: string }) => e);
  expect(blocked).toMatchObject({ message: expect.stringContaining("Developer Mode is off."), fix: expect.stringContaining("`sudo DevToolsSecurity -enable`") });
  writeFileSync(join(home.dir, "mac-health.json"), JSON.stringify({ user: "agents", checks: [] }));
  await expect(sims.start({ name: "T1", project: "p" })).rejects.toThrow("has iOS simulators turned off");
  const host = new Host(join(home.dir, "mac"), { open: () => null });
  const a = host.agent({ machineId: "devbox", projectId: "p1", threadId: "ta" });
  for (const wait of [true, false]) await expect(host.step(a, { step: "sim_start", wait })).rejects.toThrow("its golden simulator isn't made");
  expect((await host.step(a, { step: "sim_end" }))[0]).toEqual({ step: "sim_end", ended: false });
});

test("the Mac's heartbeat carries its simulators' state for the doctor", async () => {
  const { testNode } = await import("./node_helpers.ts");
  const { host, startSims, stop } = await import("../src/node/mac_tool/index.ts");
  const hbOf = async (t: { node: import("../src/node/api.ts").Node }) => {
    const hb = { load: { cpus: 1 } as never, steps: [] as unknown[], busy: { threads: 0, screens: 0, uploads: 0, hosted: 0 } };
    await t.node.area("hb").fill(hb);
    return (hb.load as { ios?: { state: string; message: string } }).ios;
  };
  const ready = testNode("mac1", { agentsMac: true });
  cleanups.push(ready.done);
  fakeAgentDevice(ready.node.home);
  const xctestrun = join(ready.node.home, "runner.xctestrun");
  writeFileSync(xctestrun, "");
  writeGolden(ready.node.home, xctestrun);
  const { xcrun } = fakeXcrun(ready.node.home);
  const simctl = new Simctl(setDir(ready.node.home), xcrun);
  startSims(ready.node, host(ready.node, new Host(join(ready.node.home, "work"), { open: () => null })), new Simulators(ready.node.home, { enabled: true }, { simctl, runner: async () => {} }), 2);
  cleanups.push(() => stop(ready.node));
  expect(await hbOf(ready)).toMatchObject({ state: "ready", message: expect.stringContaining("iPhone 18") });

  // A golden that couldn't be made says so, with why.
  const failed = testNode("mac2", { agentsMac: true });
  cleanups.push(failed.done);
  const making = new Simulators(failed.node.home, { enabled: true }, { simctl, prepare: async () => Promise.reject(new Error("no iOS runtime")) });
  startSims(failed.node, host(failed.node, new Host(join(failed.node.home, "work"), { open: () => null })), making, 2);
  cleanups.push(() => stop(failed.node));
  await until(() => !JSON.parse(readFileSync(join(failed.node.home, "device/ios/state.json"), "utf8")).preparing);
  expect((await hbOf(failed))?.state).toBe("unavailable");
});

test("a node that stops while a clone still starts its runner throws that clone away, its agent-device daemon first", async () => {
  const home = tempHome();
  cleanups.push(home.done);
  fakeAgentDevice(home.dir);
  const xctestrun = join(home.dir, "runner.xctestrun");
  writeFileSync(xctestrun, "");
  const golden = writeGolden(home.dir, xctestrun);
  const { xcrun, log } = fakeXcrun(home.dir);
  // The clone's daemon, as agent-device registers it while `prepare ios-runner` runs.
  const daemon = Bun.spawn(["sleep", "30"]);
  cleanups.push(() => daemon.kill());
  let udid = "";
  let cloneHome = "";
  let release = () => {};
  const pool = new Pool(new Simctl(setDir(home.dir), xcrun), home.dir, golden, 1, async (_home, lent) => {
    const state = join(lent.home, "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "daemon.json"), JSON.stringify({ pid: daemon.pid, stateDir: state }));
    [udid, cloneHome] = [lent.udid, lent.home];
    await new Promise<void>((r) => (release = r));
  });
  pool.refill();
  await until(() => udid !== "");
  expect(pool.warm()).toBe(0);
  await pool.drain();
  await daemon.exited;
  expect(daemon.signalCode).toBe("SIGTERM");
  expect(readFileSync(log, "utf8")).toContain(`shutdown ${udid}`);
  expect(readFileSync(log, "utf8")).toContain(`delete ${udid}`);
  expect(existsSync(cloneHome)).toBe(false);
  release();
  await until(() => pool.warm() === 0);
});
