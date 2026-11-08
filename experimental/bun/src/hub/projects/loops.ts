import type { Hub } from "../api/hub.ts";
import * as lifecycle from "./lifecycle.ts";

/** Starts this module's loops (Rust: projects::order_env::run); each stops on `hub.shutdown`. */
export function start(hub: Hub): void {
  lifecycle.start(hub);
}
