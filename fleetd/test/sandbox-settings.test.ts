// The team's own hosted sandbox accounts (hub/sandbox, node/sandbox): each provider's key connected through a sealed
// value, tested on a machine of the team's and removed, never shown; E2B's domain; the limit; the order; the limits and
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
import { boatStandIn, daytonaStandIn, e2bStandIn, KEY as STANDIN_KEY } from "./sandbox/stand_ins.ts";
import { domainOf } from "../src/shared/sandbox.ts";
import { Boxes } from "../src/node/sandbox/remote/boxes.ts";
import { slots } from "../src/hub/slots/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NodeAction } from "../src/shared/node_link.ts";
import { addMachine, caller, testHub } from "./screens_helpers.ts";

let t: ReturnType<typeof testHub>;
const admin = caller("admin", { kind: "human", name: "ana" });
const member = caller("read", { kind: "human", name: "ben" });
const GOOD = "e2b_good_key_0123456789";
const BAD = "e2b_bad_key_0123456789";

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
    { provider: "e2b", connected: false, limit: 0 },
    { provider: "boat", connected: false, limit: 0 },
    { provider: "daytona", connected: false, limit: 0 },
  ] });
  await expect(call(member, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD) })).rejects.toThrow();
  const on = await call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD) });
  expect(on.providers[0]).toEqual({ provider: "e2b", connected: true, limit: 5, check: { at: expect.any(String), ok: true } });
  expect(asked).toEqual([{ id: "e2b", auth: { key: GOOD } }]);
  const stored = t.hub.db.conn.query<{ sealed: Uint8Array }, []>("SELECT sealed FROM sandbox_providers").get()!;
  expect(Buffer.from(stored.sealed).includes(Buffer.from(GOOD))).toBe(false);
  expect(JSON.stringify(on)).not.toContain(GOOD);
  expect(JSON.stringify(await call(member, "sandbox_get"))).not.toContain(GOOD);
});

test("a refused key says why, masked, with what fixes it; one nothing can test says so", async () => {
  machine("devbox");
  const bad = await call(admin, "sandbox_connect", { provider: "daytona", sealed: sealed(BAD), limit: 3 });
  const d = bad.providers[2];
  expect(d).toMatchObject({ provider: "daytona", connected: true, limit: 3, check: { ok: false, reason: "invalid_key" } });
  expect(d.check.message).toBe("devbox: daytona refused the key …");
  expect(d.check.fix).toContain("Make a new one in Daytona's dashboard");
  expect(JSON.stringify(bad)).not.toContain(BAD);
  t.link.unlink("devbox");
  const none = await call(admin, "sandbox_test", { provider: "daytona" });
  // With no machine, the hub's own runner tests it: here it never came up.
  expect(none.providers[2].check).toMatchObject({ ok: false, reason: "failed", message: expect.stringContaining("The hub's runner for hosted sandboxes didn't come up") });
});

test("E2B alone takes a domain, cleaned; a limit is 0 to 500; set and disconnect", async () => {
  machine("devbox");
  await expect(call(admin, "sandbox_connect", { provider: "boat", sealed: sealed(GOOD), domain: "x.example.com" })).rejects.toThrow("Only E2B takes a domain");
  await expect(call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD), domain: "not a domain" })).rejects.toThrow("isn't a domain");
  await expect(call(admin, "sandbox_connect", { provider: "modal", sealed: sealed(GOOD) })).rejects.toThrow();
  const on = await call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD), domain: "https://E2B.example.com/" });
  expect(on.providers[0]).toMatchObject({ domain: "e2b.example.com", limit: 5 });
  expect(asked.at(-1)).toEqual({ id: "e2b", auth: { key: GOOD, domain: "e2b.example.com" } });
  await expect(call(admin, "sandbox_set", { provider: "e2b", limit: 501 })).rejects.toThrow();
  await expect(call(admin, "sandbox_set", { provider: "boat", limit: 2 })).rejects.toThrow("No boat.dev key is connected");
  expect((await call(admin, "sandbox_set", { provider: "e2b", limit: 20 })).providers[0].limit).toBe(20);
  // A key connected again keeps the limit set.
  expect((await call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD) })).providers[0]).toMatchObject({ limit: 20 });
  const off = await call(admin, "sandbox_disconnect", { provider: "e2b" });
  expect(off.providers[0]).toEqual({ provider: "e2b", connected: false, limit: 0 });
});

test("limits and keys reach the team's machines in the fixed order, at each change and as one links, and the slot board", async () => {
  machine("devbox");
  await call(admin, "sandbox_connect", { provider: "daytona", sealed: sealed(GOOD), limit: 4 });
  await call(admin, "sandbox_connect", { provider: "e2b", sealed: sealed(GOOD), limit: 10 });
  const until = async (ok: () => boolean) => {
    for (let i = 0; !ok() && i < 200; i++) await Bun.sleep(5);
  };
  const node = nodes.get("devbox")!;
  await until(() => node.placeable().length === 2);
  expect(node.limits).toEqual([{ provider: "e2b", max: 10 }, { provider: "daytona", max: 4 }]);
  // The node holds both keys, each sealed to it, and says it can place agents there.
  expect(node.placeable()).toEqual(["e2b", "daytona"]);
  expect(slots(t.hub).placeOf("nobody")).toBeUndefined();
  // A node that links later gets them as it links.
  machine("box2");
  await until(() => nodes.get("box2")!.placeable().length === 2);
  expect(nodes.get("box2")!.limits).toEqual([{ provider: "e2b", max: 10 }, { provider: "daytona", max: 4 }]);
  await call(admin, "sandbox_disconnect", { provider: "e2b" });
  await until(() => nodes.get("box2")!.placeable().length === 1);
  expect(nodes.get("box2")!.placeable()).toEqual(["daytona"]);
});

const STAND_INS = { e2b: e2bStandIn, boat: boatStandIn, daytona: daytonaStandIn } as const;
for (const id of ["e2b", "boat", "daytona"] as const) {
  test(`Test reaches ${id}'s stand-in server through the real client: its key works, a wrong one is refused`, async () => {
    const server = STAND_INS[id]();
    try {
      const api = id === "boat" ? `${server.url}/api/v1` : server.url;
      // The node's own client, only pointed at the stand-in server.
      machine("devbox", (p, auth, o) => provider(p, auth, { ...o, urls: { api } }));
      const on = await call(admin, "sandbox_connect", { provider: id, sealed: sealed(STANDIN_KEY) });
      expect(on.providers.find((p: { provider: string }) => p.provider === id).check).toEqual({ at: expect.any(String), ok: true });
      expect(server.calls.length).toBeGreaterThan(0);
      expect(server.boxes.size).toBe(0);
      const wrong = "wrong-key-987654321";
      const off = await call(admin, "sandbox_connect", { provider: id, sealed: sealed(wrong) });
      const check = off.providers.find((p: { provider: string }) => p.provider === id).check;
      expect(check).toMatchObject({ ok: false, reason: "invalid_key", message: expect.stringMatching(/^devbox: /) });
      expect(JSON.stringify(off)).not.toContain(wrong);
    } finally {
      server.stop();
    }
  });
}

test("a domain is a host", () => {
  expect(domainOf("e2b.example.com:8443")).toBe("e2b.example.com:8443");
  expect(domainOf("http://box/")).toBe("box");
  expect(domainOf("a b")).toBeNull();
  expect(domainOf("")).toBeNull();
});

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
  const [read] = readSteps([step], [{ id: "hub/sandboxes", status: "ok", message: "E2B answered for the team's key." } as never]);
  expect(read).toMatchObject({ status: "done", way: "hosted sandboxes" });
  expect(sandboxProviders([])).toBeUndefined();
  const at = "2026-11-17T00:00:00.000Z";
  expect(sandboxProviders([["E2B", { at, ok: true }], ["Daytona", { at, ok: true }]])).toMatchObject({ status: "ok", message: "E2B and Daytona answered for the team's key." });
  expect(sandboxProviders([["E2B", undefined]])).toMatchObject({ status: "unknown" });
  expect(sandboxProviders([["E2B", { at, ok: true }], ["boat.dev", { at, ok: false, reason: "billing", message: "devbox: payment required.", fix: "check it" }]])).toMatchObject({
    id: "hub/sandboxes",
    status: "warn",
    message: "boat.dev: devbox: payment required. Check it.",
  });
});
