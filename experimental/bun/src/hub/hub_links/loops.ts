import type { Hub } from "../api/hub.ts";
import { run } from "./client.ts";

/** Starts this module's loops (Rust: hub_links::client::run): a follower for every kept link that still works. */
export function start(hub: Hub): void {
  run(hub);
}
