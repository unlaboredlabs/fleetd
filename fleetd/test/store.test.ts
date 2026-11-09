import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate, userVersion } from "../src/hub/store/migrations.ts";
import { tempHome } from "./helpers.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "../src/hub/store/migrations");
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

test("every migration runs, in order, recorded with its file's SHA-256", () => {
  const home = tempHome();
  cleanup = home.done;
  const db = HubDb.open(home.dir);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  expect(MIGRATIONS.length).toBe(files.length);
  const ran = db.all<{ name: string; sha256: string }>("SELECT name, sha256 FROM migrations_applied");
  expect(ran.length).toBe(files.length);
  for (const r of ran) expect(r.sha256).toBe(sha256(readFileSync(join(MIGRATIONS_DIR, `${r.name}.sql`), "utf8")));
  expect(userVersion(db.conn)).toBe(files.length);
  expect(db.all("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
  expect(db.drift).toEqual([]);
  db.close();
  // Opening again runs nothing and finds no drift.
  const again = HubDb.open(home.dir);
  expect(again.drift).toEqual([]);
  again.close();
});

test("a changed or unknown applied migration is drift, and never runs again", () => {
  const conn = new Database(":memory:");
  migrate(conn, [{ name: "0001_a", sql: "CREATE TABLE a (x)" }, { name: "0002_b", sql: "CREATE TABLE b (x)" }]);
  const drift = migrate(conn, [{ name: "0001_a", sql: "CREATE TABLE a (x, y)" }]);
  expect(drift).toEqual([
    { kind: "changed", name: "0001_a" },
    { kind: "unknown", name: "0002_b" },
  ]);
});

test("a database from before migrations_applied counts its run migrations in user_version", () => {
  const conn = new Database(":memory:");
  conn.run("CREATE TABLE a (x)");
  conn.run("PRAGMA user_version = 1");
  migrate(conn, [{ name: "0001_a", sql: "CREATE TABLE a (x)" }, { name: "0002_b", sql: "CREATE TABLE b (x)" }]);
  expect(conn.query("SELECT name FROM migrations_applied ORDER BY name").all()).toEqual([{ name: "0001_a" }, { name: "0002_b" }]);
  expect(userVersion(conn)).toBe(2);
});

test("a long read runs on the worker, off the event loop, and sees committed writes", async () => {
  const home = tempHome();
  cleanup = home.done;
  const db = HubDb.open(home.dir);
  db.conn.run("CREATE TABLE n (i INTEGER)");
  db.transaction((c) => c.run("INSERT INTO n VALUES (1), (2), (3)"));
  expect(await db.read<{ s: number }>("SELECT sum(i) s FROM n")).toEqual([{ s: 6 }]);
  // A read that takes a while: the loop keeps ticking meanwhile.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const slow = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*) n FROM c";
  const [row] = await db.read<{ n: number }>(slow);
  clearInterval(timer);
  expect(row?.n).toBe(3000000);
  expect(ticks).toBeGreaterThan(5);
  // (Not `expect(…).rejects`: on Bun 1.4.3 it never settles for this promise.)
  const failed = await db.read("SELECT * FROM missing").catch((e: Error) => e.message);
  expect(String(failed)).toContain("no such table");
  db.close();
});
