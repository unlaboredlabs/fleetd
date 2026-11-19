// Revyl was removed from fleetd (D576): a hub that had it connected upgrades with its sealed key and routes deleted and
// one line saying so under Providers for 30 days; an older app's Revyl calls are told it was removed, which it reads as
// a hub without Revyl; and an agent's iOS start goes to a Mac machine, or says how the team adds one.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { NO_MAC } from "../src/hub/machine_roles/calls.ts";
import { start as startRoles } from "../src/hub/machine_roles/loops.ts";
import { SHOWN_MS } from "../src/hub/sandbox/removed.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { tempHome } from "./helpers.ts";
import { addMachine, addProject, agent, caller, testHub } from "./screens_helpers.ts";

const AT = "2026-11-18T10:00:00.000Z";
const admin = caller("admin", { kind: "human", name: "ana" });
const tables = (conn: Database) =>
  conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

/** A hub as main left it before the removal, `connected` or not, with a screen that ran in Revyl. */
function upgraded(connected: boolean): { db: HubDb; done: () => void } {
  const home = tempHome();
  const before = new Database(join(home.dir, "hub.sqlite"), { create: true, strict: true });
  const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_revyl_removed"));
  expect(at).toBeGreaterThan(0);
  migrate(before, MIGRATIONS.slice(0, at));
  if (connected) before.run("INSERT INTO revyl_account (id, sealed, check_json, route_ios) VALUES (1, x'0102', '{\"ok\":true}', 'revyl_only')");
  before.run(`INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data)
    VALUES ('B11111111111111111111111111111111', 'devbox', 'p1', 0, 'recorded', 0, '{"threadId":"t1","kind":"ios","source":"revyl"}')`);
  before.close();
  const db = HubDb.open(home.dir);
  return { db, done: () => (db.conn.close(), home.done()) };
}

async function sandboxGet(db: HubDb, now: number): Promise<{ removed?: string[] }> {
  const hub = new Hub({ home: db.conn.filename.replace(/\/hub\.sqlite$/, ""), listen: { host: "127.0.0.1", port: 0 } }, db, { now: () => now });
  const tools = new Registry();
  registerAll(tools);
  const out = await tools.call(hub, admin, "sandbox_get", {});
  hub.shutdown.abort();
  if (!("output" in out)) throw new Error(JSON.stringify(out.error));
  return out.output as { removed?: string[] };
}

test("a hub that had Revyl connected upgrades with its key gone and one line saying so, for 30 days", async () => {
  const { db, done } = upgraded(true);
  try {
    expect(db.drift).toEqual([]);
    expect(tables(db.conn)).not.toContain("revyl_account");
    const atMs = db.conn.query<{ at_ms: number }, []>("SELECT at_ms FROM providers_removed WHERE provider = 'revyl'").get()!.at_ms;
    // The screen that ran in Revyl stays, as one of the team's.
    expect(db.conn.query<{ data: string }, []>("SELECT data FROM browser_sessions").get()!.data).toBe('{"threadId":"t1","kind":"ios"}');
    const shown = await sandboxGet(db, atMs + 1000);
    expect(shown.removed).toEqual([
      "Revyl was removed from fleetd, with the key you connected: iOS simulators run on a Mac machine, Android on a Linux machine.",
    ]);
    expect((await sandboxGet(db, atMs + SHOWN_MS + 1)).removed).toBeUndefined();
  } finally {
    done();
  }
});

test("a hub that never connected Revyl upgrades with nothing to say", async () => {
  const { db, done } = upgraded(false);
  try {
    expect(tables(db.conn)).not.toContain("revyl_account");
    expect(db.conn.query("SELECT * FROM providers_removed").all()).toEqual([]);
    expect((await sandboxGet(db, Date.parse(AT))).removed).toBeUndefined();
  } finally {
    done();
  }
});

let t: ReturnType<typeof testHub> | undefined;
afterEach(() => {
  t?.done();
  t = undefined;
});

test("an older app's Revyl calls are told Revyl was removed, as not_found: it shows a hub without Revyl", async () => {
  t = testHub();
  for (const tool of ["revyl_get", "revyl_connect", "revyl_route_set"]) {
    const out = await t.tools.call(t.hub, admin, tool, {});
    expect(out).toMatchObject({ error: { kind: "tool", error: { code: "not_found", message: "Revyl was removed from fleetd." } } });
  }
});

const KEY = Buffer.alloc(32, 7).toString("base64");
const ios = {
  op: "session_route",
  host: "ios",
  frame: { id: "c1", cwd: "/w", threadId: "t1", call: { op: "session_start", kind: "ios", purpose: "check the app" } },
};

test("kind ios: the way to mac sim start on a Mac machine, or how the team adds one while it has none", async () => {
  t = testHub();
  startBrowser(t.hub);
  startRoles(t.hub);
  addMachine(t.hub, "devbox", { boxPubKey: KEY });
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["browser", "session_seal", "session_host"]);
  const who = agent("devbox", "p1", "T3");
  const none = (await t.calls.call(who, ios)) as { error?: { code: string; message: string; fix?: string } };
  expect(none.error).toMatchObject({ code: "failed", message: NO_MAC });
  expect(none.error?.fix).toContain("Settings › Hub › Machines");
  addMachine(t.hub, "mac1", { boxPubKey: KEY, agentsMac: true });
  t.link.link("mac1", ["mac_tool", "agents_mac"]);
  const mac = (await t.calls.call(who, ios)) as { error?: { code: string; message: string } };
  expect(mac.error).toMatchObject({ code: "invalid", message: expect.stringContaining("mac sim start") });
});
