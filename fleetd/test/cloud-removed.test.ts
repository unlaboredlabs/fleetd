// A hub from before cloud machines were removed: its cloud machines, their rows, the pool's settings with the sealed
// boat.dev key and the cloud columns all go as it upgrades, its own machines and their work stay, and the setup step
// "Machines that run agents" no longer fails on a cloud machine that was offline.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { doctor } from "../src/hub/doctor/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { TaskRecords } from "../src/hub/tasks/records.ts";
import type { HubSetupStep } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";

const AT = "2026-11-09T10:00:00.000Z";
const machine = (id: string, status: string, cloud: boolean) =>
  JSON.stringify({ machineId: id, name: id, tags: [], status, lastSeenAt: AT, nodeVersion: "1.0.0", ...(cloud ? { cloud: true } : {}) });

/** The hub as today's main leaves it: devbox of its own, and boat-1, a cloud machine asleep since Nov 9. */
function seed(conn: Database): void {
  const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_cloud_machines_removed"));
  expect(at).toBeGreaterThan(0);
  migrate(conn, MIGRATIONS.slice(0, at));
  conn.run(`INSERT INTO machines (machine_id, data) VALUES ('devbox', '${machine("devbox", "online", false)}'),
    ('boat-1', '${machine("boat-1", "offline", true)}'), ('boat-2', '${machine("boat-2", "offline", true)}')`);
  conn.run("INSERT INTO node_keys (machine_id, pub_key, pool) VALUES ('devbox', 'k-dev', 0), ('boat-1', 'k-b1', 1)");
  conn.run("INSERT INTO enroll_tokens (hash, machine_id, expires_ms, pool) VALUES ('h1', 'boat-3', 1, 1), ('h2', 'devbox', 1, 0)");
  conn.run("UPDATE pool_settings SET enabled = 1, sealed_key = x'0102', ssh_key = x'0304', environment = 'fleetd', projects = '[]'");
  conn.run("INSERT INTO pool_machines (slot, sandbox_id, state, created_at) VALUES ('boat-1', 'sb1', 'asleep', 1), ('boat-3', 'sb3', 'gone', 1)");
  conn.run("INSERT INTO pool_starts (at, slot, what) VALUES (1, 'boat-1', 'create')");
  conn.run("INSERT INTO pool_spend (slot, from_ms, per_hour) VALUES ('boat-1', 1, 0.072)");
  conn.run("INSERT INTO pool_boat_cost (sandbox_id, since_ms, dollars) VALUES ('sb1', 1, 0.4)");
  conn.run(`INSERT INTO cloud_outbox (machine_id, item, created_ms) VALUES ('boat-2', '{"kind":"one_password_forget","personId":"p1"}', 1)`);
  for (const [m, p] of [["devbox", "shop"], ["boat-1", "shop"]]) {
    conn.run(`INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('${m}', '${p}', '${p}', '${AT}', '{}')`);
    conn.run(`INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, data) VALUES ('${m}', 't-${m}', '${p}', '${AT}', '{}')`);
  }
  conn.run(`INSERT INTO slot_claims (holder, machine_id, project_id, priority, state, order_n, on_machine)
    VALUES ('T1', 'devbox', 'shop', 'work', 'queued', 1, 'boat-1'), ('T2', 'devbox', 'shop', 'work', 'held', 2, NULL)`);
  conn.run(`INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'shop', 'W1', 'queued', '{"taskId":"T1","ranOn":"boat-1"}')`);
  // Two ended tasks: T2 ran on boat-1, T3 on devbox, each with its worktree not swept yet.
  conn.run(`INSERT INTO tasks (machine_id, project_id, workstream_id, state, thread_id, ended_at, data) VALUES
    ('devbox', 'shop', 'W1', 'done', 't-boat-1', '${AT}', '{"taskId":"T2","projectRef":{"machineId":"devbox","projectId":"shop"},"threadRef":{"machineId":"boat-1","threadId":"t-boat-1"}}'),
    ('devbox', 'shop', 'W1', 'done', 't-devbox', '${AT}', '{"taskId":"T3","projectRef":{"machineId":"devbox","projectId":"shop"},"threadRef":{"machineId":"devbox","threadId":"t-devbox"}}')`);
}

const tables = (conn: Database) =>
  conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const columns = (conn: Database, table: string) =>
  conn.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name);

test("a hub with cloud machines upgrades clean: their rows, the boat.dev key and the cloud tables are gone", async () => {
  const home = tempHome();
  try {
    const before = new Database(join(home.dir, "hub.sqlite"), { create: true, strict: true });
    seed(before);
    before.close();

    const db = HubDb.open(home.dir);
    expect(db.drift).toEqual([]);
    const c = db.conn;
    for (const gone of ["cloud_outbox", "pool_settings", "pool_machines", "pool_starts", "pool_spend", "pool_boat_cost"]) {
      expect(tables(c)).not.toContain(gone);
    }
    expect(columns(c, "node_keys")).not.toContain("pool");
    expect(columns(c, "enroll_tokens")).not.toContain("pool");
    expect(columns(c, "slot_claims")).not.toContain("on_machine");
    // No machine of the cloud is left anywhere: the machine list, keys, codes, projects, threads.
    const left = (sql: string) => c.query<{ v: string }, []>(sql).all().map((r) => r.v);
    expect(left("SELECT machine_id AS v FROM machines")).toEqual(["devbox"]);
    expect(left("SELECT machine_id AS v FROM node_keys")).toEqual(["devbox"]);
    expect(left("SELECT machine_id AS v FROM enroll_tokens")).toEqual(["devbox"]);
    expect(left("SELECT machine_id AS v FROM projects")).toEqual(["devbox"]);
    expect(left("SELECT machine_id AS v FROM threads")).toEqual(["devbox"]);
    expect(left("SELECT holder AS v FROM slot_claims ORDER BY holder")).toEqual(["T1", "T2"]);
    expect(left("SELECT data AS v FROM tasks WHERE state = 'queued'")).toEqual(['{"taskId":"T1"}']);
    // The nightly sweep no longer tries boat-1's worktree, which went with it; devbox's it still sweeps.
    expect(TaskRecords.unswept(c, "9999").map(([t]) => t.taskId)).toEqual(["T3"]);
    expect(left("SELECT data AS v FROM machines").some((d) => d.includes("cloud"))).toBe(false);

    // The hub starts on it: its store reads one machine, and "Machines that run agents" is done, not failing.
    const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 4790 } }, db, { now: () => Date.parse(AT) });
    expect(store(hub).machinesList().map((m) => m.machineId)).toEqual(["devbox"]);
    // setup_list runs the doctor's first pass: its probes are stand-ins, never this machine's own gh or a hub on 4790.
    const probes = doctor(hub);
    probes.health = async () => ({ ok: true });
    probes.runCmd = async () => ({ ran: false, error: "ENOENT" });
    const tools = new Registry();
    registerAll(tools);
    const owner = { keyId: "k", name: "k", prefix: "fld_x", grants: [{ role: "admin" as const, machines: "*" as const }], createdAt: AT };
    const out = await tools.call(hub, owner, "setup_list", {});
    if (!("output" in out)) throw new Error(JSON.stringify(out.error));
    const steps = (out.output as { steps: HubSetupStep[] }).steps;
    expect(steps.map((s) => s.id)).not.toContain("cloud");
    const machines = steps.find((s) => s.id === "machines");
    expect([machines?.status, machines?.failing ?? false]).toEqual(["done", false]);
    hub.shutdown.abort();
    db.conn.close();
  } finally {
    home.done();
  }
});
