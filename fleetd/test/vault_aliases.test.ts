// The old APIs as aliases of the vault for one release: project_env_set, request_secret's env:/file:/order: sinks
// and a project's card, which a purchase claim now carries sealed to the hosting node.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { answer, start as startPurchases } from "../src/hub/project_lead/purchases.ts";
import { orderEnvStore, saved } from "../src/hub/projects/order_env.ts";
import * as repos from "../src/hub/repos/store.ts";
import { type DeliveryPort, deliveries, envRows } from "../src/hub/vault/deliver.ts";
import { dropClosed, start as startVault, strays, takeIn } from "../src/hub/vault/loops.ts";
import { fingerprintOf } from "../src/hub/vault/fields.ts";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { M, OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";
import { refusal } from "./people-kit.ts";

let k: VaultHub;
beforeEach(async () => {
  k = vaultHub();
  startVault(k.hub);
  await k.v.load();
});
afterEach(() => k.done());

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const items = () => k.v.store.select("1 = 1", []);
/** The fake node answers vault_adopt with what its order files hold, each value sealed to the hub. */
const adoptsOrderFiles = () =>
  Object.defineProperty(k.node, "adopt", {
    get: () => ({
      vars: [...k.node.orderFiles].flatMap(([key, vars]) =>
        [...vars].map(([name, value]) => {
          const [projectId, orderId] = key.split("/");
          return { scope: "order", projectId, orderId, name, secret: true, sealed: b64(seal(k.hubPub(), Buffer.from(value))), fingerprint: fingerprintOf(value), bytes: value.length };
        }),
      ),
      sinks: [],
    }),
  });

test("project_env_set: plain values and secrets sealed to the hub become vault variables and reach the node", async () => {
  const sealedToHub = b64(seal(k.hubPub(), Buffer.from("planted-alias-1")));
  const out = await k.call<{ env: { name: string; kind: string; value?: string }[] }>(k.ownerDevice, "project_env_set", {
    ...PROJECT,
    set: [
      { kind: "plain", name: "REGION", value: "eu" },
      { kind: "secret", name: "API_KEY", sealed: sealedToHub },
    ],
  });
  expect(out.env.map((v) => [v.name, v.kind, v.value])).toEqual([
    ["API_KEY", "secret", undefined],
    ["REGION", "plain", "eu"],
  ]);
  expect(items().map((r) => [r.envName, r.meta.secret])).toEqual([
    ["API_KEY", true],
    ["REGION", false],
  ]);
  await deliveries(k.hub).reconcile(M);
  expect(Object.fromEntries(k.node.projectFiles.get("p1")!)).toEqual({ API_KEY: "planted-alias-1", REGION: "eu" });
  // Removing one through the old API takes it out of the vault and the node.
  await k.call(k.ownerDevice, "project_env_set", { ...PROJECT, remove: ["REGION"] });
  await deliveries(k.hub).reconcile(M);
  expect(Object.fromEntries(k.node.projectFiles.get("p1")!)).toEqual({ API_KEY: "planted-alias-1" });
  expect(items().map((r) => r.envName)).toEqual(["API_KEY"]);
});

test("request_secret names the hub's key; a value sealed to it is kept in the vault and delivered to its sink", async () => {
  const a = approvals(k.hub);
  const env = await a.requestSecret(PROJECT, { key: "stripe.key", sink: `env:${M}:/srv/p1/.env`, text: "The Stripe key" });
  expect(env.secret?.sealTo).toBe(b64(k.hubPub()));
  const out = await k.call<{ fingerprint: string }>(k.ownerDevice, "secret_submit", { requestId: env.requestId, sealed: b64(seal(k.hubPub(), Buffer.from("planted-sink-1"))) });
  expect(out.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  expect(k.node.sinks.get(`env:${M}:/srv/p1/.env`)).toBe("planted-sink-1");
  const row = items()[0]!;
  expect(row.meta.sink).toMatchObject({ kind: "env", machineId: M, path: "/srv/p1/.env", secretKey: "stripe.key" });
  expect(a.get(env.requestId)?.state).toBe("stored");
});

test("two requests to the same .env stay two items, each with its own value; a sink's name never blocks a variable", async () => {
  const a = approvals(k.hub);
  const sink = `env:${M}:/srv/p1/.env`;
  const stripe = await a.requestSecret(PROJECT, { key: "stripe.key", sink, text: "Stripe" });
  await k.call(k.ownerDevice, "secret_submit", { requestId: stripe.requestId, sealed: b64(seal(k.hubPub(), Buffer.from("stripe-value"))) });
  const openai = await a.requestSecret(PROJECT, { key: "openai.key", sink, text: "OpenAI" });
  await k.call(k.ownerDevice, "secret_submit", { requestId: openai.requestId, sealed: b64(seal(k.hubPub(), Buffer.from("openai-value"))) });
  const sinks = items().filter((r) => r.meta.sink);
  expect(sinks.map((r) => [r.meta.sink?.secretKey, r.label]).sort()).toEqual([
    ["openai.key", "openai.key"],
    ["stripe.key", "stripe.key"],
  ]);
  for (const r of sinks) expect(k.v.store.open(r).value).toBe(r.meta.sink?.secretKey === "stripe.key" ? "stripe-value" : "openai-value");
  // A file: sink named API_KEY leaves the project's own API_KEY free to set, and doesn't count as a variable.
  const file = await a.requestSecret(PROJECT, { key: "api.key", sink: `file:${M}:/srv/p1/api_key`, text: "API key" });
  await k.call(k.ownerDevice, "secret_submit", { requestId: file.requestId, sealed: b64(seal(k.hubPub(), Buffer.from("file-value"))) });
  const out = await k.call<{ next: string; env: { name: string }[] }>(k.ownerDevice, "project_env_set", { ...PROJECT, set: [{ kind: "plain", name: "API_KEY", value: "eu" }] });
  expect(out.next).not.toContain("didn't take");
  expect(out.env.map((v) => v.name)).toEqual(["API_KEY"]);
});

test("an order: sink's value becomes an order variable", async () => {
  k.hub.db.conn
    .query("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (5, ?, ?, 'open', ?)")
    .run(M, PROJECT.projectId, JSON.stringify({ workstreamId: "W5", projectRef: PROJECT, state: "open" }));
  approvals(k.hub).deps.hooks.orderRefusal = async () => undefined;
  const r = await approvals(k.hub).requestSecret(PROJECT, { key: "deploy.token", sink: `order:${M}:W5`, text: "Deploy token" });
  await k.call(k.ownerDevice, "secret_submit", { requestId: r.requestId, sealed: b64(seal(k.hubPub(), Buffer.from("planted-order-1"))) });
  expect(items().map((x) => [x.scope, x.workstreamId, x.envName])).toEqual([["order", "W5", "DEPLOY_TOKEN"]]);
  expect(Object.fromEntries(k.node.orderFiles.get("p1/W5")!)).toEqual({ DEPLOY_TOKEN: "planted-order-1" });
});

test("an order's variable sealed to its machine (the old way) reaches its running agents in every repo checkout and in vault_items, and goes with the order", async () => {
  // p2 is the checkout of p1's second repo: the order's agents in that repo run in p2 and source p2's order file at
  // each command, and list p2's variables with vault_items.
  repos.attach(k.hub.db.conn, PROJECT, "cloud", OTHER);
  k.hub.db.conn
    .query("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (13, ?, ?, 'open', ?)")
    .run(M, PROJECT.projectId, JSON.stringify({ workstreamId: "W13", projectRef: PROJECT, state: "open" }));
  const a = approvals(k.hub);
  a.deps.hooks.orderRefusal = async () => undefined;
  a.deps.hooks.orderEnvSaved = (s, at) => saved(k.hub, s, at);
  a.deps.nodes.deliverSecret = (m, input) => k.hub.peek<DeliveryPort>("vault.port")!.deliverSecret(m, input);
  adoptsOrderFiles();
  const r = await a.requestSecret(PROJECT, { key: "cloudflare.email_token", sink: `order:${M}:W13`, envName: "EMAIL_TOKEN", text: "Email token" });
  expect(r.secret?.sealTo).toBe(b64(k.hubPub()));
  // An app that sealed it to the machine's key, as the desktop app did: the workspace can't keep it itself.
  const sealedToNode = b64(seal(publicKeyOf(k.node.secret), Buffer.from("dummy-email-token")));
  await k.call(k.ownerDevice, "secret_submit", { requestId: r.requestId, sealed: sealedToNode });
  expect(a.get(r.requestId)?.state).toBe("stored");
  expect(Object.fromEntries(k.node.orderFiles.get("p1/W13") ?? [])).toEqual({ EMAIL_TOKEN: "dummy-email-token" });
  expect(Object.fromEntries(k.node.orderFiles.get("p2/W13") ?? [])).toEqual({ EMAIL_TOKEN: "dummy-email-token" });
  expect(envRows(k.hub, OTHER, "W13").map((x) => x.envName)).toEqual(["EMAIL_TOKEN"]);
  expect(envRows(k.hub, PROJECT, "W13").map((x) => x.envName)).toEqual(["EMAIL_TOKEN"]);
  // Both files are the order's: closing it drops each (projects/order_env.ts dropClosed), and the vault's item goes.
  expect(orderEnvStore.held(k.hub.db.conn).map(([p, w]) => `${p.projectId}/${w}`).sort()).toEqual(["p1/W13", "p2/W13"]);
  k.hub.db.conn.query("UPDATE workstreams SET state = 'done' WHERE n = 13").run();
  dropClosed(k.hub);
  expect(envRows(k.hub, OTHER, "W13")).toEqual([]);
});

test("a value an older app left under the order's bot only reaches its repo checkouts at the next sweep, asked for once", async () => {
  repos.attach(k.hub.db.conn, PROJECT, "cloud", OTHER);
  k.hub.db.conn
    .query("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (14, ?, ?, 'open', ?)")
    .run(M, PROJECT.projectId, JSON.stringify({ workstreamId: "W14", projectRef: PROJECT, state: "open" }));
  // What an older workspace left: the node's file under p1 and its order_env row, with no vault item.
  k.node.orderFiles.set("p1/W14", new Map([["EMAIL_TOKEN", "dummy-left"]]));
  const row = { name: "EMAIL_TOKEN", fingerprint: fingerprintOf("dummy-left"), bytes: 10, requestId: "Q9", updatedAt: "2026-11-26T14:36:00Z" };
  orderEnvStore.save(k.hub.db.conn, PROJECT, "W14", row);
  orderEnvStore.save(k.hub.db.conn, PROJECT, "W14", { ...row, name: "GH_TOKEN", requestId: "github" });
  adoptsOrderFiles();
  const tried = new Set<string>();
  const stray = strays(k.hub, tried);
  expect(stray).toEqual([M]);
  for (const m of stray) await takeIn(k.hub, m);
  expect(Object.fromEntries(k.node.orderFiles.get("p2/W14") ?? [])).toEqual({ EMAIL_TOKEN: "dummy-left" });
  // fleetd's own GitHub token stays on its own path.
  expect(envRows(k.hub, OTHER, "W14").map((x) => x.envName)).toEqual(["EMAIL_TOKEN"]);
  expect(strays(k.hub, new Set())).toEqual([]);
  // Each value once per process: one the node can't hand over isn't asked for at every sweep.
  k.hub.db.conn.query("UPDATE vault_items SET deleted_ms = 1 WHERE workstream_id = 'W14'").run();
  expect(strays(k.hub, tried)).toEqual([]);
});

test("a vault card: picked for the bot, claimed once, sealed to the hosting node; its fill closes the audit row", async () => {
  startPurchases(k.hub);
  const card = await k.call<{ item: { itemId: string } }>(k.ownerDevice, "vault_save", {
    kind: "card",
    label: "Visa (Personal)",
    sealed: k.sealToHub({ number: "4242424242424242", month: "04", year: "2031", cvc: "123", name: "Ada" }),
  });
  const ref = `vault:${card.item.itemId}`;
  // A card set aside at the upgrade can't be picked: only the team vault's cards pay.
  const bos = k.v.store.insert({ kind: "card", scope: "person", personId: k.member.personId, label: "Bo", meta: { brand: "visa", last4: "4242", source: { kind: "typed" } } }, { number: "4242424242424242" }, k.member.personId, k.clock.now());
  expect((await refusal(k.call(k.ownerDevice, "project_card_set", { ...PROJECT, card: `vault:${bos.itemId}` }))).code).toBe("invalid");
  const set = await k.call<{ card: { ref: string; label?: string } }>(k.ownerDevice, "project_card_set", { ...PROJECT, card: ref });
  expect(set.card).toMatchObject({ ref, label: "Visa (Personal) ••4242" });
  const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "lead" }, threadId: "t", via: M };
  const S = "B0123456789abcdef0123456789abcdef";
  const opened = (await answer(k.hub, lead, {
    op: "purchase_open",
    sessionId: S,
    page: "https://shop.example/checkout",
    purchase: { shop: { name: "Shop", domain: "shop.example" }, total: { amount: "10.00", currency: "EUR" }, items: [] },
  } as never)) as { requestId: string };
  // This test's node isn't on a link, so the hub asks rather than recording with no ask: approve it.
  await k.call(k.ownerDevice, "approval_answer", { requestId: opened.requestId, decision: "approve" });
  const claimed = (await answer(k.hub, lead, { op: "purchase_claim", requestId: opened.requestId, sessionId: S } as never)) as { sealedCard: string; card: string };
  expect(claimed.card).toBe(ref);
  expect(JSON.parse(k.open(claimed.sealedCard))).toEqual({ number: "4242424242424242", month: "04", year: "2031", cvc: "123", name: "Ada" });
  await answer(k.hub, lead, { op: "purchase_filled", requestId: opened.requestId, ok: true, typed: true, message: "filled" } as never);
  const rows = k.hub.db.all<{ action: string; outcome: string; data: string }>("SELECT action, outcome, data FROM vault_audit WHERE action = 'purchase'");
  expect(rows.map((r) => r.outcome)).toEqual(["ok"]);
  expect(JSON.parse(rows[0]!.data)).toMatchObject({ purchaseId: opened.requestId, host: M });
  // A node without the vault fill capability is refused a vault card, so it never gets one it can't fill.
  k.node.caps.delete("vault_fill");
  const again = (await answer(k.hub, lead, {
    op: "purchase_open",
    sessionId: S,
    page: "https://shop.example/checkout",
    purchase: { shop: { name: "Shop", domain: "shop.example" }, total: { amount: "5.00", currency: "EUR" }, items: [] },
  } as never)) as { requestId: string };
  await k.call(k.ownerDevice, "approval_answer", { requestId: again.requestId, decision: "approve" });
  expect((await refusal((async () => answer(k.hub, lead, { op: "purchase_claim", requestId: again.requestId, sessionId: S } as never))())).message).toContain("Update fleetd");
  expect(leadCalls(k.hub).handler("vault_fill")).toBeDefined();
});
