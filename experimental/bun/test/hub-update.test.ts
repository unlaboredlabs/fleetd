// Ports the core of crates/fleetd/src/hub/update/tests.rs against fake ports: a fake release feed, fake nodes, no
// service manager and no release server.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { byMachine, defaultTiming, lastAutoOf, type NodeActionResult, type NodeFacts, type UpdatePorts, Updates } from "../src/hub/update/index.ts";
import { healthUrl } from "../src/hub/update/ports.ts";
import { sha256Hex } from "../src/update/index.ts";
import type { Plan } from "../src/update/finish.ts";
import { atLeast, versionCmp } from "../src/update/version.ts";
import { tempHome } from "./helpers.ts";

const home = tempHome();
afterAll(home.done);

const NEW = "1.2.0";
const OLD = "1.1.0";
const build = new TextEncoder().encode("new fleetd");

/** A hub on OLD, its channel on NEW, and nodes that come back on what they're told to run. */
class Fake implements UpdatePorts {
  now = 1_000_000;
  version = OLD;
  plans: Plan[] = [];
  updated: string[] = [];
  fetched: string[] = [];
  claude: string[] = [];
  holds = 0;
  facts: NodeFacts[];
  waiters: (() => void)[] = [];
  answer: (m: string) => NodeActionResult = () => ({ ok: true, message: "in place" });
  exePath: string;

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
    return {
      get: async (name: string) =>
        new TextEncoder().encode(
          name === "release.json" ? JSON.stringify({ cliVersion: NEW }) : name === "SHA256SUMS" ? `${sha256Hex(build)}  fleetd-linux-x64\n` : "",
        ),
      stream: async (name: string, sink: (c: Uint8Array) => void) => sink(name === "fleetd-linux-x64" ? build : new Uint8Array()),
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
  async holdNode() {
    return this.holds;
  }
  nodeChanged() {
    return new Promise<void>((r) => this.waiters.push(r));
  }
  claudeTarget = () => "2.1.314";
  async installClaude(m: string, v: string) {
    this.claude.push(`${m}@${v}`);
    return { ok: true, message: `Claude Code ${v} installed` };
  }
  async updateNode(m: string, update: { version: string }) {
    this.updated.push(m);
    const answer = this.answer(m);
    if (answer.ok) {
      // It restarts and links again on the new build.
      setTimeout(() => {
        const f = this.facts.find((x) => x.machineId === m)!;
        f.version = update.version;
        f.liveSince = this.now + 1;
        this.now += 2;
        for (const w of this.waiters.splice(0)) w();
      }, 1);
    }
    return [answer, { tryTake: () => undefined }] as [NodeActionResult, { tryTake(): NodeActionResult | undefined }];
  }
}

const timing = () => ({ ...defaultTiming(), poll: 1, nodePoll: 5, verdict: 50, nodeBack: 200, restart: 30, drainPoll: 1, drain: 50, prefetchEvery: 1000 });

function updatesIn(dir: string, fake: Fake) {
  const u = new Updates(join(dir, "update"), { now: () => fake.now }, timing());
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
