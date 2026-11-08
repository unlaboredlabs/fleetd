// Which events a key reads, as events_wait and the app's stream filter them (crates/fleetd/src/hub/api/m1.rs):
// events on machines it can read (`can_read`), never another person's Only me project's (navi/owner's `others` and
// `about`), and never another person's sidebar order or pins (sidebar_order `someone_elses`).
import type { HubEvent } from "../../shared/contracts.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { about, others, type Refs } from "../navi/owner.ts";
import type { HubDb } from "../store/db.ts";

export { others };
export type Others = Refs;

/** Another person's sidebar order and pins are theirs alone (W214, W232). */
export function someoneElses(caller: Caller, event: HubEvent): boolean {
  if (event.type !== "sidebar.order" && event.type !== "chat.pins") return false;
  const whose = (event.data as { personId?: unknown } | undefined)?.personId;
  const me = caller.kind === "human" ? caller.person?.personId : undefined;
  // Data that doesn't decode (a malformed PersonId) is nobody's to see, as the Rust hub reads it.
  return typeof whose !== "string" || !/^p_[a-z2-7]{8}$/.test(whose) || me === undefined || whose !== me;
}

/** Whether `caller` reads `event`, with `navis` from `others` read for this page. */
export function visible(db: HubDb, caller: Caller, navis: Others, event: HubEvent): boolean {
  return (
    (event.machineId === undefined || allows(caller, "read", event.machineId)) &&
    !about(db, navis, event) &&
    !someoneElses(caller, event)
  );
}
