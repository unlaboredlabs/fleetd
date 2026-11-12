import type { Hub } from "../api/hub.ts";
import { found } from "../project_lead/bridge.ts";
import { ask, run, status } from "./client.ts";
import { linked } from "./index.ts";

/**
 * Starts this module's loops (Rust: hub_links::client::run): a follower for every kept link that still works. And
 * hands the ask bridge what it reaches here: an ask or a status over a kept link, and a project's linked hubs.
 */
export function start(hub: Hub): void {
  Object.assign(found, { ask, status, linked });
  run(hub);
}
