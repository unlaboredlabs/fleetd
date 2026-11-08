import type { Hub } from "../api/hub.ts";
import { run } from "./sessions.ts";

/** Starts this module's loops (Rust: github_app::sessions::run): the orders' tokens renew on every sweep. */
export function start(hub: Hub): void {
  run(hub);
}
