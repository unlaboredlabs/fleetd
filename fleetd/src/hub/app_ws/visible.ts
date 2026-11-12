// Which events a key reads, as events_wait and the app's stream filter them:
// events on machines it can read (`can_read`), and never another person's sidebar order, pins or sections
// (sidebar_order `someone_elses`).
import type { HubEvent } from "../../shared/contracts.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";

/** Another person's sidebar order, pins and sections are theirs alone (W214, W232, W580). */
export function someoneElses(caller: Caller, event: HubEvent): boolean {
  if (event.type !== "sidebar.order" && event.type !== "chat.pins" && event.type !== "chat.sections") return false;
  const whose = (event.data as { personId?: unknown } | undefined)?.personId;
  const me = caller.kind === "human" ? caller.person?.personId : undefined;
  // Data that doesn't decode (a malformed PersonId) is nobody's to see, as the Rust hub reads it.
  return typeof whose !== "string" || !/^p_[a-z2-7]{8}$/.test(whose) || me === undefined || whose !== me;
}

/** Whether `caller` reads `event`. */
export function visible(caller: Caller, event: HubEvent): boolean {
  return (event.machineId === undefined || allows(caller, "read", event.machineId)) && !someoneElses(caller, event);
}
