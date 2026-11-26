// Builds on the agents' Mac wait their turn (Nov 26: eight xcodebuilds at once, each on every core, kept 152
// compilers running and the Mac's load between 300 and 470): every build through fleetd's xcodebuild wrapper takes one
// of the Mac's build slots, sized from its cores and memory, and uses its share of the cores; a build past them queues.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XCODEBUILD } from "../src/node/mac_tool/host.ts";
import { buildSlots } from "../src/node/mac_tool/index.ts";
import { macBuilds } from "../src/node/mac_tool/protocol.ts";
import { tempHome } from "./helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));

const GB = 2 ** 30;
const MAIN = join(import.meta.dir, "..", "src", "main.ts");

test("the Mac's build slots: one per 4 cores and per 4 GB past the 8 it keeps, each build its share of the cores", () => {
  // The agents' Mac: a Mac mini with 12 cores and 16 GB.
  expect(macBuilds(12, 16 * GB)).toEqual({ slots: 2, jobs: 6 });
  expect(macBuilds(8, 8 * GB)).toEqual({ slots: 1, jobs: 8 });
  expect(macBuilds(24, 64 * GB)).toEqual({ slots: 6, jobs: 4 });
  expect(macBuilds(16, 128 * GB)).toEqual({ slots: 4, jobs: 4 });
  expect(macBuilds(4, undefined)).toEqual({ slots: 1, jobs: 4 });
});

/** The wrapper over a stand-in for /usr/bin/xcodebuild that logs when it starts and ends, and the Mac's slots. */
function mac(slots: number) {
  const home = tempHome();
  cleanups.push(home.done);
  const real = join(home.dir, "xcodebuild-real");
  writeFileSync(real, `#!/bin/sh\necho "start $FLEETD_BUILD $(date +%s%N)" >> ${home.dir}/ran\necho "$@"\n[ -z "$FLEETD_HOLD" ] || while [ ! -e "$FLEETD_HOLD" ]; do sleep 0.05; done\necho "end $FLEETD_BUILD $(date +%s%N)" >> ${home.dir}/ran\n`);
  chmodSync(real, 0o755);
  const shim = join(home.dir, "xcodebuild");
  writeFileSync(shim, XCODEBUILD.replaceAll("/usr/bin/xcodebuild", real));
  chmodSync(shim, 0o755);
  const built = buildSlots(home.dir, [process.execPath, MAIN], slots * 4, (8 + slots * 4) * GB);
  const env = (more: Record<string, string> = {}) => ({
    PATH: "/usr/bin:/bin",
    FLEETD_MAC_DERIVED_DATA: "/w/T7/DerivedData",
    FLEETD_MAC_BUILD_SLOT: built.slot,
    FLEETD_MAC_BUILD_JOBS: String(built.jobs),
    ...more,
  });
  const ran = () => (existsSync(join(home.dir, "ran")) ? readFileSync(join(home.dir, "ran"), "utf8").trim().split("\n") : []);
  return { shim, env, ran, built, go: join(home.dir, "go") };
}

test("a build gets its share of the cores and a slot; a read, its settings or its own -jobs go as they are", () => {
  const { shim, env, built } = mac(2);
  expect(built.jobs).toBe(4);
  const run = (...args: string[]) => {
    const r = Bun.spawnSync([shim, ...args], { env: env(), stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString().trim();
  };
  const dd = "-derivedDataPath /w/T7/DerivedData";
  expect(run("-workspace", "App.xcworkspace", "-scheme", "App", "-destination", "id=U1")).toBe(`-workspace App.xcworkspace -scheme App -destination id=U1 ${dd} -jobs 4`);
  expect(run("build", "-scheme", "App", "-jobs", "2")).toBe(`build -scheme App -jobs 2 ${dd}`);
  expect(run("-scheme", "App", "-derivedDataPath", "/mine")).toBe("-scheme App -derivedDataPath /mine -jobs 4");
  // expo run:ios reads where its build went: its own DerivedData, at once.
  expect(run("-workspace", "App.xcworkspace", "-scheme", "App", "-showBuildSettings")).toBe(`-workspace App.xcworkspace -scheme App -showBuildSettings ${dd}`);
  expect(run("-workspace", "App.xcworkspace", "-list")).toBe("-workspace App.xcworkspace -list");
  expect(readFileSync(built.slot, "utf8")).toContain(`heavy-slot --slots 2 '`);
}, 30_000);

test("with both of the Mac's build slots in use, a third build waits, saying so, and starts once one ends", async () => {
  const { shim, env, ran, go } = mac(2);
  // The first two hold their slots until the test lets them go, however slow the machine.
  const start = (n: number, hold: boolean) =>
    Bun.spawn([shim, "build", "-scheme", "App"], { env: env({ FLEETD_BUILD: String(n), ...(hold ? { FLEETD_HOLD: go } : {}) }), stdout: "pipe", stderr: "pipe" });
  const one = start(1, true);
  const two = start(2, true);
  cleanups.push(() => (one.kill(), two.kill()));
  for (const end = Date.now() + 20_000; ran().filter((l) => l.startsWith("start")).length < 2; await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error(`the first two builds didn't start: ${ran().join(" | ")}`);
  }
  const three = start(3, false);
  cleanups.push(() => three.kill());
  let said = "";
  const reader = three.stderr.getReader();
  for (const end = Date.now() + 20_000; !said.includes("waiting for a heavy-run slot"); ) {
    if (Date.now() > end) throw new Error(`the third build didn't say it waits: ${said}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`the third build ended without waiting: ${said} | ${ran().join(" | ")}`);
    said += new TextDecoder().decode(value);
  }
  expect(said).toContain("fleetd: waiting for a heavy-run slot (next in line; 2 slots on this machine, all in use");
  expect(ran().some((l) => l.startsWith("start 3"))).toBe(false);
  writeFileSync(go, "");
  expect(await three.exited).toBe(0);
  await Promise.all([one.exited, two.exited]);
  const at = (what: string) => Number(ran().find((l) => l.startsWith(what))!.split(" ")[2]);
  // The third started only once one of the first two ended.
  expect(at("start 3")).toBeGreaterThanOrEqual(Math.min(at("end 1"), at("end 2")));
}, 60_000);
