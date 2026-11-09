// Ports the core of crates/fleetd/src/hub/pool/tests.rs and boat_tests.rs against a fake boat and fake tunnels: no
// boat.dev, no key of anyone's.
import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Boat, BoatFailure, type Limits, refusal, type Sandbox } from "../src/hub/pool/boat.ts";
import { dayStart, type Fleet, LABEL_ATTEMPT, LABEL_HUB, monthStart, Pool, SILENT_MS } from "../src/hub/pool/index.ts";
import { clamp, LEASE_S, SETUP_S } from "../src/hub/pool/lease.ts";
import { allowed, backoff, budgetLine, INCLUDED_UNKNOWN, preflight } from "../src/hub/pool/starts.ts";
import type { Tunnel, Tunnels } from "../src/hub/pool/tunnel.ts";
import { render, slotScript } from "../src/hub/cloud/setup.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { tempHome } from "./helpers.ts";

const home = tempHome();
afterAll(home.done);

const T = 1_793_786_400_000; // 2026-11-04T10:00:00Z

class FakeBoat implements Boat {
  sandboxes = new Map<string, Sandbox>();
  calls: string[] = [];
  creates: [string, string][] = [];
  refuse: Partial<Record<string, () => never>> = {};
  limitsAnswer: Limits = { canStart: true, nextStartDollars: 0, activeSandboxes: 0, maxActiveSandboxes: 5, machineTypes: [], startLimits: { perMinute: 12, perHour: 60, perDay: 200 }, sandboxPlanDollars: 20 };
  private n = 0;
  private maybe(what: string) {
    this.calls.push(what);
    this.refuse[what]?.();
  }
  async create(key: string, body: Uint8Array) {
    this.maybe("create");
    const b = JSON.parse(new TextDecoder().decode(body)) as { labels: Record<string, string> };
    this.creates.push([key, new TextDecoder().decode(body)]);
    const sb: Sandbox = { id: `bx_${++this.n}`, state: "provisioning", labels: b.labels };
    this.sandboxes.set(sb.id, sb);
    return sb;
  }
  async get(id: string) {
    this.maybe("get");
    const sb = this.sandboxes.get(id);
    if (!sb) throw new BoatFailure({ kind: "not_found" });
    return { ...sb };
  }
  async list(labels: [string, string][]) {
    this.maybe("list");
    return [...this.sandboxes.values()].filter((sb) => labels.every(([k, v]) => sb.labels[k] === v));
  }
  async setTtl(id: string) {
    this.maybe(`ttl ${id}`);
  }
  async stop(id: string) {
    this.maybe(`stop ${id}`);
    const sb = this.sandboxes.get(id);
    if (sb) sb.state = "archived";
  }
  async resume(id: string) {
    this.maybe(`resume ${id}`);
    const sb = this.sandboxes.get(id)!;
    sb.state = "running";
    return { ...sb };
  }
  async delete(id: string) {
    this.maybe(`delete ${id}`);
    this.sandboxes.delete(id);
  }
  async limits() {
    this.maybe("limits");
    return this.limitsAnswer;
  }
  async sshKey() {
    return {};
  }
  async usage() {
    return 0;
  }
}

class FakeTunnels implements Tunnels {
  open_ = new Map<string, string>();
  open(slot: string, sandbox: string) {
    this.open_.set(slot, sandbox);
  }
  close(slot: string) {
    this.open_.delete(slot);
  }
  status(slot: string): Tunnel | undefined {
    return this.open_.has(slot) ? { up: true } : undefined;
  }
}

function lab() {
  let now = T;
  const boat = new FakeBoat();
  const tunnels = new FakeTunnels();
  const seen = new Map<string, number>();
  const busy = new Map<string, boolean>();
  const fleet: Fleet = {
    lastSeen: (m) => seen.get(m),
    busy: (m) => busy.get(m),
    ready: () => true,
    othersHeard: () => true,
  };
  const db = HubDb.memory();
  const pool = new Pool(db, home.dir, boat, tunnels, fleet, { now: () => now }, "UTC");
  pool.setKey("boat_test_key");
  pool.apply({ enabled: true, poolSize: 2, machineType: "large", dayBudget: 3, projects: [], environment: "fleetd-devbox" });
  return { pool, boat, tunnels, seen, busy, tick: (ms: number) => (now += ms), now: () => now };
}

const spec = (now: number) => ({ setupScript: "echo hi", files: [{ path: "/tmp/fleetd-enroll-token", content: "enroll" }], bodyUntil: now + 15 * 60_000 });

test("the lease is a number of seconds, at most 30 minutes, cut to the budget, and a stop at a minute or less", () => {
  expect(clamp(LEASE_S, 3, 0.216)).toMatchObject({ renew: { seconds: LEASE_S } });
  const cut = clamp(LEASE_S, 0.018, 0.216);
  expect("renew" in cut && cut.renew.seconds >= 299 && cut.renew.seconds <= 300).toBe(true);
  expect(clamp(LEASE_S, 0.0012, 0.072)).toEqual({ stop: true });
  expect(clamp(LEASE_S, Number.NaN, 0.072)).toEqual({ stop: true });
  expect(clamp(LEASE_S, 3, Number.NaN)).toEqual({ stop: true });
  expect(clamp(4_294_967_295, 1e9, 0.072)).toMatchObject({ renew: { seconds: SETUP_S } });
});

test("starts: half of each window, a pre-flight that never buys a start, and each code's backoff", () => {
  expect([allowed(INCLUDED_UNKNOWN, "minute"), allowed(INCLUDED_UNKNOWN, "hour"), allowed(INCLUDED_UNKNOWN, "day")]).toEqual([6, 30, 100]);
  expect(budgetLine(INCLUDED_UNKNOWN, [["minute", 2, T], ["hour", 30, T - 1_800_000], ["day", 40, T - 3_600_000]], "UTC")).toBe(
    "fleetd's boat.dev start budget is used (30 of 30 this hour): next start at 10:30",
  );
  const l = { canStart: true, nextStartDollars: 0, activeSandboxes: 0, maxActiveSandboxes: 1, machineTypes: [] };
  expect(preflight(l)).toBeUndefined();
  expect(preflight({ ...l, nextStartDollars: 0.03 })).toContain("never buys");
  expect(preflight({ ...l, canStart: false, startBlockedReason: "billing_required" })).toBe("boat.dev: billing_required");
  expect(backoff({ kind: "rate_limited", nextStartAt: T + 32 * 60_000 }, 0, T, 0.5, "UTC")).toEqual({ hold: true, until: T + 32 * 60_000, step: 1, reason: "boat.dev start limit: next start at 10:32" });
  expect(backoff({ kind: "limit_reached" }, 0, T, 0.5, "UTC")).toEqual({ full: true });
  expect(backoff({ kind: "key_refused", code: "api_key_expired" }, 0, T, 0.5, "UTC")).toMatchObject({ pause: "key" });
  expect(backoff({ kind: "network", message: "x" }, 2, T, 0.5, "UTC")).toMatchObject({ until: T + 20_000 });
  expect(backoff({ kind: "unknown_environment", name: "x" }, 0, T, 0.5, "UTC")).toMatchObject({ pause: "refused" });
});

test("boat's refusals read as their codes", () => {
  expect(refusal(429, { code: "rate_limited", nextStartAt: "2026-11-04T10:32:00Z" })).toEqual({ kind: "rate_limited", nextStartAt: T + 32 * 60_000 });
  expect(refusal(402, { error: { code: "billing_required", details: { billingUrl: "https://boat.dev/b" } } })).toEqual({ kind: "billing", code: "billing_required", url: "https://boat.dev/b" });
  expect(refusal(503, { code: "out_of_capacity" }, 7)).toEqual({ kind: "out_of_capacity", retryAfterS: 7 });
  expect(refusal(403, { code: "api_key_expired" })).toEqual({ kind: "key_refused", code: "api_key_expired" });
  expect(refusal(401, {})).toEqual({ kind: "key_refused", code: "unauthorized" });
  expect(refusal(409, { code: "snapshot_data_expired" })).toEqual({ kind: "data_expired" });
  expect(refusal(502, null)).toEqual({ kind: "server", status: 502 });
});

test("a create writes its row, start and meter before boat's call, and holds its machine to the lease", async () => {
  const { pool, boat, tunnels, now } = lab();
  await pool.create("boat-1", spec(now()));
  const row = pool.ledger.slot("boat-1")!;
  expect([row.state, row.sandboxId, row.createBody]).toEqual(["creating", "bx_1", undefined]);
  expect(row.leaseUntil).toBe(now() + SETUP_S * 1000);
  const [key, body] = boat.creates[0]!;
  const sent = JSON.parse(body) as Record<string, unknown>;
  expect(sent).toMatchObject({ type: "large", ttlSeconds: SETUP_S, noEnv: true, monitoring: false, failFast: true, environment: "fleetd-devbox", setupScript: "echo hi" });
  expect((sent.labels as Record<string, string>)[LABEL_ATTEMPT]).toBe(key);
  expect(pool.ledger.startsIn("day", now())[0]).toBe(1);
  expect(tunnels.open_.get("boat-1")).toBe("bx_1");
  // A refused create fails its slot, and the start it never was is uncounted.
  boat.refuse.create = () => {
    throw new BoatFailure({ kind: "unknown_environment", name: "" });
  };
  await expect(pool.create("boat-2", spec(now()))).rejects.toThrow("no environment named fleetd-devbox");
  expect(pool.ledger.slot("boat-2")).toMatchObject({ state: "failed" });
  expect(pool.ledger.startsIn("day", now())[0]).toBe(1);
});

test("hello makes it awake; idle for 15 minutes stops it, and a wake resumes only what boat says stopped", async () => {
  const { pool, boat, seen, busy, tick, now } = lab();
  await pool.create("boat-1", spec(now()));
  seen.set("boat-1", now() + 1);
  tick(5_000);
  await pool.tick();
  expect(pool.ledger.slot("boat-1")!.state).toBe("awake");
  busy.set("boat-1", false);
  await pool.tick();
  tick(15 * 60_000);
  await pool.tick();
  expect(boat.calls).toContain("stop bx_1");
  await pool.tick();
  expect(pool.ledger.slot("boat-1")!.state).toBe("asleep");
  await pool.wake("boat-1", "need");
  expect(boat.calls.slice(-1)).toEqual(["resume bx_1"]);
  expect(pool.ledger.slot("boat-1")!.state).toBe("waking");
  // No hello within 2 minutes: stopped, and the second such wake makes it broken.
  tick(3 * 60_000);
  await pool.tick();
  expect(pool.ledger.slot("boat-1")).toMatchObject({ state: "stopping", wakeFailures: 1 });
});

test("the sweep adopts a lost create, stops and deletes an orphan, and leaves another hub's machines alone", async () => {
  const { pool, boat, now } = lab();
  boat.refuse.create = () => {
    throw new BoatFailure({ kind: "network", message: "reset" });
  };
  await expect(pool.create("boat-1", spec(now()))).rejects.toThrow("unreachable");
  const row = pool.ledger.slot("boat-1")!;
  expect([row.state, row.sandboxId]).toEqual(["creating", undefined]);
  const hubId = pool.ledger.settings().hubId;
  boat.sandboxes.set("bx_lost", { id: "bx_lost", state: "running", labels: { [LABEL_HUB]: hubId, [LABEL_ATTEMPT]: row.idemKey! } });
  boat.sandboxes.set("bx_orphan", { id: "bx_orphan", state: "running", labels: { [LABEL_HUB]: hubId } });
  boat.sandboxes.set("bx_other", { id: "bx_other", state: "running", labels: { [LABEL_HUB]: "another-hub" } });
  await pool.sweep();
  expect(pool.ledger.slot("boat-1")!.sandboxId).toBe("bx_lost");
  expect(boat.calls).toContain("stop bx_orphan");
  expect(boat.calls.some((c) => c.includes("bx_other"))).toBe(false);
  expect(pool.ready()).toBe(true);
  await pool.sweep();
  expect(boat.calls).toContain("delete bx_orphan");
});

test("the kill switch turns the pool off and stops every machine boat lists for this hub", async () => {
  const { pool, boat, now } = lab();
  await pool.create("boat-1", spec(now()));
  const hubId = pool.ledger.settings().hubId;
  boat.sandboxes.set("bx_unknown", { id: "bx_unknown", state: "running", labels: { [LABEL_HUB]: hubId } });
  for (const sb of boat.sandboxes.values()) sb.state = "running";
  const kill = await pool.kill();
  expect(kill.stopped.sort()).toEqual(["boat-1", "bx_unknown"]);
  expect(pool.ledger.settings().enabled).toBe(false);
  expect(pool.startHeld()).toBe("cloud machines are off");
});

test("a node silent for 10 minutes while others are heard is stopped; the day and month start in the hub's zone", async () => {
  const { pool, boat, seen, tick, now } = lab();
  await pool.create("boat-1", spec(now()));
  seen.set("boat-1", now() + 1);
  tick(1000);
  await pool.tick();
  tick(SILENT_MS + 60_000);
  await pool.tick();
  expect(boat.calls).toContain("stop bx_1");
  expect(pool.ledger.slot("boat-1")!.note).toBe("its node went silent for 10 minutes");
  expect(dayStart(T, "UTC")).toBe(Date.parse("2026-11-04T00:00:00Z"));
  expect(monthStart(T, "UTC")).toBe(Date.parse("2026-11-01T00:00:00Z"));
  expect(dayStart(T, "America/New_York")).toBe(Date.parse("2026-11-04T05:00:00Z"));
});

test("the cloud tools: the key sealed to the hub, settings checked, and the kill switch, for admins only", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { Registry } = await import("../src/hub/api/registry.ts");
  const { registerAll } = await import("../src/gen/areas.ts");
  const { loadOrCreateBoxKey, publicKeyOf, seal } = await import("../src/shared/sealed_box.ts");
  const dir = `${home.dir}/hub-tools`;
  const db = HubDb.memory();
  const hub = new Hub({ home: dir, listen: { host: "127.0.0.1", port: 4795 } }, db, { now: () => T });
  const boat = new FakeBoat();
  const fleet: Fleet = { lastSeen: () => undefined, busy: () => undefined, ready: () => true, othersHeard: () => true };
  hub.area("pool", (h) => new Pool(h.db, dir, boat, new FakeTunnels(), fleet, h.clock, "UTC"));
  const tools = new Registry();
  registerAll(tools);
  const admin = { keyId: "k", name: "desk", prefix: "fld_x", grants: [{ role: "admin" as const, machines: "*" as const }], createdAt: "x", kind: "human" as const };
  const reader = { ...admin, grants: [{ role: "operate" as const, machines: "*" as const }] };
  const call = async (caller: import("../src/hub/api/registry.ts").Caller, tool: string, input: unknown) => {
    const r = await tools.call(hub, caller, tool, input);
    if ("error" in r) throw r.error.kind === "tool" ? r.error.error : new Error(r.error.kind);
    return r.output as Record<string, unknown>;
  };
  const got = (await call(reader, "cloud_get", {})).cloud as Record<string, unknown>;
  expect([got.hasKey, got.enabled, got.environmentDefault]).toEqual([false, false, "fleetd-hub"]);
  await expect(call(reader, "cloud_stop", {})).rejects.toMatchObject({ code: "forbidden" });
  await expect(call(admin, "cloud_set", { enabled: true, poolSize: 2, machineType: "large", dayBudget: 3 })).rejects.toMatchObject({
    message: "Cloud machines need a boat.dev key first.",
  });
  const box = publicKeyOf(loadOrCreateBoxKey(dir));
  const sealed = (text: string) => Buffer.from(seal(box, new TextEncoder().encode(text))).toString("base64");
  await expect(call(admin, "cloud_key_set", { sealed: sealed("not-a-boat-key") })).rejects.toMatchObject({ message: "That isn't a boat.dev API key." });
  const set = (await call(admin, "cloud_key_set", { sealed: sealed("boat_abc123") })).cloud as Record<string, unknown>;
  expect(set.hasKey).toBe(true);
  expect(String(set.sshKey)).toMatch(/^ssh-ed25519 \S+ fleetd-hub$/);
  expect(JSON.stringify(db.all("SELECT * FROM pool_settings"))).not.toContain("boat_abc123");
  await expect(call(admin, "cloud_set", { enabled: true, poolSize: 11, machineType: "large", dayBudget: 3 })).rejects.toMatchObject({ message: "A pool holds 1 to 10 machines." });
  const on = (await call(admin, "cloud_set", { enabled: true, poolSize: 1, machineType: "large", dayBudget: 3, environment: "fleetd-devbox" })).cloud as Record<string, unknown>;
  expect([on.enabled, on.poolSize, on.environment]).toEqual([true, 1, "fleetd-devbox"]);
  const test = await call(admin, "cloud_test", {});
  expect(test.test).toEqual({ ok: true, said: "Key works · $20 plan · 200 starts a day (12 a minute) · 0 of 5 machines running" });
  // Test went the whole way: with no machine yet, it created boat-1, which the kill switch then stops.
  expect(boat.creates.length).toBe(1);
  const stopped = await call(admin, "cloud_stop", {});
  expect(stopped).toEqual({ stopped: ["boat-1"], failed: [] });
});

test("the setup script joins the hub through its tunnel on its channel, with every value quoted", () => {
  const slot = { hubUrl: "http://127.0.0.1:47900", machineId: "boat-2", version: "0.4.0", releaseBuild: true, gitIdentity: "Dev Box <dev@example.net>", claude: "2.1.314" };
  const lines = render(slot).split("\n");
  for (const line of [
    "HUB=http://127.0.0.1:47900",
    "MACHINE=boat-2",
    "CHANNEL=stable",
    // A Bun hub's machines install the Bun build.
    "FLAVOUR=bun",
    "BASE_URL=https://github.com/unlaboredlabs/fleetd/releases/download/v0.4.0",
    "IDENTITY='Dev Box <dev@example.net>'",
    "TOKEN_FILE=/tmp/fleetd-enroll-token",
    "AGENT=fleetd",
    "CLAUDE=2.1.314",
  ]) {
    expect(lines).toContain(line);
  }
  expect(render(slot)).not.toContain("=@");
  // An edge hub: the newest edge build, nothing pinned; no identity is an empty value.
  const { gitIdentity: _, ...noIdentity } = slot;
  const edge = render({ ...noIdentity, version: "0.0.0-edge.202611031200+aeb0b7f" }).split("\n");
  expect(edge).toContain("CHANNEL=edge");
  expect(edge).toContain("BASE_URL=''");
  expect(edge).toContain("IDENTITY=''");
});

test("a slot's script carries the git identity the hub's setup.json holds", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home.dir, "setup.json"), JSON.stringify({ listen: "127.0.0.1:4790", url: "http://devbox.example:4790", machines: {} }));
    expect(slotScript(home.dir, "boat-1", "0.4.0", true, "2.1.314").split("\n")).toContain("IDENTITY=''");
    writeFileSync(
      join(home.dir, "setup.json"),
      JSON.stringify({ listen: "127.0.0.1:4790", url: "http://devbox.example:4790", gitIdentity: { name: "ada-lovelace", email: "1+ada-lovelace@users.noreply.github.com" }, machines: {} }),
    );
    expect(slotScript(home.dir, "boat-1", "0.4.0", true, "2.1.314").split("\n")).toContain(
      "IDENTITY='ada-lovelace <1+ada-lovelace@users.noreply.github.com>'",
    );
  } finally {
    home.done();
  }
});

test("the pool's start fills the tasks area's cloud hooks: the room, a wake for work, and a claim", async () => {
  const { Hub } = await import("../src/hub/api/hub.ts");
  const { start, taskRoom } = await import("../src/hub/pool/loops.ts");
  const { NO_ROOM, taskHooks } = await import("../src/hub/tasks/ports.ts");
  const dir = `${home.dir}/hub-hooks`;
  let now = T;
  const hub = new Hub({ home: dir, listen: { host: "127.0.0.1", port: 4796 } }, HubDb.memory(), { now: () => now });
  const boat = new FakeBoat();
  const seen = new Map<string, number>();
  const fleet: Fleet = { lastSeen: (m) => seen.get(m), busy: () => undefined, ready: () => true, othersHeard: () => true };
  const pool = hub.area("pool", (h) => new Pool(h.db, dir, boat, new FakeTunnels(), fleet, h.clock, "UTC"));
  // No loop: only the hooks.
  hub.shutdown.abort();
  expect(taskHooks(hub).pool).toBeUndefined();
  start(hub);
  const hooks = taskHooks(hub).pool!;
  const project = { machineId: "lab-a", projectId: "shop" };
  const task = { projectRef: project } as never;

  // Off: no room and nothing to say, as before the pool filled the hooks.
  expect(hooks.room(task, project)).toEqual(NO_ROOM);
  expect(hooks.wake(undefined)).toEqual({ why: "the cloud machines are busy (0 of 0 awake)" });
  expect(hooks.claim("boat-1")).toBe(false);

  pool.setKey("boat_test_key");
  pool.apply({ enabled: true, poolSize: 1, machineType: "large", dayBudget: 3, projects: [project], environment: "fleetd-devbox" });
  // On, before the hub's first check of boat.dev: eligible, and closed for now.
  expect(hooks.room(task, project)).toEqual({ eligible: true, awake: [], warm: 0, closed: "cloud machines wait for the hub's first check of boat.dev" });
  pool.setReady();
  await pool.create("boat-1", spec(now));
  // The one being created is the one coming; one that isn't a slot says so.
  expect(hooks.wake(undefined)).toEqual({ machine: "boat-1" });
  expect(hooks.wake("boat-9")).toEqual({ why: "boat-9 is no longer a cloud machine" });
  // Not awake yet: no claim on it.
  expect(hooks.claim("boat-1")).toBe(false);
  // Its node says hello: awake, and claimed for a launch.
  seen.set("boat-1", now + 1);
  now += 5_000;
  await pool.tick();
  expect(pool.ledger.slot("boat-1")!.state).toBe("awake");
  expect(hooks.claim("boat-1")).toBe(true);
  expect(hooks.wake("boat-1")).toEqual({ machine: "boat-1" });
  expect(taskRoom({ eligible: { no: "not for cloud: its project's secret variables are only on its own machine" }, awake: [], warm: 0 })).toEqual({
    eligible: { why: "not for cloud: its project's secret variables are only on its own machine" },
    awake: [],
    warm: 0,
  });
});
