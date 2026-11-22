// Agents run on the team's own computers, directly, or on fleetd's cloud (D594): a self-hosted hub upgrades with its
// own sandbox keys, its Tailscale gateway's state and its hosted sandboxes' node gone, and nothing on disk deleted. A
// bot that had picked a Local VM or a hosted sandbox runs on its machine and says so once in its chat; a bot that lived
// in the hosted sandboxes keeps its files where they were, its chat says where once, and a message to it is answered at
// once with the same reason, never silence. The `hosted` id stays reserved.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { sendAsAgent } from "../src/hub/chat/flow.ts";
import { tellOnce } from "../src/hub/hosted_gone/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { createEnrollToken } from "../src/cli/store.ts";
import { sha256 } from "../src/hub/auth/index.ts";
import { tempHome } from "./helpers.ts";
import { caller, TestClock, testHub } from "./screens_helpers.ts";

const admin = caller("admin", { kind: "human", name: "ana" });
const KEY = "a".repeat(43);
const tables = (conn: Database) => conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const message = (out: unknown) => {
  const o = out as { error?: { kind: string; error: { message: string; fix?: string } } };
  return o.error?.kind === "tool" ? o.error.error : undefined;
};

/** A hub as main left it before the removal: three bots on devbox (a Local VM pick, a boat.dev pick, none), one in the
 * hosted sandboxes with its checkout under `<home>/runner`, a sandbox key, the Tailscale gateway's state. */
function upgraded() {
  const home = tempHome();
  const before = new Database(join(home.dir, "hub.sqlite"), { create: true, strict: true });
  const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_own_machines_only"));
  expect(at).toBeGreaterThan(0);
  migrate(before, MIGRATIONS.slice(0, at));
  const files = join(home.dir, "runner", "projects", "notes");
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "unpushed.md"), "work nobody pushed\n");
  const project = (m: string, p: string, root: string) =>
    before.run("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, '', '', ?)", [m, p, JSON.stringify({ machineId: m, projectId: p, title: p, workspaceRoot: root })]);
  before.run("INSERT INTO machines (machine_id, data) VALUES ('devbox', ?)", [JSON.stringify({ machineId: "devbox", name: "devbox", nodeVersion: "1.0.0", status: "online", lastSeenAt: new Date(0).toISOString() })]);
  before.run("INSERT INTO machines (machine_id, data) VALUES ('hosted', ?)", [JSON.stringify({ machineId: "hosted", name: "Hosted sandboxes", runner: true, nodeVersion: "1.0.0", status: "online", lastSeenAt: new Date(0).toISOString() })]);
  before.run("INSERT INTO node_keys (machine_id, pub_key) VALUES ('hosted', ?)", [KEY]);
  project("devbox", "shop", "/work/shop");
  project("devbox", "api", "/work/api");
  project("devbox", "plain", "/work/plain");
  project("hosted", "notes", files);
  before.run("INSERT INTO project_settings (machine_id, project_id, computer) VALUES ('devbox', 'shop', '{\"kind\":\"vm\",\"cpu\":2,\"memGb\":4}')");
  before.run("INSERT INTO project_settings (machine_id, project_id, computer) VALUES ('devbox', 'api', '{\"kind\":\"boat\",\"cpu\":4,\"memGb\":8}')");
  before.run("INSERT INTO sandbox_providers (provider, sealed, max_agents) VALUES ('boat', x'0102', 5)");
  before.run("INSERT INTO tailnet_gateway (id, sealed) VALUES (1, x'0304')");
  before.close();
  const db = HubDb.open(home.dir);
  const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, db, new TestClock());
  const tools = new Registry();
  registerAll(tools);
  return { home: home.dir, db, hub, tools, files, done: () => (hub.shutdown.abort(), db.conn.close(), home.done()) };
}

const lines = (db: HubDb, p: string) =>
  db.conn
    .query<{ data: string }, [string]>("SELECT data FROM chat_messages WHERE project_id = ? ORDER BY seq")
    .all(p)
    .map((r) => (JSON.parse(r.data) as { author: string; text: string }))
    .filter((m) => m.author === "system")
    .map((m) => m.text);

test("a hub upgrades with its sandbox keys, Tailscale state and hosted node gone, its bots and their files kept", () => {
  const t = upgraded();
  try {
    expect(t.db.drift).toEqual([]);
    for (const gone of ["sandbox_providers", "sandbox_settings", "providers_removed", "tailnet_gateway"]) expect(tables(t.db.conn)).not.toContain(gone);
    expect(t.db.conn.query("SELECT computer FROM project_settings WHERE computer IS NOT NULL").all()).toEqual([]);
    expect(t.db.conn.query("SELECT machine_id FROM machines").all()).toEqual([{ machine_id: "devbox" }]);
    expect(t.db.conn.query("SELECT machine_id FROM node_keys WHERE machine_id = 'hosted'").all()).toEqual([]);
    // Every bot stays, the hosted sandboxes' one too, and nothing of its files went.
    expect(t.db.conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM projects").get()!.n).toBe(4);
    expect(readFileSync(join(t.files, "unpushed.md"), "utf8")).toBe("work nobody pushed\n");
  } finally {
    t.done();
  }
}, 30_000);

test("each bot that had a VM, a hosted sandbox or lived in one hears it once in its chat", () => {
  const t = upgraded();
  try {
    expect(tellOnce(t.hub)).toBe(3);
    expect(lines(t.db, "shop")).toEqual(["fleetd no longer runs agents in VMs on your computers: this bot's agents run directly on devbox again, as before."]);
    expect(lines(t.db, "api")).toEqual(["fleetd no longer supports hosted sandboxes with your own boat.dev key: this bot's agents run on devbox from now on."]);
    expect(lines(t.db, "notes")).toEqual([
      `This bot ran in a hosted sandbox with your own boat.dev key, which fleetd no longer supports. Its files are in ${t.files} on the hub's machine. Add its repo on one of your computers to keep working on it.`,
    ]);
    expect(lines(t.db, "plain")).toEqual([]);
    // Once: the hub's next start says nothing again, even with the rows marked unsaid.
    expect(tellOnce(t.hub)).toBe(0);
    t.db.conn.run("UPDATE hosted_removed SET said = 0");
    tellOnce(t.hub);
    expect(lines(t.db, "notes")).toHaveLength(1);
    expect(existsSync(t.files)).toBe(true);
  } finally {
    t.done();
  }
}, 30_000);

test("a message to a bot that lived in the hosted sandboxes is answered at once with why, from a person or an agent", async () => {
  const t = upgraded();
  try {
    const r = { machineId: "hosted", projectId: "notes" };
    const out = await t.tools.call(t.hub, admin, "chat_send", { projectRef: r, text: "carry on", clientRequestId: "c1" });
    expect(message(out)).toMatchObject({
      message: `This bot ran in a hosted sandbox with your own boat.dev key, which fleetd no longer supports. Its files are in ${t.files} on the hub's machine.`,
      fix: "Add its repo on one of your computers to keep working on it.",
    });
    await expect(sendAsAgent(t.hub, r, "lead:devbox/shop", "hello", "req1")).rejects.toThrow("which fleetd no longer supports");
    // Nothing was kept to be delivered later.
    expect(t.db.conn.query("SELECT 1 FROM chat_messages WHERE project_id = 'notes' AND held = 1").all()).toEqual([]);
  } finally {
    t.done();
  }
}, 30_000);

test("hosted stays reserved: no code is made for it and no computer joins as it, an old code included", async () => {
  const t = testHub();
  const out = await t.tools.call(t.hub, admin, "machine_join", { machineId: "hosted", rejoin: true });
  expect(message(out)?.message).toBe('"hosted" was the hub\'s hosted sandboxes, which fleetd no longer runs: nothing joins as it.');
  expect(() => t.hub.auth.nodes.createEnrollToken("hosted", "test")).toThrow("nothing joins as it");
  expect(() => createEnrollToken(t.hub.db, "hosted")).toThrow("nothing joins as it");
  const old = "fle_oldhostedcode";
  t.hub.db.conn.query("INSERT INTO enroll_tokens (hash, machine_id, expires_ms) VALUES (?, ?, ?)").run(sha256(old), "hosted", t.clock.now() + 60_000);
  expect(() => t.hub.auth.nodes.enrollNode(old, "hosted", KEY)).toThrow("hosted was the hub's hosted sandboxes");
  expect(t.hub.auth.nodes.nodePubKey("hosted")).toBeUndefined();
  const code = t.hub.auth.nodes.createEnrollToken("devbox", "test").token;
  expect(t.hub.auth.nodes.enrollNode(code, "devbox", KEY)).toBe("devbox");
  t.done();
});

test("the hub serves none of fleetd cloud's own tools: the apps read their absence and show none of it", async () => {
  const t = testHub();
  for (const tool of ["sandbox_get", "sandbox_connect", "project_image_rebuild"]) {
    expect(await t.tools.call(t.hub, admin, tool, {})).toEqual({ error: { kind: "unknown" } });
  }
  t.done();
});
