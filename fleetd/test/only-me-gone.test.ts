// Only me is gone (D491): a hub from before it upgrades with its former Only me projects made ordinary, archived on a
// hub with more than one person; a second person then lists, opens and uses one; and a removed person's projects stay.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { Hub } from "../src/hub/api/hub.ts";
import type { Caller } from "../src/hub/api/registry.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { allowPasted } from "../src/hub/project_lead/tools.ts";
import * as kept from "../src/hub/project_lead/store.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { tempHome } from "./helpers.ts";
import { AT, key, kit, project } from "./work-kit.ts";

const ARCHIVED_BEFORE = 1_000;

/**
 * A hub at the migration before Only me went: Ada's Only me project `notes`, her Only me project `old` she had
 * archived already, a shared project `shop`, and `people` live on the hub (Cy, removed, never counts).
 */
function upgraded(dir: string, people: string[]): HubDb {
  const conn = new Database(join(dir, "hub.sqlite"), { create: true, strict: true });
  conn.run("PRAGMA synchronous = OFF");
  const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_only_me_gone"));
  expect(at).toBeGreaterThan(0);
  migrate(conn, MIGRATIONS.slice(0, at));
  const names: Record<string, string> = { p_adaadaad: "Ada", p_bobobobo: "Bo" };
  for (const [i, p] of people.entries()) conn.run(`INSERT INTO people (person_id, name, role, created_ms) VALUES ('${p}', '${names[p]}', '${i === 0 ? "owner" : "member"}', ${i})`);
  conn.run("INSERT INTO people (person_id, name, role, created_ms, removed_ms) VALUES ('p_cycycycy', 'Cy', 'member', 9, 10)");
  const devbox = { machineId: "devbox", name: "devbox", tags: [], status: "offline", lastSeenAt: AT, nodeVersion: "1.0.0" };
  conn.run(`INSERT INTO machines (machine_id, data) VALUES ('devbox', '${JSON.stringify(devbox)}')`);
  for (const p of ["notes", "old", "shop"]) {
    conn.run(
      `INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', '${p}', '${p}', '${AT}',
         '${JSON.stringify({ machineId: "devbox", projectId: p, title: p, workspaceRoot: `/home/me/${p}`, threads: { running: 0, idle: 0, failed: 0 }, lastActivityAt: AT })}')`,
    );
  }
  conn.run(`INSERT INTO project_settings (machine_id, project_id, only_me, owner_person, archived_ms) VALUES
    ('devbox', 'notes', 1, 'p_adaadaad', NULL), ('devbox', 'old', 1, 'p_adaadaad', ${ARCHIVED_BEFORE}), ('devbox', 'shop', 0, NULL, NULL)`);
  conn.close();
  return HubDb.open(dir);
}

const settings = (db: HubDb) =>
  Object.fromEntries(
    db.conn
      .query<{ project_id: string; only_me: number; archived_ms: number | null }, []>("SELECT project_id, only_me, archived_ms FROM project_settings")
      .all()
      .map((r) => [r.project_id, { onlyMe: r.only_me, archived: r.archived_ms === null ? null : r.archived_ms === ARCHIVED_BEFORE ? "before" : "now" }]),
  );

test("on a one-person hub, former Only me projects become ordinary and nothing visible changes", () => {
  const home = tempHome();
  try {
    const db = upgraded(home.dir, ["p_adaadaad"]);
    expect(db.drift).toEqual([]);
    expect(settings(db)).toEqual({
      notes: { onlyMe: 0, archived: null },
      old: { onlyMe: 0, archived: "before" },
      shop: { onlyMe: 0, archived: null },
    });
    db.conn.close();
  } finally {
    home.done();
  }
});

test("on a hub with more than one person, they are archived too; a second person lists, opens and uses one", async () => {
  const home = tempHome();
  try {
    const db = upgraded(home.dir, ["p_adaadaad", "p_bobobobo"]);
    expect(settings(db)).toEqual({
      notes: { onlyMe: 0, archived: "now" },
      old: { onlyMe: 0, archived: "before" },
      shop: { onlyMe: 0, archived: null },
    });

    const hub = new Hub({ home: home.dir, listen: { host: "127.0.0.1", port: 0 } }, db, { now: () => Date.parse(AT) });
    const tools = new Registry();
    registerAll(tools);
    const ok = async (caller: Caller, tool: string, input: unknown): Promise<Record<string, any>> => {
      const out = await tools.call(hub, caller, tool, input);
      if ("error" in out) throw new Error(`${tool}: ${JSON.stringify(out.error)}`);
      return out.output as Record<string, any>;
    };
    const bo = key("operate", { human: true, person: { personId: "p_bobobobo", name: "Bo" }, name: "bo" });
    const notes = { machineId: "devbox", projectId: "notes" };

    // Bo lists Ada's former Only me project, archived, with no Only me or owner on it, and opens it.
    const listed = (await ok(bo, "project_get", {})).projects as Record<string, unknown>[];
    expect(listed.map((p) => p.projectId).sort()).toEqual(["notes", "old", "shop"]);
    const one = (await ok(bo, "project_get", notes)).project as Record<string, unknown>;
    expect(one).toMatchObject({ projectId: "notes", archivedAt: expect.any(String) });
    expect(one).not.toHaveProperty("onlyMe");
    expect(one).not.toHaveProperty("owner");
    expect(await ok(bo, "chat_history", { projectRef: notes, limit: 10 })).toMatchObject({ messages: [] });

    // And uses it: brings it back, gives its bot a color, reads its orders, approvals and vault.
    expect((await ok(bo, "project_archive", { ...notes, archived: false })).project.archivedAt).toBeUndefined();
    expect((await ok(bo, "project_settings_set", { ...notes, avatarColor: "teal" })).next).toBe("Its bot is teal on every device now.");
    expect((await ok(bo, "vault_list", notes)).items).toEqual([]);
    expect((await ok(bo, "workstream_list", notes)).workstreams).toEqual([]);
    expect((await ok(bo, "requests_list", { projectRef: notes })).requests).toEqual([]);
    expect((await ok(bo, "project_approvals", notes)).approvals.mode).toBeDefined();
    hub.shutdown.abort();
    db.conn.close();
  } finally {
    home.done();
  }
});

test("a removed person's projects stay as they are, unarchived and listed for everyone", async () => {
  const k = kit();
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_ownownow', 'Own', 'owner', 0), ('p_adaadaad', 'Ada', 'member', 1)");
  const notes = { machineId: "devbox", projectId: "notes" };
  project(k.hub, notes, { title: "Notes" });
  k.hub.db.conn.run("INSERT INTO project_settings (machine_id, project_id, only_me, owner_person) VALUES ('devbox', 'notes', 0, 'p_adaadaad')");
  const own = key("admin", { human: true, person: { personId: "p_ownownow", name: "Own" }, name: "own" });
  await k.ok(own, "person_remove", { personId: "p_adaadaad" });
  expect(kept.archived(k.hub.db.conn, notes)).toBe(false);
  expect(((await k.ok(own, "project_get", {})).projects as { projectId: string }[]).map((p) => p.projectId)).toEqual(["notes"]);
  expect((await k.ok(own, "people_list", {})).left).toBeUndefined();
});

test("a person's pasted link allows its site in any project", () => {
  const k = kit();
  const shop = { machineId: "devbox", projectId: "shop" };
  project(k.hub, shop);
  allowPasted(k.hub, shop, "see https://docs.example.org/a", "human:desk");
  expect(kept.siteAllowed(k.hub.db.conn, shop, "docs.example.org")).toBe(true);
});
