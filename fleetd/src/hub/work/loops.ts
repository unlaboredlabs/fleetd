import type { Hub } from "../api/hub.ts";
import { leadWiring } from "../leads/ports.ts";
import { sweep } from "../sweep/index.ts";
import { run as bindRun } from "./bind.ts";
import { work } from "./index.ts";
import { landingStore, run as landingsRun } from "./landings.ts";

/**
 * Starts this module's loops (Rust: work::bind::run, work::landings::run, and the sweep's `work-claims` check): binds
 * projects at start and as their nodes connect, expires claims on every sweep, and reads landings from their table.
 * It also gives the leads' digest its Elsewhere lines (hooks.rs `elsewhere`).
 */
export function start(hub: Hub): void {
  const w = work(hub);
  w.setLandings(landingStore(hub.db.conn));
  leadWiring(hub).hooks.elsewhere = (r) => {
    try {
      return w.elsewhere(r);
    } catch (error) {
      console.warn("work: the digest's Elsewhere lines not read:", error);
      return undefined;
    }
  };
  sweep(hub).register({ name: "work-claims", run: () => void w.expireDue() });
  bindRun(hub).catch((error) => console.warn(`work: bind loop stopped: ${error}`));
  landingsRun(hub);
}
