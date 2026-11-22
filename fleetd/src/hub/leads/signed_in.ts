// A lead whose last turn Claude refused for its sign-in (`signed_out` in ./cut_off.ts) carries on by itself once a
// Claude account is connected again (Settings › Accounts › Claude, or the hub's API key): a wake, once per
// reconnect, to each lead whose thread's newest end is that refusal. Nothing else wakes it, so a sign-in that stays
// broken never loops.
import type { Hub } from "../api/hub.ts";
import { end, SIGNED_IN_LINE } from "./cut_off.ts";
import { leads } from "./index.ts";
import { newestFirst } from "./start_retry.ts";
import type { StoredLead } from "./stored.ts";

/** Whether the newest end of `lead`'s thread is a turn Claude refused for its sign-in. */
export function signedOut(hub: Hub, lead: StoredLead): boolean {
  for (const e of newestFirst(hub, lead.projectRef)) {
    const found = end(e, [lead]);
    if (found) return found.end.kind === "signed_out";
  }
  return false;
}

/** A Claude account was connected again: every lead it refused carries on. */
export function signedInAgain(hub: Hub): void {
  const area = leads(hub);
  for (const lead of area.records.leadsList()) {
    if (signedOut(hub, lead)) area.wakes.trigger(lead.projectRef, { kind: "line", line: "cut_off", text: SIGNED_IN_LINE });
  }
}
