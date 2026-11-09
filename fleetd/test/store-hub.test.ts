// The hub store (its machine tests; hub/projects/icon_tests.rs's derived icon).
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HubDb } from "../src/hub/store/db.ts";
import { HubStore, MACHINE_KEEPS, MACHINE_TABLES } from "../src/hub/store/hub_store.ts";
import { derived } from "../src/hub/projects/icon.ts";
import type { ProjectSummary, ThreadSummary } from "../src/shared/contracts.ts";

type Column = { name: string; type: string; nullable: boolean };

const MACHINE_COLUMNS = ["machine_id", "checkout_machine_id", "from_machine_id", "to_machine_id", "origin_machine", "on_machine"];

/** Every table that names a machine, with its columns. */
function machineTables(c: Database): [string, Column[]][] {
  const tables = c.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  const out: [string, Column[]][] = [];
  for (const { name: t } of tables) {
    const columns = c
      .query<{ name: string; type: string; nullable: number }, []>(
        `SELECT name, type, "notnull" = 0 AND pk = 0 AS nullable FROM pragma_table_info('${t}')`,
      )
      .all()
      .map((r) => ({ name: r.name, type: r.type, nullable: Boolean(r.nullable) }));
    if (columns.some((col) => MACHINE_COLUMNS.includes(col.name))) out.push([t, columns]);
  }
  return out;
}

/** A row of `machine`'s in each of `tables`, under project `p-shared` and thread `t-shared`. */
function seedMachine(c: Database, tables: [string, Column[]][], machine: string, n: number): void {
  for (const [t, columns] of tables) {
    const values = columns.map(({ name, type, nullable }) => {
      if (["project_id", "checkout_project_id", "from_project_id", "to_project_id"].includes(name)) return "'p-shared'";
      if (name === "thread_id" || name === "origin_thread") return "'t-shared'";
      if (name.includes("machine")) return `'${machine}'`;
      if (nullable) return "NULL";
      if (name === "kind" && type.includes("TEXT")) return "'plain'";
      if (["data", "items", "refs", "projects", "workstreams"].includes(name)) return "'{}'";
      if (type.includes("INT") || type.includes("REAL")) return String(n);
      return `'${machine}-${name}'`;
    });
    c.run(`INSERT INTO ${t} (${columns.map((col) => col.name).join(", ")}) VALUES (${values.join(", ")})`);
  }
}

function machineRows(c: Database, tables: [string, Column[]][], t: string, machine: string): number {
  const columns = tables.find(([name]) => name === t)?.[1] ?? [];
  const column = ["machine_id", "from_machine_id", "origin_machine"].find((col) => columns.some((x) => x.name === col));
  return c.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${column} = ?`).get(machine)?.n ?? 0;
}

const tableList = (list: readonly string[]) => list as readonly string[];

test("removing a machine forgets its rows and leaves another's with the same project ids", () => {
  const db = HubDb.memory();
  const store = new HubStore(db);
  const tables = machineTables(db.conn);
  for (const [t, columns] of tables) {
    const byId = columns.some((col) => col.name === "machine_id");
    const ownRule = ["repos", "navi_asks", "session_places", "slot_claims"].includes(t);
    expect(tableList(MACHINE_TABLES).includes(t) || tableList(MACHINE_KEEPS).includes(t) || ownRule).toBe(true);
    expect(byId || ownRule).toBe(true);
  }
  seedMachine(db.conn, tables, "devbox", 1);
  seedMachine(db.conn, tables, "worker", 2);

  expect(store.machineRemove("worker")).toBeGreaterThan(0);
  for (const [t] of tables) {
    expect([t, machineRows(db.conn, tables, t, "devbox")]).toEqual([t, 1]);
    expect([t, machineRows(db.conn, tables, t, "worker")]).toEqual([t, tableList(MACHINE_KEEPS).includes(t) ? 1 : 0]);
  }
  // Run again, as over what an older remove left behind, it finds nothing more.
  expect(store.machineRemove("worker")).toBe(0);
});

test("forgetting a removed machine's project leaves its other project and another's with the same id", () => {
  const db = HubDb.memory();
  const store = new HubStore(db);
  const tables = machineTables(db.conn);
  seedMachine(db.conn, tables, "devbox", 1);
  seedMachine(db.conn, tables, "worker", 2);
  db.conn.run(`INSERT INTO projects (machine_id, project_id, search, last_activity_at, data)
               VALUES ('worker', 'p-other', '', '', '{}');
             INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, data)
               VALUES ('worker', 't-other', 'p-other', '', '{}');
             INSERT INTO thread_accounts (machine_id, thread_id, account) VALUES ('worker', 't-other', 'a');`);
  const r = { machineId: "worker", projectId: "p-shared" };

  expect(store.machineProjectForget(r)).toBeGreaterThan(0);
  for (const [t, columns] of tables) {
    const has = (c: string) => columns.some((col) => col.name === c);
    expect([t, machineRows(db.conn, tables, t, "devbox")]).toEqual([t, 1]);
    const ownRule = ["repos", "navi_asks", "session_places"].includes(t);
    const forgot =
      !tableList(MACHINE_KEEPS).includes(t) && (ownRule || (tableList(MACHINE_TABLES).includes(t) && (has("project_id") || has("thread_id"))));
    const other = ["projects", "threads", "thread_accounts"].includes(t) ? 1 : 0;
    expect([t, machineRows(db.conn, tables, t, "worker")]).toEqual([t, (forgot ? 0 : 1) + other]);
  }
  expect(store.machineProjectForget(r)).toBe(0);
  expect(() => store.machineProjectForget({ machineId: "", projectId: "x" })).toThrow();
});

const project = (projectId: string, at: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  machineId: "devbox",
  projectId,
  title: `Project ${projectId}`,
  workspaceRoot: `/home/me/${projectId}`,
  threads: { running: 0, idle: 0, failed: 0 } as ProjectSummary["threads"],
  lastActivityAt: at,
  ...extra,
});

test("an unpicked icon is derived from its id, the same as the Rust hub's", () => {
  // Pinned in the Rust tests: a change here would give every existing project and Navi another face.
  expect(derived({ machineId: "devbox", projectId: "app" })).toEqual({ face: "wink", color: "teal" });
});

test("projects keep the node's report and wear what the hub keeps of them", () => {
  const db = HubDb.memory();
  const store = new HubStore(db);
  // The hub's own fields in a node's report are dropped: the hub serves them from its tables.
  store.projectsUpsertMany("devbox", [
    project("app", "2026-10-17T10:00:00.000Z", { onlyMe: true, owner: "p1", avatar: "x" }),
    project("site", "2026-10-18T10:00:00.000Z"),
  ]);
  const stored = JSON.parse(
    db.conn.query<{ data: string }, []>("SELECT data FROM projects WHERE project_id = 'app'").get()?.data ?? "",
  );
  expect(stored.onlyMe).toBeUndefined();
  expect(store.projectsList().map((p) => p.projectId)).toEqual(["site", "app"]);
  expect(store.projectsList(undefined, "SITE").map((p) => p.projectId)).toEqual(["site"]);
  expect(store.projectsList(undefined, "%")).toEqual([]);
  expect(store.projectsList("other")).toEqual([]);

  const app = { machineId: "devbox", projectId: "app" };
  expect(store.projectGet(app)).toEqual({ ...project("app", "2026-10-17T10:00:00.000Z"), icon: derived(app) });

  // Only me, its maker, owner, archive, picture and icon come from the hub's rows.
  db.conn.run(`INSERT INTO project_settings (machine_id, project_id, only_me, created_by_key, created_by_name, owner_person, archived_ms)
               VALUES ('devbox', 'app', 1, 'key_1', 'phone', 'p1', 0)`);
  db.conn.run("INSERT INTO project_avatars (machine_id, project_id, avatar, jpeg, set_ms) VALUES ('devbox', 'app', 'abc', x'00', 0)");
  db.conn.run("INSERT INTO project_icons (machine_id, project_id, face, color, set_ms) VALUES ('devbox', 'app', 'joy', 'sun', 0)");
  expect(store.projectGet(app)).toEqual({
    ...project("app", "2026-10-17T10:00:00.000Z"),
    onlyMe: true,
    kind: "assistant",
    createdBy: { keyId: "key_1", name: "phone" },
    owner: "p1",
    archivedAt: "1970-01-01T00:00:00.000Z",
    avatar: "abc",
    icon: { face: "joy", color: "sun" },
  });

  // A project bound to a repo gets its own repo row, and a checkout another holds is left out of what people see.
  db.conn.run("INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES ('devbox', 'site', 'github.com/acme/My_Site', 'main', 0)");
  store.projectsUpsertMany("devbox", [project("site", "2026-10-18T10:00:00.000Z")]);
  expect(store.projectGet({ machineId: "devbox", projectId: "site" })?.repos).toEqual([
    {
      repoId: "R1",
      name: "my-site",
      checkout: { machineId: "devbox", projectId: "site" },
      repoKey: "github.com/acme/My_Site",
      base: "main",
      path: "/home/me/site",
    },
  ]);
  db.conn.run(`INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id)
               VALUES ('devbox', 'app', 'site', 'devbox', 'site')`);
  expect(store.projectsShown().map((p) => p.projectId)).toEqual(["app"]);
  expect(store.projectsList().map((p) => p.projectId)).toEqual(["site", "app"]);

  store.projectRemove(app);
  expect(store.projectGet(app)).toBeUndefined();
  expect(db.conn.query("SELECT * FROM repos WHERE project_id = 'app'").all()).toEqual([]);
});

test("machines and threads", () => {
  const db = HubDb.memory();
  const store = new HubStore(db);
  const machine = { machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online" as const, lastSeenAt: "a" };
  store.machineUpsert(machine, "pk");
  expect(store.machinesList()).toEqual([machine]);
  store.machineSetStatus("devbox", "offline", "b");
  expect(store.machineGet("devbox")).toEqual({ ...machine, status: "offline", lastSeenAt: "b" });
  store.machineSetStatus("nobody", "offline", "b");
  expect(store.machineGet("nobody")).toBeUndefined();

  const thread = (threadId: string, status: string, at: string) =>
    ({
      asOf: at,
      headline: "",
      lastProgressAt: at,
      latestMessageTail: "",
      machineId: "devbox",
      projectId: "app",
      stale: false,
      status,
      threadId,
      title: threadId,
    }) as ThreadSummary;
  store.threadUpsert({ thread: thread("t1", "running", "1"), lastSequence: 4, lastRunId: "r1" });
  store.threadUpsert({ thread: thread("t2", "idle", "2") });
  // An absent sequence or run keeps the stored one.
  store.threadUpsert({ thread: thread("t1", "running", "3"), lastRunStatus: "running" });
  expect(store.threadGet({ machineId: "devbox", threadId: "t1" })).toEqual({
    thread: thread("t1", "running", "3"),
    lastSequence: 4,
    lastRunId: "r1",
    lastRunStatus: "running",
  });
  expect(store.threadsRunning().map((t) => t.threadId)).toEqual(["t1"]);
  expect(store.threadsByProject({ machineId: "devbox", projectId: "app" }, 10).map((t) => t.threadId)).toEqual(["t1", "t2"]);
  expect(store.threadsMarkStale("devbox", new Set(["t2"]), "4")).toBe(1);
  expect(store.threadsRunning()).toEqual([]);
  expect(store.threadGet({ machineId: "devbox", threadId: "t1" })?.thread).toEqual({ ...thread("t1", "running", "3"), stale: true, asOf: "4" });

  expect(store.cursorGet("devbox")).toBeUndefined();
  store.cursorSet("devbox", 9);
  expect(store.cursorGet("devbox")).toBe(9);
});
