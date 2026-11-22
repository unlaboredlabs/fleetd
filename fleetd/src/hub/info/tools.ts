// hub_info.
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { machineFingerprint } from "../../shared/fingerprint.ts";
import { VERSION } from "../../shared/version.ts";
import { isHuman, readable } from "../api/grants.ts";
import type { Registry } from "../api/registry.ts";
import { boxPublic } from "../auth/box_key.ts";
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
    // The apps probe the connection with hub_info: a box key that can't be read leaves the key out, not the answer.
    let boxPubKey: string | undefined;
    try {
      boxPubKey = boxPublic(hub);
    } catch (error) {
      console.error("hub_info: the hub's box key:", error);
    }
    return {
      admin: allowsEverywhere(caller, "admin"),
      ...(boxPubKey === undefined ? {} : { boxPubKey }),
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
      version: VERSION,
    };
  });
}
