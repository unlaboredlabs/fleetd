import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { sha256 } from "../src/hub/auth/index.ts";
import { Deflater } from "../src/hub/link/deflate.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import type { Grant } from "../src/shared/contracts.ts";

/** A fresh directory under $TMPDIR, removed by the returned function. Never the live hub's home. */
export function tempHome(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-bun-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

let migrated: Uint8Array | undefined;

/**
 * Writes `<dir>/hub.sqlite` already migrated, so `HubDb.open(dir)` (or a hub built on `dir`) only finds every migration
 * applied. Migrating a fresh file commits each of its migrations on its own and waits on fsync, which takes seconds on
 * a busy disk; this copies one database the run migrated once, by the hub's own runner, with fsync off. Not for the
 * tests of migrating itself (store.test.ts).
 */
export function seedHubDb(dir: string): string {
  if (!migrated) {
    const build = tempHome();
    const path = join(build.dir, "hub.sqlite");
    const conn = new Database(path, { create: true, strict: true });
    conn.run("PRAGMA synchronous = OFF");
    conn.run("PRAGMA journal_mode = WAL");
    migrate(conn, MIGRATIONS);
    conn.close();
    migrated = readFileSync(path);
    build.done();
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "hub.sqlite"), migrated, { flag: "wx" });
  return dir;
}

/**
 * `HubDb.open` on `dir`, a fresh home, from the run's migrated copy (`seedHubDb`), and `noSync`: a test's database
 * outlives no crash.
 */
export const openHubDb = (dir: string): HubDb => noSync(HubDb.open(seedHubDb(dir)));

/**
 * Turns fsync off on the database's connection: the WAL checkpoints a close or a long test runs fsync twice each, and a
 * busy disk takes up to seconds per fsync. Nothing a test checks reads durability.
 */
export function noSync<T extends { conn: Database } | { db: Database }>(store: T): T {
  ("conn" in store ? store.conn : store.db).run("PRAGMA synchronous = OFF");
  return store;
}

/** A fresh home under $TMPDIR, as `tempHome`, whose hub.sqlite is already migrated (`seedHubDb`). */
export function hubHome(): { dir: string; done: () => void } {
  const home = tempHome();
  seedHubDb(home.dir);
  return home;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Inserts an agent key the way the Rust hub stores one (its SHA-256), and returns the key. */
export function insertKey(db: HubDb, grants: Grant[], name = "test"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(52));
  const key = `fld_${[...bytes].map((b) => BASE32[b % 32]).join("")}`;
  db.conn
    .query("INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES (?, ?, ?, ?, ?, ?, 'agent')")
    .run(`key_${name}`, sha256(key), key.slice(0, 10), name, JSON.stringify(grants), Date.now());
  return key;
}

/**
 * A deflate bomb as one link message: `mib` MiB of zeros through a Deflater, a MiB a message, joined into one with each
 * message's cut `00 00 ff ff` put back between them. A few KiB that inflate to `mib` MiB.
 */
export async function deflateBomb(mib: number): Promise<Buffer> {
  const d = new Deflater();
  const zeros = "\0".repeat(1 << 20);
  const tail = Buffer.from([0x00, 0x00, 0xff, 0xff]);
  const parts: Buffer[] = [];
  for (let i = 0; i < mib; i++) parts.push(...(i ? [tail] : []), await d.deflate(zeros));
  d.close();
  return Buffer.concat(parts);
}
