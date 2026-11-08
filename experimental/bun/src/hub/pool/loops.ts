import type { Hub } from "../api/hub.ts";
import { cloud } from "../cloud/index.ts";
import { type Room as TaskRoom, taskHooks } from "../tasks/ports.ts";
import { type Room, room, wakeForWork } from "./place.ts";
import { pool } from "./tools.ts";

/** Starts this module's loop (Rust: pool::run): the sweep at start and every 10 minutes, the life loop every 30 s. Fills
 * in the tasks area's cloud hooks (tasks wire.rs `cloud_room`, `cloud_wake`, `cloud_claim`), so new tasks can run on
 * cloud machines. */
export function start(hub: Hub): void {
  taskHooks(hub).pool = {
    room: (task, checkout) => taskRoom(room(hub, pool(hub), cloud(hub).cloning, task, checkout)),
    wake(machine) {
      try {
        return { machine: wakeForWork(pool(hub), machine) };
      } catch (e) {
        return { why: e instanceof Error ? e.message : String(e) };
      }
    },
    claim: (machine) => pool(hub).claim(machine),
  };
  void pool(hub)
    .run(hub.shutdown.signal)
    .catch((e) => console.error("pool: its loop stopped:", e));
}

/** Placement's room as the tasks area reads it: `true`, or why not (nothing to say: cloud machines are off). */
export function taskRoom(r: Room): TaskRoom {
  const { eligible, ...rest } = r;
  return { ...rest, eligible: "yes" in eligible ? true : eligible.no === undefined ? {} : { why: eligible.no } };
}
