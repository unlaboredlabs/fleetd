// The team's own hosted sandbox accounts (hub/sandbox, node/sandbox): each provider's key connected through a sealed
// value, tested on a machine of the team's and removed, never shown; a removed provider refused; the limit; the order; the limits and
// keys a node keeps (each key sealed to that node), the providers it reports it can place, and the slot board's
// limits. A stand-in provider client answers:
// nothing reaches a provider. The clients themselves are tested against stand-in servers (sandbox/providers).
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { boxKey } from "../src/hub/hub_links/store.ts";
import { start as startSandboxLoops } from "../src/hub/sandbox/loops.ts";
import { sandboxProviders } from "../src/hub/doctor/checks.ts";
import { guides, read as readSteps } from "../src/hub/setup/index.ts";
import { NodeBoxKey } from "../src/node/identity.ts";
import { Sandboxes } from "../src/node/sandbox/hosted.ts";
import { provider, ProviderError, type ProviderAuth, type ProviderId } from "../src/sandbox/providers/index.ts";
import { boatStandIn, KEY as STANDIN_KEY } from "./sandbox/stand_ins.ts";
import { Boxes } from "../src/node/sandbox/remote/boxes.ts";
import { slots } from "../src/hub/slots/index.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NodeAction, NodeLoad } from "../src/shared/node_link.ts";
import { RUNNER_ID } from "../src/shared/sandbox.ts";
import { addMachine, addProject, caller, testHub } from "./screens_helpers.ts";

let t: ReturnType<typeof testHub>;
const admin = caller("admin", { kind: "human", name: "ana" });
const member = caller("read", { kind: "human", name: "ben" });
const GOOD = "boat_good_key_0123456789";
const BAD = "boat_bad_key_0123456789";

beforeEach(() => {
  t = testHub();
  startSandboxLoops(t.hub);
});
afterEach(() => t?.done());

const sealed = (key: string) => Buffer.from(seal(publicKeyOf(boxKey(t.hub)), new TextEncoder().encode(JSON.stringify({ key })))).toString("base64");

async function call(who: typeof admin, tool: string, input: Record<string, unknown> = {}): Promise<any> {
  const r = await t.tools.call(t.hub, who, tool, input);
  if ("output" in r) return r.output;
  throw new Error(r.error.kind === "tool" ? r.error.error.message : r.error.kind);
}

/** What the stand-in client was asked: provider, key and domain, per list. */
let asked: { id: ProviderId; auth: ProviderAuth }[] = [];
/** A stand-in for the provider clients: GOOD lists, BAD is refused, anything else is unreachable. */
const standIn = (id: ProviderId, auth: ProviderAuth) => ({
  list: async () => {
    asked.push({ id, auth });
    if (auth.key === GOOD) return [{ id: "sbx1", labels: { fleetd: "1" } }];
    if (auth.key === BAD) throw new ProviderError("invalid_key", `${id} refused the key ${auth.key}`);
    throw new ProviderError("unreachable", "connection refused");
  },
});

/** A Linux machine of the team's whose node answers as node/sandbox does, with `lister` for the provider's client. */
const nodes = new Map<string, Sandboxes>();
const homes = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-sandbox-settings-"));
afterAll(() => rmSync(homes, { recursive: true, force: true }));
function machine(id: string, lister: ConstructorParameters<typeof Sandboxes>[1] = standIn) {
  const box = new NodeBoxKey(crypto.getRandomValues(new Uint8Array(32)));
  addMachine(t.hub, id, { boxPubKey: box.publicKey() });
  nodes.set(id, new Sandboxes(box, lister, new Boxes(mkdtempSync(join(homes, `${id}-`)), id, box)));
  t.link.link(id, ["sandbox"]);
}
beforeEach(() => {
  asked = [];
  nodes.clear();
  t.link.answer = async (id, frame) => {
    const n = nodes.get(id);
    if (!n) throw new Error(`${id}'s node is not linked to the hub`);
    const f = frame as unknown as NodeAction;
    return f.action === "sandbox_limits" ? n.setLimits(f) : n.check(f);
  };
});

test("connect: the key is kept sealed, checked at once on a machine of the team's, and never comes back", async () => {
  machine("devbox");
  const before = await call(member, "sandbox_get");
  expect(before).toEqual({ boxPubKey: Buffer.from(publicKeyOf(boxKey(t.hub))).toString("base64"), placing: true, providers: [
    { provider: "boat", connected: false, limit: 0 },
  ], linux: "ours_first" });
  await expect(call(member, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD) })).rejects.toThrow();
  const on = await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD) });
  expect(on.providers[0]).toEqual({ provider: "boat", connected: true, limit: 5, check: { at: expect.any(String), ok: true }, running: 0 });
  expect(asked).toEqual([{ id: "boat", auth: { key: GOOD } }]);
  const stored = t.hub.db.conn.query<{ sealed: Uint8Array }, []>("SELECT sealed FROM sandbox_providers").get()!;
  expect(Buffer.from(stored.sealed).includes(Buffer.from(GOOD))).toBe(false);
  expect(JSON.stringify(on)).not.toContain(GOOD);
  expect(JSON.stringify(await call(member, "sandbox_get"))).not.toContain(GOOD);
});

test("a refused key says why, masked, with what fixes it; one nothing can test says so", async () => {
  machine("devbox");
  const bad = await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(BAD), limit: 3 });
  const d = bad.providers[0];
  expect(d).toMatchObject({ provider: "boat", connected: true, limit: 3, check: { ok: false, reason: "invalid_key" } });
  // No machine's name and no status code: the line is the provider's, whichever machine ran the test.
  expect(d.check.message).toBe("boat.dev refused the key.");
  expect(d.check.fix).toBe("make a new key in boat.dev's dashboard and connect it again");
  expect(JSON.stringify(bad)).not.toContain(BAD);
  t.link.unlink("devbox");
  const none = await call(admin, "sandbox_test", { provider: "boat" });
  // With no machine, the hub's own runner tests it: here it never came up. One plain reason and Try again; the log
  // keeps the rest.
  expect(none.providers[0].check).toMatchObject({ ok: false, reason: "failed", message: "The key couldn't be tested just now.", fix: "try again in a minute" });
});

test("a removed provider is refused saying why; a limit is 0 to 500; set and disconnect", async () => {
  machine("devbox");
  await expect(call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD) })).rejects.toThrow("E2B was removed from fleetd: its boxes have no KVM");
  await expect(call(admin, "sandbox_connect", { provider: "daytona", sealed: sealed(GOOD) })).rejects.toThrow("Daytona was removed from fleetd: its boxes can't open /dev/kvm");
  await expect(call(admin, "sandbox_connect", { provider: "modal", sealed: sealed(GOOD) })).rejects.toThrow();
  await expect(call(admin, "sandbox_set", { provider: "boat", limit: 2 })).rejects.toThrow("No boat.dev key is connected");
  const on = await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD) });
  expect(on.providers[0]).toMatchObject({ limit: 5 });
  await expect(call(admin, "sandbox_set", { provider: "boat", limit: 501 })).rejects.toThrow();
  expect((await call(admin, "sandbox_set", { provider: "boat", limit: 20 })).providers[0].limit).toBe(20);
  // A key connected again keeps the limit set.
  expect((await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD) })).providers[0]).toMatchObject({ limit: 20 });
  const off = await call(admin, "sandbox_disconnect", { provider: "boat" });
  expect(off.providers[0]).toEqual({ provider: "boat", connected: false, limit: 0 });
});

test("the Linux machine: machines first until set, a provider only or machines only, refused for anything else, by an admin", async () => {
  expect((await call(member, "sandbox_get")).linux).toBe("ours_first");
  await expect(call(member, "sandbox_where_set", { linux: "boat" })).rejects.toThrow();
  await expect(call(admin, "sandbox_where_set", { linux: "e2b" })).rejects.toThrow("linux is ours_first, ours_only or a provider (boat), not e2b.");
  expect((await call(admin, "sandbox_where_set", { linux: "boat" })).linux).toBe("boat");
  expect((await call(member, "sandbox_get")).linux).toBe("boat");
  expect((await call(admin, "sandbox_where_set", { linux: "ours_only" })).linux).toBe("ours_only");
});

test("a provider its runner set aside reaches the row with its reason and fix, and a queued agent's reason says the same", async () => {
  machine(RUNNER_ID);
  await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD), limit: 20 });
  const runnerLoad = (extra: Partial<NodeLoad>): NodeLoad => ({ cpus: 4, load1: 0, ...extra });
  // Three boxes run: the row's "3 of 20 running".
  slots(t.hub).observeMachine(RUNNER_ID, "Hosted sandboxes", runnerLoad({ sandboxes: ["boat"], places: { a: "boat", b: "boat", c: "boat" } }));
  expect((await call(member, "sandbox_get")).providers[0]).toMatchObject({ provider: "boat", connected: true, limit: 20, running: 3, check: { ok: true } });
  expect((await call(member, "sandbox_get")).providers[0].trouble).toBeUndefined();
  // boat.dev refused a box for billing (the stand-in's 402, as hosted_place.test.ts drives it): the runner's heartbeat
  // says so and offers boat.dev no more. On main the row stayed green and the agent read "the hosted sandbox providers
  // aren't ready on the hub yet".
  const until = t.hub.clock.now() + 10 * 60_000;
  const why = "boat won't run sandboxes on this account until its billing is sorted out (402 Payment required).";
  slots(t.hub).observeMachine(RUNNER_ID, "Hosted sandboxes", runnerLoad({ sandboxTrouble: [{ provider: "boat", what: "start", reason: "billing", why, until }] }));
  const row = (await call(member, "sandbox_get")).providers[0];
  expect(row.trouble).toEqual({
    what: "start",
    reason: "billing",
    message: "boat.dev refused: billing isn't set up on the account",
    fix: "set up billing in boat.dev's dashboard",
    until: new Date(until).toISOString(),
  });
  expect(JSON.stringify(row)).not.toContain("402");
  addProject(t.hub, RUNNER_ID, "bot1");
  const grant = slots(t.hub).acquire({ holder: "T1", projectRef: { machineId: RUNNER_ID, projectId: "bot1" }, priority: "work", hostable: true });
  expect(grant).toEqual({ granted: false, reason: `boat.dev refused: billing isn't set up on the account (set up billing in boat.dev's dashboard); trying again at ${new Date(until).toISOString().slice(11, 16)}` });
  // Back: the heartbeat offers boat.dev again and says nothing is wrong; the row is clear and the agent starts.
  slots(t.hub).observeMachine(RUNNER_ID, "Hosted sandboxes", runnerLoad({ sandboxes: ["boat"] }));
  expect((await call(member, "sandbox_get")).providers[0].trouble).toBeUndefined();
  expect(slots(t.hub).placeOf("T1")).toBe("boat");
});

test("limits and keys reach the team's machines in the fixed order, at each change and as one links, and the slot board", async () => {
  machine("devbox");
  await call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD), limit: 4 });
  const until = async (ok: () => boolean) => {
    for (let i = 0; !ok() && i < 200; i++) await Bun.sleep(5);
  };
  const node = nodes.get("devbox")!;
  await until(() => node.placeable().length === 1);
  expect(node.limits).toEqual([{ provider: "boat", max: 4 }]);
  // The node holds the key, sealed to it, and says it can place agents there.
  expect(node.placeable()).toEqual(["boat"]);
  expect(slots(t.hub).placeOf("nobody")).toBeUndefined();
  // A node that links later gets them as it links.
  machine("box2");
  await until(() => nodes.get("box2")!.placeable().length === 1);
  expect(nodes.get("box2")!.limits).toEqual([{ provider: "boat", max: 4 }]);
  await call(admin, "sandbox_disconnect", { provider: "boat" });
  await until(() => nodes.get("box2")!.placeable().length === 0);
  expect(nodes.get("box2")!.placeable()).toEqual([]);
});

const STAND_INS = { boat: boatStandIn } as const;
for (const id of ["boat"] as const) {
  test(`Test reaches ${id}'s stand-in server through the real client: its key works, a wrong one is refused`, async () => {
    const server = STAND_INS[id]();
    try {
      const api = `${server.url}/api/v1`;
      // The node's own client, only pointed at the stand-in server.
      machine("devbox", (p, auth, o) => provider(p, auth, { ...o, urls: { api } }));
      const on = await call(admin, "sandbox_connect", { provider: id, sealed: sealed(STANDIN_KEY) });
      expect(on.providers.find((p: { provider: string }) => p.provider === id).check).toEqual({ at: expect.any(String), ok: true });
      expect(server.calls.length).toBeGreaterThan(0);
      expect(server.boxes.size).toBe(0);
      const wrong = "wrong-key-987654321";
      const off = await call(admin, "sandbox_connect", { provider: id, sealed: sealed(wrong) });
      const check = off.providers.find((p: { provider: string }) => p.provider === id).check;
      expect(check).toMatchObject({ ok: false, reason: "invalid_key", message: "boat.dev refused the key." });
      expect(JSON.stringify(off)).not.toContain(wrong);
    } finally {
      server.stop();
    }
  });
}

test("where agents run is one setup step, a computer or hosted sandboxes; the providers' check: absent with none connected, ok, untested, failing", () => {
  const all = guides("http://devbox:4790");
  expect(all.find((s) => s.id === "sandboxes")).toBeUndefined();
  const step = all.find((s) => s.id === "machines")!;
  expect(step).toMatchObject({
    title: "Where agents run",
    need: { kind: "required" },
    ways: [
      { label: "a computer", checks: ["*/online"] },
      { label: "hosted sandboxes", checks: ["hub/sandboxes"] },
    ],
  });
  // Either one is enough: no computer, and a provider's key that answered.
  const [read] = readSteps([step], [{ id: "hub/sandboxes", status: "ok", message: "boat.dev answered for the team's key." } as never]);
  expect(read).toMatchObject({ status: "done", way: "hosted sandboxes" });
  expect(sandboxProviders([])).toBeUndefined();
  const at = "2026-11-17T00:00:00.000Z";
  expect(sandboxProviders([["boat.dev", { at, ok: true }], ["Acme", { at, ok: true }]])).toMatchObject({ status: "ok", message: "boat.dev and Acme answered for the team's key." });
  expect(sandboxProviders([["boat.dev", undefined]])).toMatchObject({ status: "unknown" });
  expect(sandboxProviders([["Acme", { at, ok: true }], ["boat.dev", { at, ok: false, reason: "billing", message: "devbox: payment required.", fix: "check it" }]])).toMatchObject({
    id: "hub/sandboxes",
    status: "warn",
    message: "boat.dev: devbox: payment required. Check it.",
  });
});

test("a hub that had E2B or Daytona connected: the update drops the key and any pick of it, and says so for a while", async () => {
  const sql = readFileSync(join(import.meta.dir, "../src/hub/store/migrations/202611190500_e2b_daytona_removed.sql"), "utf8");
  const c = t.hub.db.conn;
  c.run("DELETE FROM providers_removed");
  for (const p of ["e2b", "daytona", "boat"]) c.query("INSERT INTO sandbox_providers (provider, sealed, max_agents) VALUES (?1, x'00', 3)").run(p);
  c.run("INSERT INTO sandbox_settings (key, value) VALUES ('linux', 'e2b')");
  c.exec(sql);
  expect(c.query<{ provider: string }, []>("SELECT provider FROM sandbox_providers").all().map((r) => r.provider)).toEqual(["boat"]);
  expect((await call(member, "sandbox_get")).linux).toBe("ours_first");
  expect((await call(member, "sandbox_get")).removed).toEqual([
    "Daytona was removed from fleetd, with the key you connected: its boxes can't open /dev/kvm (user-namespaced containers), so they can't run Android's emulator. Agents run on your machines or boat.dev.",
    "E2B was removed from fleetd, with the key you connected: its boxes have no KVM (Firecracker microVMs), so they can't run Android's emulator. Agents run on your machines or boat.dev.",
  ]);
});
