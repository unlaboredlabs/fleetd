// `fleetd node flush` (Rust's node/flush.rs): boat's pre-stop hook holds the agents between steps, waits for the
// recordings still on their way, checkpoints the node's database and syncs the disk, then says what it left.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flush, uploads } from "../../src/node/flush.ts";
import { holdPath } from "../../src/node/hold.ts";
import { tempHome } from "../helpers.ts";

test("a flush holds the agents, checkpoints the database and says what waits", async () => {
  const home = tempHome();
  try {
    const db = new Database(join(home.dir, "sessions.sqlite"));
    db.run("PRAGMA journal_mode=WAL");
    db.run("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
    expect(await flush(home.dir, 0)).toBe("flushed: agents held between steps, no recording waits, database checkpointed, disk synced");
    db.close();
    expect(existsSync(holdPath(home.dir))).toBe(true);
    const wal = join(home.dir, "sessions.sqlite-wal");
    expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
  } finally {
    home.done();
  }
});

test("a recording that ended and hasn't reached the hub waits; one still recording or long ago doesn't count", async () => {
  const home = tempHome();
  try {
    const put = (root: string, name: string, meta: Record<string, unknown>) => {
      const dir = join(home.dir, root, "recordings", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "session.json"), JSON.stringify(meta));
      return dir;
    };
    put("browser", "b1", { endedAt: "2026-11-08T10:00:00Z" });
    put("device", "d1", { endedAt: "2026-11-08T10:00:00Z" });
    put("desktop", "x1", {});
    const old = put(join("device", "ios"), "i1", { endedAt: "2026-11-08T10:00:00Z" });
    const longAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(old, "session.json"), longAgo, longAgo);
    utimesSync(old, longAgo, longAgo);
    expect(uploads(home.dir)).toBe(2);
    expect(await flush(home.dir, 0)).toBe("flushed: agents held between steps, 2 recordings wait for the next wake, database checkpointed, disk synced");
  } finally {
    home.done();
  }
});
