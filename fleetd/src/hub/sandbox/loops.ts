// The team's hosted providers' limits and keys reach each machine that makes sandboxes as it links (a provider
// disconnected while it was away goes from it then), and the slot board as the hub starts.
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { sendLimits } from "./index.ts";

export function start(hub: Hub): void {
  try {
    sendLimits(hub, []);
  } catch (error) {
    console.warn("sandbox: limits not read at start:", error);
  }
  link(hub).onLinked(({ machineId }) => {
    try {
      // sendLimits sends only to a machine whose hello listed CAP_SANDBOX.
      sendLimits(hub, [machineId]);
    } catch (error) {
      console.warn("sandbox: limits not read for a linked machine:", error);
    }
  });
}
