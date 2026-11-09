// Moving today's variables, sinks and card into the vault (src/hub/vault/migrate.ts): plain rows from the hub, secrets
// from a Bun node sealed to the hub, fleetd's own GH_TOKEN skipped, idempotent, a Rust node left waiting, and the
// node's newer value winning after a rollback.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { deliveries } from "../src/hub/vault/deliver.ts";
import { adopt, migrateCards, migratePlain, migrationStatus } from "../src/hub/vault/migrate.ts";
import { putToken } from "../src/hub/onepassword/index.ts";
import { M, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
});
afterEach(() => k.done());

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fp = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 8);
const at = () => new Date(k.clock.now()).toISOString();
const items = () => k.v.store.select("1 = 1", []);

function hubRow(name: string, kind: "plain" | "secret", value: string) {
  k.hub.db.conn
    .query("INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(M, PROJECT.projectId, name, kind, kind === "plain" ? value : null, kind === "secret" ? fp(value) : null, value.length, at());
}
const sealed = (v: string) => b64(seal(k.hubPub(), Buffer.from(v)));

test("plain rows move in once; running again changes nothing", () => {
  hubRow("REGION", "plain", "eu");
  expect(migratePlain(k.hub)).toBe(1);
  expect(migratePlain(k.hub)).toBe(0);
  const [row] = items();
  expect([row!.envName, row!.meta.secret, row!.meta.source]).toEqual(["REGION", false, { kind: "adopted", from: "project_env" }]);
});

test("a Bun node hands over its secrets, order variables and sinks; GH_TOKEN stays fleetd's own; a second run adds nothing", async () => {
  hubRow("API_KEY", "secret", "planted-mig-1");
  k.hub.db.conn
    .query("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (3, ?, ?, 'open', ?)")
    .run(M, PROJECT.projectId, JSON.stringify({ workstreamId: "W3", projectRef: PROJECT, state: "open" }));
  k.hub.db.conn
    .query("INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at) VALUES (?, ?, 'W3', 'GH_TOKEN', ?, 10, 'github', ?)")
    .run(M, PROJECT.projectId, fp("ghs_x"), at());
  k.hub.db.conn
    .query("INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at) VALUES (?, ?, 'W3', 'DEPLOY', ?, 10, 'Q9', ?)")
    .run(M, PROJECT.projectId, fp("planted-mig-2"), at());
  k.hub.db.conn
    .query("INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES (?, 'secret', 'stored', 1, ?)")
    .run(`${M}/${PROJECT.projectId}`, JSON.stringify({ secret: { key: "stripe.key", sink: `env:${M}:/srv/p1/.env` } }));
  k.node.adopt = {
    vars: [
      { scope: "project", projectId: "p1", name: "API_KEY", secret: true, sealed: sealed("planted-mig-1"), fingerprint: fp("planted-mig-1"), bytes: 13 },
      { scope: "order", projectId: "p1", orderId: "W3", name: "GH_TOKEN", secret: true, sealed: sealed("ghs_x"), fingerprint: fp("ghs_x"), bytes: 5 },
      { scope: "order", projectId: "p1", orderId: "W3", name: "DEPLOY", secret: true, sealed: sealed("planted-mig-2"), fingerprint: fp("planted-mig-2"), bytes: 13 },
    ],
    sinks: [{ secretKey: "stripe.key", kind: "env", path: "/srv/p1/.env", sealed: sealed("planted-mig-3"), fingerprint: fp("planted-mig-3") }],
  };
  const first = await adopt(k.hub, M);
  expect(first).toMatchObject({ adopted: 3, waiting: 0, mismatched: 0, skippedSystem: 1 });
  expect(items().map((r) => [r.scope, r.envName, r.meta.fingerprint]).sort()).toEqual(
    [
      ["order", "DEPLOY", fp("planted-mig-2")],
      ["project", "API_KEY", fp("planted-mig-1")],
      ["project", "sink:env:stripe.key:/srv/p1/.env", fp("planted-mig-3")],
    ].sort(),
  );
  expect(items().some((r) => r.envName === "GH_TOKEN")).toBe(false);
  // The node already holds them: the first delivery sends nothing back.
  await deliveries(k.hub).reconcile(M);
  expect(k.node.calls.filter((c) => c.op === "project_env" || c.op === "secret_deliver")).toEqual([]);
  const again = await adopt(k.hub, M);
  expect(again.adopted).toBe(3);
  expect(items()).toHaveLength(3);
  // A value whose fingerprint doesn't match is refused, not stored.
  k.node.adopt = { vars: [{ scope: "project", projectId: "p1", name: "OTHER", secret: true, sealed: sealed("a"), fingerprint: fp("b"), bytes: 1 }], sinks: [] };
  expect((await adopt(k.hub, M)).mismatched).toBe(1);
  expect(items()).toHaveLength(3);
});

test("a Rust or older node can't adopt: its secrets wait on its files", async () => {
  hubRow("API_KEY", "secret", "x");
  k.node.caps.delete("vault");
  const p = await adopt(k.hub, M);
  expect(p.waiting).toBe(1);
  expect(p.waitingFor).toContain("Rust");
  expect(migrationStatus(k.hub)).toMatchObject({ done: false });
});

test("after a rollback, a value changed under Rust (newer hub row) wins over the vault's", async () => {
  hubRow("API_KEY", "secret", "old");
  k.node.adopt = { vars: [{ scope: "project", projectId: "p1", name: "API_KEY", secret: true, sealed: sealed("old"), fingerprint: fp("old"), bytes: 3 }], sinks: [] };
  await adopt(k.hub, M);
  k.clock.advance(60_000);
  k.hub.db.conn.query("UPDATE project_env SET fingerprint = ?, updated_at = ? WHERE name = 'API_KEY'").run(fp("new"), at());
  k.node.adopt = { vars: [{ scope: "project", projectId: "p1", name: "API_KEY", secret: true, sealed: sealed("new"), fingerprint: fp("new"), bytes: 3 }], sinks: [] };
  await adopt(k.hub, M);
  expect(items()[0]!.meta.fingerprint).toBe(fp("new"));
});

test("a picked op:// card is imported from a node holding its person's token, then paid with from the vault", async () => {
  k.hub.db.conn
    .query("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person, card_ref) VALUES (?, ?, 1, ?, 'op://Fleet/Visa')")
    .run(M, PROJECT.projectId, k.owner.personId);
  putToken(k.hub.db, k.owner.personId, { fingerprint: "abcd1234", sealedOn: [{ machineId: M, fingerprint: "abcd1234" }], savedAt: at() } as never);
  k.node.onepassword = {
    items: [{ ref: "op://Fleet/Visa", title: "Visa (Personal)", kind: "card", vault: "Fleet" }],
    read: { "op://Fleet/Visa": { title: "Visa (Personal)", card: { number: "4242424242424242", month: "01", year: "2030", cvc: "321" } } },
  };
  expect(await migrateCards(k.hub)).toBe(1);
  const card = items()[0]!;
  expect(card.meta).toMatchObject({ brand: "visa", last4: "4242", source: { kind: "1password", ref: "op://Fleet/Visa" } });
  expect(k.hub.db.all<{ card_ref: string }>("SELECT card_ref FROM project_settings")[0]!.card_ref).toBe(`vault:${card.itemId}`);
  expect(await migrateCards(k.hub)).toBe(0);
  void publicKeyOf;
});
