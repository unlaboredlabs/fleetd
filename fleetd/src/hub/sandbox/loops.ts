// The team's hosted providers' limits reach each machine that makes sandboxes as it links: its node keeps them only
// in memory, and a restart forgets them.
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { limits, sendLimits } from "./index.ts";

export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => {
    try {
      // sendLimits sends only to a machine whose hello listed CAP_SANDBOX.
      if (limits(hub).length > 0) sendLimits(hub, [machineId]);
    } catch (error) {
      console.warn("sandbox: limits not read for a linked machine:", error);
    }
  });
}
