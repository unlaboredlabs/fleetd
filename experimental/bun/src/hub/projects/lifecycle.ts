// Adding, removing and inspecting projects (crates/fleetd/src/hub/projects/tools.rs's project_discover, project_add,
// project_remove, and repos.rs), and their loops: a clone a restart cut off fails once, and closed orders' variables
// go (order_env.rs `run`).
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { events } from "../store/events.ts";
import { add, clones, failInterrupted, now } from "./add.ts";
import { discover } from "./discover.ts";
import * as orderEnv from "./order_env.ts";
import { remove } from "./remove.ts";
import * as repos from "./repos.ts";

export function register(tools: Registry): void {
  tools.add("project_discover", (hub, caller, input) => discover(hub, caller, input));
  tools.add("project_add", (hub, caller, input) => add(hub, caller, input));
  tools.add("project_remove", (hub, caller, input) => remove(hub, caller, input) as never);
  repos.register(tools);
}

/** At hub start, before any new clone: the clones a previous process never finished fail; then the order_env loop. */
export function start(hub: Hub): void {
  clones(hub);
  try {
    const n = failInterrupted(events(hub), now(hub));
    if (n > 0) console.info(`projects: ${n} clones cut off by the last restart marked failed`);
  } catch (error) {
    console.warn("projects: cut-off clones not checked:", error);
  }
  orderEnv.start(hub);
}
