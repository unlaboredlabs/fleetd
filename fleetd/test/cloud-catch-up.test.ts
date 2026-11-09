// Ports crates/fleetd/src/hub/cloud/tests.rs's a_cloud_machine_whose_first_hello_is_degraded_is_caught_up: the
// catch-up loop over a real event log, with the node's link and the hub's updates faked.
import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { run } from "../src/hub/cloud/catch_up.ts";
import { cloud } from "../src/hub/cloud/index.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";

/**
 * A new cloud machine's first hello finds its claude not logged in, so the hub logs machine.degraded, never
 * machine.online: the catch-up that brings the hub's Claude configuration waited for one of those, so boat-1 never
 * became ready and the pool deleted it as never joined (Nov 8 and 9). Its degraded hello starts the catch-up too.
 */
test("a cloud machine whose first hello is degraded is caught up", async () => {
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => Date.parse("2026-11-09T10:17:39Z") });
  hub.db.conn.run("INSERT INTO node_keys (machine_id, pub_key, pool) VALUES ('boat-1', 'k', 1)");
  // boat-1's node is linked, live since 1; the hub runs no release build, so there is nothing to update.
  hub.area("executors", () => ({ liveSince: (m: string) => (m === "boat-1" ? 1 : undefined), awaitLive: async () => {} }) as never);
  hub.area("updates", () => ({ catchUp: async () => "current" }) as never);
  hub.area("pool", () => ({}) as never);
  cloud(hub).cloning.ensure = () => {};
  const loop = run(hub);
  try {
    await Bun.sleep(0);
    expect(cloud(hub).ready("boat-1")).toBe(false);
    events(hub).append({
      at: "2026-11-09T10:17:39.987Z",
      type: "machine.degraded",
      machineId: "boat-1",
      summary: "boat-1 is degraded: claude is not logged in",
    } as never);
    for (let i = 0; i < 200 && !cloud(hub).ready("boat-1"); i++) await Bun.sleep(5);
    expect(cloud(hub).ready("boat-1")).toBe(true);
  } finally {
    hub.shutdown.abort();
    await loop;
  }
});
