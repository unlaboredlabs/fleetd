import type { Hub } from "../api/hub.ts";
import { every } from "../sweep/index.ts";
import { DOCTOR_TICK_MS, doctor } from "./index.ts";

/**
 * The doctor's run (Rust: the third loop of usage::wire::start): each minute, every check when the last run is 15 min
 * old, else the machines whose status moved since. Stops on `hub.shutdown`.
 */
export function startDoctor(hub: Hub): void {
  every(hub, DOCTOR_TICK_MS, () => doctor(hub).runIfDue());
}
