import type { Hub } from "../api/hub.ts";
import { run } from "./catch_up.ts";

/** Starts this module's loop (Rust: cloud::catch_up::run): each cloud machine caught up as its node links. */
export function start(hub: Hub): void {
  void run(hub).catch((e) => console.error("cloud catch-up: its loop stopped:", e));
}
