// Variables from the vault to the nodes (src/hub/vault/deliver.ts): through today's node files, the order's over the
// project's over a person's; caught up when an offline machine is back; taken back when deleted; the Rust mirror rows
// kept; one inject row per launch with names only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setOnlyMe } from "../src/hub/navi/store.ts";
import { deliveries } from "../src/hub/vault/deliver.ts";
import { beforeLaunch, dropClosed, injected } from "../src/hub/vault/loops.ts";
import { M, OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
});
afterEach(() => k.done());

const save = (input: Record<string, unknown>, caller = k.ownerDevice) => k.call<{ item: { itemId: string } }>(caller, "vault_save", input).then((o) => o.item.itemId);
const sync = () => deliveries(k.hub).reconcile(M);
const file = (projectId: string) => Object.fromEntries(k.node.projectFiles.get(projectId) ?? []);
const mirror = (r = PROJECT) =>
  k.hub.db.all<{ name: string; kind: string; value: string | null; fingerprint: string | null }>(
    "SELECT name, kind, value, fingerprint FROM project_env WHERE machine_id = ? AND project_id = ? ORDER BY name",
    [r.machineId, r.projectId],
  );

function order(n: number, r = PROJECT, startedBy?: string, state = "open") {
  k.hub.db.conn
    .query("INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?, ?, ?, ?, ?)")
    .run(n, r.machineId, r.projectId, state, JSON.stringify({ workstreamId: `W${n}`, projectRef: r, state, ...(startedBy ? { startedBy: { personId: startedBy } } : {}) }));
}

test("a project's variables reach its node file sealed per delivery, and the Rust mirror rows stay in step", async () => {
  await save({ kind: "env", scope: "project", ...PROJECT, envName: "API_KEY", sealed: k.sealToHub({ value: "planted-env-1" }) });
  await save({ kind: "env", scope: "project", ...PROJECT, envName: "REGION", secret: false, sealed: k.sealToHub({ value: "eu" }) });
  await sync();
  expect(file("p1")).toEqual({ API_KEY: "planted-env-1", REGION: "eu" });
  expect(mirror().map((r) => [r.name, r.kind, r.value])).toEqual([
    ["API_KEY", "secret", null],
    ["REGION", "plain", "eu"],
  ]);
  expect(mirror()[0]!.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  // Nothing is sent again while the node holds the same version.
  const calls = k.node.calls.length;
  await sync();
  expect(k.node.calls.length).toBe(calls);
});

test("an offline machine catches up once it's back; a deleted variable is taken back", async () => {
  k.node.online = false;
  const id = await save({ kind: "env", scope: "project", ...PROJECT, envName: "TOKEN", sealed: k.sealToHub({ value: "v1" }) });
  await sync();
  expect(file("p1")).toEqual({});
  k.node.online = true;
  await sync();
  expect(file("p1")).toEqual({ TOKEN: "v1" });
  await k.call(k.ownerDevice, "vault_save", { itemId: id, sealed: k.sealToHub({ value: "v2" }) });
  await sync();
  expect(file("p1")).toEqual({ TOKEN: "v2" });
  await k.call(k.ownerDevice, "vault_delete", { itemId: id });
  await sync();
  expect(file("p1")).toEqual({});
  expect(mirror()).toEqual([]);
});

test("an Only me project gets its owner's person variables under names it doesn't set itself", async () => {
  setOnlyMe(k.hub.db.conn, OTHER, true, k.member.personId);
  await save({ kind: "env", scope: "person", envName: "OPENAI_KEY", sealed: k.sealToHub({ value: "bo-1" }) }, k.memberDevice);
  await save({ kind: "env", scope: "person", envName: "REGION", secret: false, sealed: k.sealToHub({ value: "us" }) }, k.memberDevice);
  await save({ kind: "env", scope: "project", ...OTHER, envName: "REGION", secret: false, sealed: k.sealToHub({ value: "eu" }) }, k.memberDevice);
  await sync();
  expect(file("p2")).toEqual({ OPENAI_KEY: "bo-1", REGION: "eu" });
  // Another project never gets them.
  expect(file("p1")).toEqual({});
});

test("an order gets its own variables and its starter's person variables; they go when it closes", async () => {
  order(7, PROJECT, k.member.personId);
  await save({ kind: "env", scope: "person", envName: "BO_TOKEN", sealed: k.sealToHub({ value: "bo-tok" }) }, k.memberDevice);
  await save({ kind: "env", scope: "person", envName: "SHARED", sealed: k.sealToHub({ value: "person" }) }, k.memberDevice);
  await save({ kind: "env", scope: "project", ...PROJECT, envName: "SHARED", sealed: k.sealToHub({ value: "project" }) });
  await save({ kind: "env", scope: "order", ...PROJECT, workstreamId: "W7", envName: "DEPLOY_KEY", sealed: k.sealToHub({ value: "order-only" }) });
  await sync();
  // The project's SHARED wins over the person's, and lives in the project file.
  expect(Object.fromEntries(k.node.orderFiles.get("p1/W7") ?? [])).toEqual({ BO_TOKEN: "bo-tok", DEPLOY_KEY: "order-only" });
  expect(file("p1")).toEqual({ SHARED: "project" });
  const rows = k.hub.db.all<{ name: string; request_id: string }>("SELECT name, request_id FROM order_env WHERE workstream_id = 'W7' ORDER BY name");
  expect(rows.map((r) => r.name)).toEqual(["BO_TOKEN", "DEPLOY_KEY"]);
  // A launch writes one inject row with the names, never a value.
  injected(k.hub, PROJECT, "W7", "t1");
  const inject = k.hub.db.all<{ data: string }>("SELECT data FROM vault_audit WHERE action = 'inject'");
  expect(JSON.parse(inject[0]!.data)).toEqual({ names: ["BO_TOKEN", "DEPLOY_KEY", "SHARED"] });
  // Closed: its order variables are gone from the vault, and their deliveries with them.
  k.hub.db.conn.query("UPDATE workstreams SET state = 'done' WHERE n = 7").run();
  dropClosed(k.hub);
  expect(k.v.store.select("scope = 'order'", [])).toEqual([]);
  expect(k.hub.db.all("SELECT * FROM vault_deliveries WHERE target LIKE 'order:%'")).toEqual([]);
});

test("a launch in a new order delivers its person's variables first; the inject row lists only what the node holds", async () => {
  await save({ kind: "env", scope: "person", envName: "BO_TOKEN", sealed: k.sealToHub({ value: "bo-tok" }) }, k.memberDevice);
  await sync();
  order(9, PROJECT, k.member.personId);
  // Nothing reconciled since the order opened: the inject row says so.
  injected(k.hub, PROJECT, "W9", "t0");
  expect(k.hub.db.all("SELECT data FROM vault_audit WHERE action = 'inject'")).toEqual([]);
  await beforeLaunch(k.hub, M);
  expect(Object.fromEntries(k.node.orderFiles.get("p1/W9") ?? [])).toEqual({ BO_TOKEN: "bo-tok" });
  injected(k.hub, PROJECT, "W9", "t1");
  expect(JSON.parse(k.hub.db.all<{ data: string }>("SELECT data FROM vault_audit WHERE action = 'inject'")[0]!.data)).toEqual({ names: ["BO_TOKEN"] });
});

test("a person's variables are never delivered to work that isn't theirs", async () => {
  order(8, PROJECT, k.owner.personId);
  await save({ kind: "env", scope: "person", envName: "BO_ONLY", sealed: k.sealToHub({ value: "x" }) }, k.memberDevice);
  await sync();
  expect(k.node.orderFiles.get("p1/W8")).toBeUndefined();
  expect(file("p1")).toEqual({});
});
