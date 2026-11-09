// Ports the core of crates/fleetd/src/hub/update/tests.rs against fake ports: a fake release feed, fake nodes, no
// service manager and no release server.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byMachine, defaultTiming, type Held, HUB_UPDATE_MACHINES_MAX, lastAutoOf, signal, type NodeActionResult, type NodeFacts, type NodeUpdate, type UpdatePorts, Updates } from "../src/hub/update/index.ts";
import { busyWords, healthUrl, updateSummary } from "../src/hub/update/ports.ts";
import type { HubUpdateData, UpdatePart, UpdateRun, UpdateState } from "../src/shared/contracts.ts";
import { type Feed, sha256Hex } from "../src/update/index.ts";
import type { Plan } from "../src/update/finish.ts";
import { atLeast, versionCmp } from "../src/update/version.ts";
import { PROTOCOL as HOSTED } from "../src/node/runner/host.ts";
import { tempHome } from "./helpers.ts";

const home = tempHome();
afterAll(home.done);

const NEW = "1.2.0";
const OLD = "1.1.0";
const NEWER = "1.3.0";
const build = new TextEncoder().encode("new fleetd");

/** A hub on OLD, its channel on NEW, and nodes that come back on what they're told to run. */
class Fake implements UpdatePorts {
  now = 1_000_000;
  version = OLD;
  plans: Plan[] = [];
  updated: string[] = [];
  /** The updates they were sent, in the same order. */
  sent: NodeUpdate[] = [];
  /** The flavour a node from before flavours (none named) runs, by machine: it ignores the one it is told and comes
   * back on this one, naming it. Absent: the hub's. */
  ownFlavour = new Map<string, "rust" | "bun">();
  fetched: string[] = [];
  claude: string[] = [];
  holds = 0;
  facts: NodeFacts[];
  waiters: (() => void)[] = [];
  answer: (m: string) => NodeActionResult = () => ({ ok: true, message: "in place" });
  exePath: string;
  /** What the apps were told (`hub.update`), in order. */
  announced: HubUpdateData[] = [];
  /** The channel's newest build and its bytes. */
  published: [string, Uint8Array] = [NEW, build];
  /** A feed of its own, instead of `published`'s. */
  release?: Feed;

  constructor(dir: string, nodes: Partial<NodeFacts>[]) {
    require("node:fs").mkdirSync(dir, { recursive: true });
    this.exePath = join(dir, "fleetd");
    writeFileSync(this.exePath, "old fleetd");
    this.facts = nodes.map((n, i) => ({
      machineId: `m${i}`,
      name: `m${i}`,
      version: OLD,
      liveSince: 1,
      canUpdate: true,
      canFetch: true,
      canHold: true,
      canInstallClaude: true,
      agentsMac: false,
      claude: "2.0.0 (Claude Code)",
      ...n,
    }));
  }

  feed() {
    if (this.release) return this.release;
    const [version, bytes] = this.published;
    return {
      get: async (name: string) =>
        new TextEncoder().encode(
          name === "release.json" ? JSON.stringify({ cliVersion: version }) : name === "SHA256SUMS" ? `${sha256Hex(bytes)}  fleetd-linux-x64\n` : "",
        ),
      stream: async (name: string, sink: (c: Uint8Array) => void) => sink(name === "fleetd-linux-x64" ? bytes : new Uint8Array()),
    };
  }
  running = () => this.version;
  releaseBuild = () => true;
  exe = () => this.exePath;
  asset = () => "fleetd-linux-x64";
  hubService = () => ({ name: "fleetd-hub.service", unit: "hub" });
  previous = () => new TextEncoder().encode("old fleetd");
  healthUrl = () => "http://127.0.0.1:4795";
  startWatcher(plan: Plan) {
    this.plans.push(plan);
  }
  nodes = () => this.facts.map((f) => ({ ...f }));
  fetchOnNode(m: string) {
    this.fetched.push(m);
  }
  /**
   * Machines whose agents carry on through the restart, by machine: the host protocol their hold answers, and how many
   * of their sessions that aren't hosted (a Navi's) are mid-step. Absent: they don't, as without scopes.
   */
  hosted = new Map<string, [number, number]>();
  /** The machines whose agents were held, a hold each. */
  held: string[] = [];
  async holdNode(m: string, unhosted: boolean): Promise<Held> {
    const hosted = this.hosted.get(m);
    if (hosted && unhosted) return { steps: hosted[1], hosted: hosted[0] };
    this.held.push(m);
    return { steps: this.holds };
  }
  nodeChanged() {
    return new Promise<void>((r) => this.waiters.push(r));
  }
  announce(update: HubUpdateData) {
    this.announced.push(structuredClone(update));
  }
  claudeTarget = () => "2.1.314";
  async installClaude(m: string, v: string) {
    this.claude.push(`${m}@${v}`);
    return { ok: true, message: `Claude Code ${v} installed` };
  }
  async updateNode(m: string, update: NodeUpdate) {
    this.updated.push(m);
    this.sent.push(update);
    const answer = this.answer(m);
    if (answer.ok) {
      // It restarts and links again on the new build.
      setTimeout(() => {
        const f = this.facts.find((x) => x.machineId === m)!;
        f.version = update.version;
        // A node that knows flavours comes back on the one it was told; one from before them on its own, which it names
        // from then on.
        f.flavour = f.flavour !== undefined ? (update.flavour ?? f.flavour) : (this.ownFlavour.get(m) ?? "bun");
        f.liveSince = this.now + 1;
        this.now += 2;
        for (const w of this.waiters.splice(0)) w();
      }, 1);
    }
    return [answer, { tryTake: () => undefined }] as [NodeActionResult, { tryTake(): NodeActionResult | undefined }];
  }
}

const timing = () => ({ ...defaultTiming(), poll: 1, nodePoll: 5, verdict: 50, nodeBack: 200, restart: 30, drainPoll: 1, drain: 50, prefetchEvery: 1000 });

function updatesIn(dir: string, fake: Fake, more: Partial<ReturnType<typeof timing>> = {}) {
  const u = new Updates(join(dir, "update"), { now: () => fake.now }, { ...timing(), ...more });
  u.setPorts(fake);
  return u;
}

// Each step of a run is written to run.json with an fsync, on the test's own thread: a loaded machine (CI, or a busy
// devbox) takes seconds over a run, longer than bun's 5 s default.
setDefaultTimeout(30_000);

async function until(f: () => boolean) {
  for (const end = Date.now() + 20_000; Date.now() < end && !f(); ) await Bun.sleep(5);
  expect(f()).toBe(true);
}

test("the hub stages its new build for the watcher, and the hub that comes up updates the nodes", async () => {
  const dir = join(home.dir, "a");
  const fake = new Fake(dir, [{}, { liveSince: undefined }]);
  const u = updatesIn(dir, fake);
  const started = u.start(undefined, true);
  if (!("run" in started)) throw new Error("refused");
  expect(started.run.parts.map((p) => [p.part, p.machineId ?? null, p.state])).toEqual([
    ["hub", null, "downloading"],
    ["node", "m0", "waiting"],
    ["claude", "m0", "waiting"],
    ["node", "m1", "skipped"],
    ["claude", "m1", "skipped"],
  ]);
  await until(() => fake.plans.length === 1);
  const plan = fake.plans[0]!;
  expect(plan).toMatchObject({ from: OLD, to: NEW, health: { kind: "hub", url: "http://127.0.0.1:4795" }, waitSecs: 90, answered: null });
  // The new build is in place, the old one kept for a rollback, and the online node fetched it alongside.
  expect(readFileSync(fake.exePath, "utf8")).toBe("new fleetd");
  expect(readFileSync(plan.prev, "utf8")).toBe("old fleetd");
  expect(fake.fetched).toEqual(["m0"]);
  expect(byMachine(u.status()!).get("")!.state).toBe("restarting");
  // The watcher restarted the hub onto NEW: the process that comes up reads its verdict and goes on.
  writeFileSync(plan.verdict, JSON.stringify({ state: "done", stage: null, message: `runs ${NEW}` }));
  fake.version = NEW;
  const after = updatesIn(dir, fake);
  await after.resume();
  const run = after.status()!;
  expect(run.parts.map((p) => [p.part, p.machineId ?? null, p.state, p.message])).toEqual([
    ["hub", null, "done", `runs ${NEW}`],
    ["node", "m0", "done", `runs ${NEW}`],
    ["claude", "m0", "done", "Claude Code 2.1.314 installed"],
    ["node", "m1", "skipped", "offline: press Update again once it's online, or run `fleetd update` on it"],
    ["claude", "m1", "skipped", "offline: press Update again once it's online, or run `fleetd update` on it"],
  ]);
  expect(run.finishedAt).toBeDefined();
  expect(JSON.parse(readFileSync(join(dir, "update", "run.json"), "utf8")).id).toBe(run.id);
});

/**
 * The edge release as GitHub serves it while edge republishes it: every read sees the next build, as one reader can get
 * one build's release.json, a cache's older SHA256SUMS and the next build's binary under the same names. Each build's
 * pinned copy (`<asset>-<first 16 hex digits of its SHA-256>`) stays as it was uploaded.
 */
function republishing(builds: [string, Uint8Array][]): Feed & { reads: string[] } {
  const asset = "fleetd-linux-x64";
  const reads: string[] = [];
  const bytesOf = (name: string): Uint8Array => {
    const [version, bytes] = builds[Math.min(reads.length, builds.length - 1)]!;
    reads.push(name);
    const pinned = builds.find(([, b]) => name === `${asset}-${sha256Hex(b).slice(0, 16)}`);
    if (pinned) return pinned[1];
    const sum = sha256Hex(bytes);
    if (name === "release.json") return new TextEncoder().encode(JSON.stringify({ cliVersion: version, sha256: { [asset]: sum } }));
    if (name === "SHA256SUMS") return new TextEncoder().encode(`${sum}  ${asset}\n`);
    return name === asset ? bytes : new Uint8Array();
  };
  return { reads, get: async (name) => bytesOf(name), stream: async (name, sink) => sink(bytesOf(name)) };
}

test("a release republished mid-update installs the build its release.json named, checked against it", async () => {
  const dir = join(home.dir, "republished");
  const fake = new Fake(dir, []);
  const builds: [string, Uint8Array][] = [NEW, NEWER, "1.4.0"].map((v) => [v, new TextEncoder().encode(`fleetd ${v}`)]);
  fake.release = republishing(builds);
  const u = updatesIn(dir, fake);
  u.start(undefined, true);
  await until(() => fake.plans.length === 1 || u.status()?.finishedAt !== undefined);
  const hub = byMachine(u.status()!).get("")!;
  expect([hub.state, hub.stage, hub.message]).toEqual(["restarting", undefined, `restarting on ${NEW}`]);
  expect(fake.plans[0]!.to).toBe(NEW);
  expect(readFileSync(fake.exePath, "utf8")).toBe(`fleetd ${NEW}`);
});

test("a stale release.json naming an older build than the hub's installs nothing", async () => {
  const dir = join(home.dir, "stale");
  const fake = new Fake(dir, []);
  fake.version = NEWER;
  const u = updatesIn(dir, fake);
  await u.prefetch();
  expect(u.ready()).toBeUndefined();
  u.start(undefined, true);
  await until(() => u.status()?.finishedAt !== undefined);
  const hub = byMachine(u.status()!).get("")!;
  expect(hub.state).toBe("current");
  expect(fake.plans).toEqual([]);
});

test("a hub on the channel's build only updates its nodes; a node that refuses says why", async () => {
  const dir = join(home.dir, "b");
  const fake = new Fake(dir, [{}, {}]);
  fake.version = NEW;
  fake.answer = (m) => (m === "m1" ? { ok: false, message: "`fleetd-linux-x64`: checksum mismatch", stage: "checksum" } : { ok: true, message: "ok" });
  const u = updatesIn(dir, fake);
  u.start(undefined, false);
  await until(() => u.status()?.finishedAt !== undefined);
  const parts = byMachine(u.status()!);
  expect([parts.get("")!.state, parts.get("")!.message]).toEqual(["current", `already runs ${NEW}`]);
  expect([parts.get("m0")!.state, parts.get("m1")!.state, parts.get("m1")!.stage]).toEqual(["done", "failed", "checksum"]);
  expect(fake.plans).toEqual([]);
  // Retrying the machine that failed: it goes again, at the hub's build.
  fake.answer = () => ({ ok: true, message: "ok" });
  const again = u.retry("m1", true);
  expect("run" in again).toBe(true);
  await until(() => byMachine(u.status()!).get("m1")!.state === "done");
  expect(u.retry("m9", false)).toEqual({ kind: "nothing_to_retry" });
});

test("an asleep cloud machine isn't told to run fleetd update, and doesn't make an update partial; an offline machine is", async () => {
  const dir = join(home.dir, "cloud");
  const fake = new Fake(dir, [{}, { liveSince: undefined, cloud: true }, { liveSince: undefined }]);
  fake.version = NEW;
  const u = updatesIn(dir, fake);
  u.start(undefined, true);
  await until(() => u.status()?.finishedAt !== undefined);
  const run = u.status()!;
  expect(run.parts.filter((p) => p.part === "node").map((p) => [p.machineId, p.state, p.message])).toEqual([
    ["m0", "done", `runs ${NEW}`],
    ["m1", "skipped", "asleep: it takes the hub's build when it wakes"],
    ["m2", "skipped", "offline: press Update again once it's online, or run `fleetd update` on it"],
  ]);
  expect(signal(run).state).toBe("updated");
  expect(lastAutoOf(run)).toMatchObject({ result: "partial", message: "m2: offline: press Update again once it's online, or run `fleetd update` on it" });
  // Only cloud machines asleep: nothing missed.
  const asleep = { ...run, parts: run.parts.filter((p) => p.machineId !== "m2") };
  expect(lastAutoOf(asleep)).toMatchObject({ result: "done" });
  expect(JSON.stringify(lastAutoOf(asleep))).not.toContain("fleetd update");
});

test("a node waits for its agents, at most the drain, and Update now doesn't wait", async () => {
  const dir = join(home.dir, "c");
  const fake = new Fake(dir, [{}]);
  fake.version = NEW;
  fake.holds = 2;
  const u = updatesIn(dir, fake);
  u.start(undefined, false);
  await until(() => byMachine(u.status()!).get("m0")!.message?.startsWith("waits for 2 agents to finish their step") === true);
  expect(byMachine(u.status()!).get("m0")!.agents).toBe(2);
  expect(fake.updated).toEqual([]);
  // Update now: it stops waiting.
  u.start(undefined, true);
  await until(() => byMachine(u.status()!).get("m0")!.state === "done");
});

test("settings, the automatic update's due time, and its last result", () => {
  const dir = join(home.dir, "d");
  const fake = new Fake(dir, [{}]);
  const u = updatesIn(dir, fake);
  expect(u.settings()).toEqual({ auto: false, drainMinutes: 0 });
  expect(u.setSettings(true, 500)).toEqual({ auto: true, drainMinutes: 240 });
  expect(JSON.parse(readFileSync(join(dir, "update", "settings.json"), "utf8"))).toEqual({ auto: true, drainMinutes: 240 });
  // Auto on, a node left behind: due now.
  fake.version = NEW;
  expect(u.autoAt()).toBe(fake.now);
  expect(
    lastAutoOf({
      id: "U1",
      channel: "edge",
      to: NEW,
      startedAt: "2026-11-08T10:00:00.000Z",
      parts: [
        { part: "hub", name: "the hub", from: OLD, state: "done" },
        { part: "node", machineId: "m0", name: "lab", from: OLD, state: "failed", message: "didn't come back" },
        { part: "node", machineId: "m1", name: "mac", from: OLD, state: "skipped", message: "offline" },
      ],
    }),
  ).toEqual({ at: "2026-11-08T10:00:00.000Z", to: NEW, result: "partial", message: "lab: didn't come back (1 more didn't update)" });
  expect(existsSync(join(dir, "update", "run.json"))).toBe(false);
});

test("the apps hear updating, each machine coming back, and updated, once per change", async () => {
  const dir = join(home.dir, "h");
  const fake = new Fake(dir, [{ name: "builder" }, { name: "nas", liveSince: undefined }]);
  const u = updatesIn(dir, fake);
  expect(u.restartReason()).toBeUndefined();
  expect(u.signal()).toBeUndefined();
  u.start(undefined, false);
  await until(() => fake.plans.length === 1);
  await until(() => byMachine(u.status()!).get("")!.state === "restarting");
  // The sockets close saying an update restarts the hub.
  expect(u.restartReason()).toBe(`updating to ${NEW}`);
  const last = fake.announced.at(-1)!;
  expect([last.state, last.hub, last.from, last.to]).toEqual(["updating", "restarting", OLD, NEW]);
  expect(updateSummary(last)).toBe(`Updating fleetd to ${NEW}: the hub restarts`);

  // The hub that comes up tells the apps again: its own state isn't the old process's.
  writeFileSync(fake.plans[0]!.verdict, JSON.stringify({ state: "done", stage: null, message: `runs ${NEW}` }));
  fake.version = NEW;
  const after = updatesIn(dir, fake);
  await after.resume();
  const run = after.status()!;
  expect(run.finishedAt).toBeDefined();
  const heard = fake.announced;
  const states = heard.map((d) => [d.state, d.hub, d.machines.map((m) => m.state)]);
  for (let i = 1; i < heard.length; i++) expect(heard[i]).not.toEqual(heard[i - 1]!);
  const done = heard.at(-1)!;
  expect(done).toEqual(signal(run));
  expect([done.state, done.from, done.to, done.finishedAt !== undefined]).toEqual(["updated", OLD, NEW, true]);
  expect(done.machines.map((m) => [m.name, m.state])).toEqual([
    ["builder", "done"],
    ["nas", "skipped"],
  ]);
  expect(updateSummary(done)).toBe(`Updated fleetd to ${NEW}`);
  // The machine is heard restarting once the hub is back.
  expect(states).toContainEqual(["updating", "done", ["restarting", "skipped"]]);
  expect(after.restartReason()).toBeUndefined();
  expect(after.signal()).toEqual(signal(run));
});

test("a finished run reads put back, failed, updated or current; past ten machines the rest are counted", () => {
  const node = (name: string, state: UpdateState, message = "said"): UpdatePart => ({ part: "node", machineId: name, name, from: OLD, state, message });
  const run = (hub: UpdateState, nodes: UpdatePart[]): UpdateRun => ({
    id: "U1",
    channel: "edge",
    to: NEW,
    startedAt: "2026-11-08T10:00:00.000Z",
    finishedAt: "2026-11-08T10:00:05.000Z",
    parts: [{ part: "hub", name: "the hub", from: OLD, state: hub, message: "the new build didn't answer /healthz" }, ...nodes],
    auto: true,
  });
  const putBack = signal(run("rolled_back", []));
  expect([putBack.state, putBack.message]).toEqual(["put_back", "the new build didn't answer /healthz"]);
  expect(updateSummary(putBack)).toBe(`fleetd ${NEW} didn't come up healthy, so ${OLD} was put back`);
  expect(signal(run("failed", [])).state).toBe("failed");
  const updated = signal(run("done", [node("a", "failed")]));
  expect([updated.state, updated.message]).toEqual(["updated", undefined]);
  expect(signal(run("current", [node("a", "done")])).state).toBe("updated");
  const offline = node("b", "skipped", "offline: press Update again once it's online, or run `fleetd update` on it");
  expect(signal(run("current", [node("a", "current"), offline])).state).toBe("current");
  // An update that brought nothing to a machine left behind isn't "already runs it": the hub row says what failed.
  for (const missed of ["failed", "rolled_back", "skipped"] as const) {
    const behind = signal(run("current", [node("a", missed), offline]));
    expect([behind.state, behind.message]).toEqual(["failed", "a: said"]);
  }
  expect(signal(run("current", [node("a", "done"), node("b", "failed")])).state).toBe("updated");
  const going = run("restarting", []);
  delete going.finishedAt;
  expect(signal(going).state).toBe("updating");

  const many = Array.from({ length: 13 }, (_, i) => node(`m${String(i).padStart(2, "0")}`, "restarting"));
  const crowd = signal(run("done", many));
  expect(crowd.machines.length).toBe(HUB_UPDATE_MACHINES_MAX);
  expect(crowd.moreMachines).toBe(3);
  expect(JSON.stringify(crowd).length).toBeLessThan(2048);
  expect(updateSummary({ ...crowd, state: "updating", hub: "done" })).toBe(`Updating fleetd to ${NEW}: 10 machines restart`);
});

/** Automatic updates on, and a finished update to `to` that started `ago` ms before the fake's now. */
function autoAfter(dir: string, fake: Fake, ago: number, to = OLD) {
  require("node:fs").mkdirSync(join(dir, "update"), { recursive: true });
  const at = new Date(fake.now - ago).toISOString();
  const hub = { part: "hub", name: "the hub", from: OLD, state: "current" };
  writeFileSync(join(dir, "update", "run.json"), JSON.stringify({ id: "U0", channel: "edge", to, startedAt: at, finishedAt: at, parts: [hub] }));
  const u = new Updates(join(dir, "update"), { now: () => fake.now }, { ...timing(), autoGap: defaultTiming().autoGap });
  u.setPorts(fake);
  u.setSettings(true, undefined);
  return u;
}

test("two builds within 10 minutes of an update install once, at the window's end, as the newer one", async () => {
  const gap = defaultTiming().autoGap;
  expect(gap).toBe(600_000);
  const dir = join(home.dir, "e");
  const fake = new Fake(dir, []);
  const start = fake.now;
  // A person's update opens the window as an automatic one does.
  const u = autoAfter(dir, fake, 0);
  // The first build, minutes after it.
  fake.now += 3 * 60_000;
  expect(await u.autoTick()).toBeUndefined();
  expect(u.ready()).toBe(NEW);
  const due = u.autoAt()!;
  expect(due).toBe(start + 600_000);
  // The second build replaces it.
  fake.published = [NEWER, new TextEncoder().encode("newer fleetd")];
  expect(await u.autoTick()).toBeUndefined();
  expect(u.ready()).toBe(NEWER);
  expect(u.autoAt()).toBe(due);
  expect(fake.plans).toEqual([]);

  fake.now += 7 * 60_000;
  const run = await u.autoTick();
  expect(run?.auto).toBe(true);
  await until(() => fake.plans.length === 1);
  expect(await u.autoTick()).toBeUndefined();
  expect(fake.plans.map((p) => p.to)).toEqual([NEWER]);
  expect(u.status()!.id).toBe(run!.id);
});

test("a build ready with no update in the last 10 minutes installs at the look that found it, every 2 minutes", async () => {
  expect(defaultTiming().prefetchEvery).toBe(120_000);
  const dir = join(home.dir, "f");
  const fake = new Fake(dir, []);
  const u = autoAfter(dir, fake, 11 * 60_000);
  expect(await u.autoTick()).toBeDefined();
});

test("the look wakes at the window's end for a build due, else every 2 minutes", async () => {
  const sleeps = async (u: Updates) => {
    const stop = new AbortController();
    const slept: number[] = [];
    // The loop's own signal: a fresh Updates over the same home, stopped after its first sleep.
    const v = new Updates(u.dir, { now: () => fake.now }, { ...timing(), prefetchEvery: 120_000, autoGap: 600_000 }, stop.signal);
    v.setPorts(fake);
    v.sleep = async (ms: number) => {
      slept.push(ms);
      stop.abort();
    };
    await v.prefetchLoop();
    return [slept, v.nextCheck()];
  };
  const dir = join(home.dir, "g");
  const fake = new Fake(dir, []);
  // An update 9 minutes ago and a build ready: due a minute from now.
  const u = autoAfter(dir, fake, 9 * 60_000);
  expect(await sleeps(u)).toEqual([[60_000], fake.now + 60_000]);
  // Nothing newer out: the next look, 2 minutes on.
  fake.published = [OLD, new TextEncoder().encode("old fleetd")];
  expect(await sleeps(u)).toEqual([[120_000], fake.now + 120_000]);
});

/** Starts an update to NEW and restarts the hub onto it: the hub that comes up, driving the nodes in the background. */
async function restarted(dir: string, fake: Fake) {
  // Long enough a drain that the tests' waits end by what they change, not by the deadline.
  const u = updatesIn(dir, fake, { drain: 20_000 });
  u.start(undefined, false);
  await until(() => fake.plans.length === 1);
  writeFileSync(fake.plans[0]!.verdict, JSON.stringify({ state: "done", stage: null, message: `runs ${NEW}` }));
  fake.version = NEW;
  const after = updatesIn(dir, fake, { drain: 20_000 });
  const resumed = after.resume();
  return { after, resumed };
}

test("hosted agents mid-step don't hold their node's update", async () => {
  const dir = join(home.dir, "i");
  const fake = new Fake(dir, [{ name: "builder" }]);
  fake.holds = 3;
  fake.hosted.set("m0", [HOSTED, 0]);
  const { after, resumed } = await restarted(dir, fake);
  await resumed;
  const part = byMachine(after.status()!).get("m0")!;
  expect(part.state).toBe("done");
  expect(part.agents).toBeUndefined();
  expect(fake.held).toEqual([]);
});

test("a Navi mid-step or an approved command is waited for, its hosted agents not held", async () => {
  for (const [navi, busy] of [
    [1, undefined],
    [0, "1 approved command"],
  ] as const) {
    const dir = join(home.dir, `j${navi}`);
    const fake = new Fake(dir, [{ name: "builder", ...(busy ? { busy } : {}) }]);
    fake.hosted.set("m0", [HOSTED, navi]);
    const { after, resumed } = await restarted(dir, fake);
    await until(() => byMachine(after.status()!).get("m0")!.installsBy !== undefined);
    const message = byMachine(after.status()!).get("m0")!.message!;
    expect(message.startsWith(busy ? `waits for ${busy}; installs by ` : "waits for 1 agent to finish its step; installs by ")).toBe(true);
    await Bun.sleep(30);
    expect(fake.updated).toEqual([]);
    expect(fake.held).toEqual([]);

    fake.hosted.set("m0", [HOSTED, 0]);
    delete fake.facts[0]!.busy;
    await resumed;
    expect(byMachine(after.status()!).get("m0")!.state).toBe("done");
  }
  expect(busyWords(1, 2, 1)).toBe("1 live session and 2 approved commands and 1 check");
  expect(busyWords(0, 0, 0)).toBeUndefined();
});

test("without scopes, or across a host protocol change, agents are held as before", async () => {
  for (const hosted of [undefined, HOSTED + 1]) {
    const dir = join(home.dir, `k${hosted ?? 0}`);
    const fake = new Fake(dir, [{ name: "builder" }]);
    fake.holds = 2;
    if (hosted !== undefined) fake.hosted.set("m0", [hosted, 0]);
    const { after, resumed } = await restarted(dir, fake);
    await until(() => byMachine(after.status()!).get("m0")!.agents === 2);
    await Bun.sleep(30);
    expect(fake.updated).toEqual([]);
    expect(fake.held.length).toBeGreaterThan(0);
    fake.holds = 0;
    await resumed;
    expect(byMachine(after.status()!).get("m0")!.state).toBe("done");
  }
});

test("a node waits 2 minutes at most by default", () => {
  expect(defaultTiming().drain).toBe(120_000);
  const dir = join(home.dir, "l");
  const u = new Updates(join(dir, "update"), { now: () => 0 }, defaultTiming());
  expect(u.settings().drainMinutes).toBe(2);
});

test("a cloud machine that wakes mid-run catches up as the run ends", async () => {
  const dir = join(home.dir, "m");
  const fake = new Fake(dir, [{ name: "builder" }, { name: "cloud", liveSince: undefined }]);
  // A Navi mid-step on builder keeps the run going for as long as the test says.
  fake.hosted.set("m0", [HOSTED, 1]);
  const { after, resumed } = await restarted(dir, fake);
  await until(() => byMachine(after.status()!).get("m0")!.installsBy !== undefined);
  expect(byMachine(after.status()!).get("m1")!.state).toBe("skipped");

  // The cloud machine wakes and links on its old build.
  fake.facts[1]!.liveSince = 5;
  let caught: string | undefined;
  const catching = after.catchUp("m1").then((c) => (caught = c));
  await Bun.sleep(50);
  // Not ready for work while the run goes on.
  expect(caught).toBeUndefined();
  expect(fake.updated).not.toContain("m1");

  fake.hosted.set("m0", [HOSTED, 0]);
  await catching;
  expect(caught).toBe("restarting");
  expect(after.status()!.finishedAt).toBeDefined();
  expect(fake.updated).toContain("m1");
  await resumed;
});

// boat-2 and boat-3, 9 Nov: Rust cloud machines woke to the Bun hub of the same version, counted as current, and never
// switched. A node on the other flavour is behind whatever its version: its catch-up and the next update send it the
// hub's build, flavour named, and it counts as current only once it runs Bun. A node that names no flavour (older than
// any hub that sends one) is taken at its version.
test("a Rust-reporting node is behind a Bun hub of its version, and told to switch to Bun", async () => {
  const dir = join(home.dir, "flavour");
  const fake = new Fake(dir, [
    { name: "boat-2", version: NEW, flavour: "rust", cloud: true, claude: "2.1.314 (Claude Code)" },
    { name: "boat-3", version: NEW, cloud: true, claude: "2.1.314 (Claude Code)" },
  ]);
  fake.version = NEW;
  const u = updatesIn(dir, fake);
  u.setSettings(true, undefined);
  expect(u.autoAt()).toBe(fake.now);

  expect(await u.catchUp("m0")).toBe("restarting");
  expect(fake.sent).toEqual([{ version: NEW, channel: "stable", flavour: "bun" }]);
  await until(() => fake.facts[0]!.flavour === "bun");
  expect(await u.catchUp("m0")).toBe("current");
  expect(fake.updated).toEqual(["m0"]);
  expect(u.autoAt()).toBeUndefined();

  // No flavour said: current at the hub's version, never asked.
  expect(await u.catchUp("m1")).toBe("current");
  expect(fake.updated).toEqual(["m0"]);
});

// A node from before flavours (every live one when this shipped) ignores the hub's flavour, installs its own flavour of
// the hub's build and comes back naming it. That isn't a failed update put back: the run asks it again, and it switches
// in the same run.
test("a node from before flavours comes back as build_rust and switches to Bun in the same run", async () => {
  const dir = join(home.dir, "before-flavours");
  const fake = new Fake(dir, [{ name: "boat-2" }]);
  fake.ownFlavour.set("m0", "rust");
  const { after, resumed } = await restarted(dir, fake);
  await until(() => after.status()?.finishedAt !== undefined);
  expect(byMachine(after.status()!).get("m0")!.state).toBe("done");
  expect(fake.updated).toEqual(["m0", "m0"]);
  expect(fake.sent.map((u) => u.flavour)).toEqual(["bun", "bun"]);
  expect(fake.facts[0]!.flavour).toBe("bun");
  await resumed;
});

test("versions order within a channel only, and the watcher's health URL reaches the hub", () => {
  expect([versionCmp("1.2.0", "1.10.0"), versionCmp("1.2.0-rc.2", "1.2.0"), versionCmp("0.0.0-edge.202611080900", "0.0.0-nightly.202611071200")]).toEqual([-1, -1, 1]);
  expect(versionCmp("0.0.0-edge.1", "1.0.0")).toBeUndefined();
  expect(versionCmp("0.0.0", "1.0.0")).toBeUndefined();
  expect([atLeast("1.2.0", "1.2.0"), atLeast("1.3.0", "1.2.0"), atLeast("0.0.0", "1.2.0")]).toEqual([true, true, false]);
  expect(["0.0.0.0", "100.104.0.7", "fd00::1", "[fd00::1]", "::", "[::]"].map((h) => healthUrl(h, 4790))).toEqual([
    "http://127.0.0.1:4790",
    "http://100.104.0.7:4790",
    "http://[fd00::1]:4790",
    "http://[fd00::1]:4790",
    "http://[::1]:4790",
    "http://[::1]:4790",
  ]);
});
