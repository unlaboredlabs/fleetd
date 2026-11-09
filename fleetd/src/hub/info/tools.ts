// hub_info (crates/fleetd/src/hub/info.rs).
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { machineFingerprint } from "../../shared/fingerprint.ts";
import { VERSION } from "../../shared/version.ts";
import { isHuman, readable } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { reachableUrl } from "../hub_links/store.ts";
import { people } from "../people/store.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { BUSY_MAX, busy, channel } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("hub_info", (hub, caller, input) => {
    // A node restart cuts off only its own machine; the hub's own work (a merge in flight) goes on.
    const items = busy(hub).filter(
      (i) => (i.machineId === undefined || readable(caller, i.machineId)) && (input.machineId === undefined || i.machineId === input.machineId),
    );
    const me = isHuman(caller) && caller.person !== undefined ? people(hub).get(caller.person.personId) : undefined;
    const ch = channel(VERSION, process.env.FLEETD_VERSION !== undefined);
    const fingerprint = machineFingerprint();
    const url = reachableUrl(hub.url());
    return {
      admin: allowsEverywhere(caller, "admin"),
      busy: items.slice(0, BUSY_MAX),
      ...(ch === undefined ? {} : { channel: ch }),
      ...(fingerprint === undefined ? {} : { machineFingerprint: fingerprint }),
      ...(me === undefined ? {} : { me }),
      next:
        items.length === 0
          ? "Nothing runs: restarting the hub now interrupts nothing."
          : "Restarting now cuts each busy item off; it carries on by itself once the hub or node is back.",
      people: people(hub).count(),
      protocol: PROTOCOL_VERSION,
      ...(items.length > BUSY_MAX ? { truncated: true } : {}),
      ...(url === undefined ? {} : { url }),
      version: VERSION,
    };
  });
}
