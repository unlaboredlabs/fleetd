// The agents' Mac keeps room (W827, Nov 22: 1.1 GB left and every iOS build failing): ended tasks' folders go when the
// hub says so, builds land in the agent's own DerivedData, caches go while the disk is short, and the doctor warns.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as checks from "../src/hub/doctor/checks.ts";
import { ENDED_DAYS, tellEnded } from "../src/hub/mac_tool/index.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import { CACHE_IDLE, Host, LOW_FREE, relieve, ROOM_FREE, sweep, sweepXcode, XCODEBUILD } from "../src/node/mac_tool/host.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import type { Task } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";
import { addMachine, testHub } from "./screens_helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()));

const DAY = 86_400_000;

/** A Mac's `~/work` in a temp folder, with a host over it. */
function mac() {
  const home = tempHome();
  const host = new Host(join(home.dir, "work"), new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32))));
  cleanups.push(home.done, () => host.stop());
  return { host, root: host.root, home: home.dir };
}

/** An agent's folder as a step leaves it, with a build in its DerivedData, last used `usedMs` ago. */
function folder(root: string, name: string, usedMs = 0, now = Date.now()): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "DerivedData", "Build"), { recursive: true });
  writeFileSync(join(dir, "DerivedData", "Build", "app.o"), "x");
  writeFileSync(join(dir, ".used"), "");
  const at = (now - usedMs) / 1000;
  utimesSync(join(dir, ".used"), at, at);
  return dir;
}

/** One of Xcode's own DerivedData builds, last written `agoMs` ago. */
function xcodeBuild(dir: string, name: string, agoMs: number, now = Date.now()): void {
  const build = join(dir, name);
  mkdirSync(join(build, "Build", "Products"), { recursive: true });
  writeFileSync(join(build, "Build", "Products", "App.app"), "x");
  const at = (now - agoMs) / 1000;
  for (const p of [build, join(build, "Build"), join(build, "Build", "Products")]) utimesSync(p, at, at);
}

test("the wrapper builds an action-less xcodebuild (expo run:ios's) into the agent's own DerivedData, and leaves reads alone", () => {
  const home = tempHome();
  cleanups.push(home.done);
  // A stand-in for /usr/bin/xcodebuild that prints the line it was given.
  const real = join(home.dir, "xcodebuild-real");
  writeFileSync(real, '#!/bin/sh\necho "$@"\n');
  chmodSync(real, 0o755);
  const shim = join(home.dir, "xcodebuild");
  writeFileSync(shim, XCODEBUILD.replaceAll("/usr/bin/xcodebuild", real));
  chmodSync(shim, 0o755);
  const run = (...args: string[]) =>
    Bun.spawnSync([shim, ...args], { env: { PATH: "/usr/bin:/bin", FLEETD_MAC_DERIVED_DATA: "/w/T7/DerivedData" } }).stdout.toString().trim();
  const dd = "-derivedDataPath /w/T7/DerivedData";
  // expo run:ios: no action word, the default action is build. It went to Xcode's own DerivedData before.
  expect(run("-workspace", "App.xcworkspace", "-configuration", "Debug", "-scheme", "App", "-destination", "id=U1")).toBe(
    `-workspace App.xcworkspace -configuration Debug -scheme App -destination id=U1 ${dd}`,
  );
  expect(run("-project", "A.xcodeproj", "build")).toBe(`-project A.xcodeproj build ${dd}`);
  expect(run("test", "-scheme", "App")).toBe(`test -scheme App ${dd}`);
  // Its own path wins; reads and exports go as they were.
  expect(run("-scheme", "App", "-derivedDataPath", "/mine")).toBe("-scheme App -derivedDataPath /mine");
  expect(run("-workspace", "App.xcworkspace", "-list")).toBe("-workspace App.xcworkspace -list");
  expect(run("-version")).toBe("-version");
  expect(run("-exportArchive", "-archivePath", "a.xcarchive")).toBe("-exportArchive -archivePath a.xcarchive");
});

test("a folder an older node made gets the new wrapper at the agent's next step", () => {
  const { host, root } = mac();
  mkdirSync(join(root, "T7", "bin"), { recursive: true });
  writeFileSync(join(root, "T7", "bin", "xcodebuild"), "#!/bin/sh\nexec /usr/bin/xcodebuild \"$@\"\n");
  host.agent({ machineId: "devbox", projectId: "p1", taskId: "T7", threadId: "t1" });
  expect(readFileSync(join(root, "T7", "bin", "xcodebuild"), "utf8")).toBe(XCODEBUILD);
});

test("the hub's word that tasks ended for good removes their folders, never a busy agent's or one outside ~/work", async () => {
  const { host, root } = mac();
  for (const t of ["T1", "T2", "T3"]) folder(root, t);
  mkdirSync(join(root, ".cache"));
  // T2 runs a job and T3 holds a simulator: theirs stay until the next word.
  host.sims = {
    activity: () => [{ agent: "T3", projectId: "p1", device: "iPhone 17", sinceMs: 1 }],
    touch: () => {},
    ran: () => {},
    env: () => undefined,
  } as never;
  const job = (await host.step(host.agent({ machineId: "devbox", projectId: "p1", taskId: "T2", threadId: "t2" }), {
    step: "run",
    args: ["sleep 5"],
    env: [],
    background: true,
  })) as [{ job: number }, Uint8Array];
  expect(job[0].job).toBe(1);
  expect(await host.ended(["T1", "T2", "T3", "T9", "../x", ".cache"])).toEqual(["T1"]);
  expect(readdirSync(root).sort()).toEqual([".cache", "T2", "T3"]);
});

test("the sweep keeps a folder nothing touched for FOLDER_DAYS while its agent still runs a job there", async () => {
  const { root } = mac();
  const now = Date.now();
  folder(root, "T1", 4 * DAY, now);
  folder(root, "T2", 4 * DAY, now);
  folder(root, "T3", 0, now);
  expect(await sweep(root, 3, now, new Set(["T2"]))).toEqual(["T1"]);
  expect(readdirSync(root).sort()).toEqual(["T2", "T3"]);
});

test("builds in Xcode's own DerivedData no build wrote to for FOLDER_DAYS go; newer ones stay", async () => {
  const { home } = mac();
  const dd = join(home, "Library", "Developer", "Xcode", "DerivedData");
  const now = Date.now();
  xcodeBuild(dd, "fleetd-old", 5 * DAY, now);
  xcodeBuild(dd, "fleetd-new", DAY, now);
  expect(await sweepXcode(dd, 3, now)).toEqual(["DerivedData/fleetd-old"]);
  expect(readdirSync(dd)).toEqual(["fleetd-new"]);
});

test("short of disk, the Mac frees caches oldest first until it has room: Xcode's builds, then idle agents' DerivedData", async () => {
  const { root, home } = mac();
  const dd = join(home, "Library", "Developer", "Xcode", "DerivedData");
  const now = Date.now();
  xcodeBuild(dd, "fleetd-a", 2 * DAY, now);
  // Written within CACHE_IDLE: a build may be writing it now.
  xcodeBuild(dd, "fleetd-live", 60_000, now);
  folder(root, "T1", 5 * 3600_000, now);
  folder(root, "T2", 2 * 3600_000, now);
  folder(root, "T3", 2 * 3600_000, now);
  folder(root, "T4", CACHE_IDLE / 2, now);
  // Each cache freed gives 15 GB back, from 12 GB free.
  const freed = () => 12e9 + 15e9 * gone().length;
  const gone = () => [
    ...["fleetd-a", "fleetd-live"].filter((b) => !existsSync(join(dd, b))),
    ...["T1", "T2", "T3", "T4"].filter((t) => !existsSync(join(root, t, "DerivedData", "Build"))),
  ];
  const out = await relieve(root, dd, new Set(["T3"]), () => freed(), now);
  // 12 → 27 → 42 → 57 GB: Xcode's idle build, then T1's (least recently used), then T2's; T3 is busy, T4 too new.
  expect(out).toEqual(["DerivedData/fleetd-a", "T1/DerivedData", "T2/DerivedData"]);
  expect(freed()).toBeGreaterThanOrEqual(ROOM_FREE);
  expect(existsSync(join(dd, "fleetd-live"))).toBe(true);
  // A freed DerivedData is there again, empty, for the next build; the agent's repo and the rest stay.
  expect(readdirSync(join(root, "T1", "DerivedData"))).toEqual([]);
  expect(existsSync(join(root, "T1", ".used"))).toBe(true);
  // With room enough, nothing goes.
  expect(await relieve(root, dd, new Set(), () => LOW_FREE, now)).toEqual([]);
});

test("the hub tells an online agents' Mac which tasks ended for good, at each sweep", async () => {
  const t = testHub();
  cleanups.push(() => t.done());
  const db = t.hub.db.conn;
  const now = t.hub.clock.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const task = (n: number, state: Task["state"], endedAgo: number | undefined, worktree?: string) => {
    const made = TaskRecords.create(db, {
      taskId: `T${n}`,
      projectRef: { machineId: "devbox", projectId: "p1" },
      workstreamId: "W1",
      kind: "write",
      title: `task ${n}`,
      prompt: "p",
      state: "queued",
      createdAt: iso(now - 9 * DAY),
    } as Task);
    if (endedAgo !== undefined) TaskRecords.put(db, { task: { ...made, state, endedAt: iso(now - endedAgo) } });
    else TaskRecords.put(db, { task: { ...made, state } });
    if (worktree) TaskRecords.setWorktree(db, made.taskId, worktree);
  };
  task(1, "done", DAY, "removed"); // its PR merged: gone
  task(2, "done", DAY); // its PR not merged yet: it may go on
  task(3, "cancelled", DAY); // cancelled: never goes on
  task(4, "failed", 2 * DAY, "given_up");
  task(5, "running", undefined);
  task(6, "done", (ENDED_DAYS + 1) * DAY, "removed"); // the Mac's own sweep took it long ago
  task(7, "idle", undefined); // a reader waiting for the lead's next message
  expect(TaskRecords.endedForGood(db, iso(now - ENDED_DAYS * DAY))).toEqual(["T1", "T3", "T4"]);

  const sent: [string, Record<string, unknown>][] = [];
  t.link.answer = async (machine, frame) => {
    sent.push([machine, frame as Record<string, unknown>]);
    return { t: "node_action_result", id: "x", ok: true, message: "removed T1" };
  };
  // No Mac, or one offline: nothing is sent.
  addMachine(t.hub, "devbox");
  addMachine(t.hub, "mac1", { agentsMac: true, status: "offline" });
  await tellEnded(t.hub);
  expect(sent).toEqual([]);
  db.query("UPDATE machines SET data = json_set(data, '$.status', 'online') WHERE machine_id = 'mac1'").run();
  await tellEnded(t.hub);
  expect(sent).toEqual([["mac1", expect.objectContaining({ t: "node_action", action: "mac_ended", tasks: ["T1", "T3", "T4"] })]]);
  // A Mac that doesn't answer is told again at the next sweep; the sweep itself carries on.
  t.link.answer = async () => {
    throw new Error("not linked");
  };
  await tellEnded(t.hub);
});

test("the doctor warns on the agents' Mac's disk below 30 GB and fails below 10 GB; it said ok at 1 GB before", () => {
  const disk = (free: number) => ({ freeBytes: free, totalBytes: 245e9, minFreeBytes: 24.5e9 });
  expect(checks.diskSpace("mac1", false, disk(1.1e9), undefined).status).toBe("ok");
  expect(checks.macDisk("mac1", false, disk(92e9))).toMatchObject({ status: "ok", message: "92.0 GB free of 245.0 GB on mac1." });
  const low = checks.macDisk("mac1", false, disk(20e9));
  expect(low.status).toBe("warn");
  expect(low.message).toContain("fleetd frees old builds by itself");
  const full = checks.macDisk("mac1", false, disk(1.1e9));
  expect(full.status).toBe("fail");
  expect(full.message).toBe("1.1 GB free of 245.0 GB on mac1: iOS builds and new simulators fail for lack of room.");
  expect(full.fix).toMatchObject({ kind: "manual", command: "xcrun simctl delete unavailable" });
  expect(checks.macDisk("mac1", true, disk(1e9)).status).toBe("unknown");
});
