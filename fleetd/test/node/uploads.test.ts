// A node's recordings still on their way to the hub: the heartbeat's `busy.uploads`.
import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uploads } from "../../src/node/uploads.ts";
import { tempHome } from "../helpers.ts";

test("a recording that ended and hasn't reached the hub waits; one still recording or long ago doesn't count", () => {
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
  } finally {
    home.done();
  }
});
