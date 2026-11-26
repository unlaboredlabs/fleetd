// Whether a workspace can run anything yet, from its own state: a computer of its own joined (neither the agents' Mac
// nor a runner), or fleetd's computers on a plan or credits (GET /billing/v1, Billing's top line clear, as Get started
// reads it). One that can't opens on Get started wherever it would show the empty home (setup/FirstRun), however often
// Get started was skipped before (W917).
import { topLine } from "../../../shared/billing";
import { useData, useHub } from "../../src/data/react";
import { useBilling } from "../admin/billingQuery";

/**
 * True: no computer of its own and no plan or credits; false: one of them; undefined until the workspace has said.
 * Billing that can't be read is no plan, as on the phone. A self-hosted workspace has no plan: its machines alone.
 */
export const useRunsNothing = (): boolean | undefined => {
  const cloud = useHub().cloud === true;
  const fresh = useData((d) => d.fresh);
  const own = useData((d) => Object.values(d.machines).some((m) => m.agentsMac !== true && m.runner !== true));
  const billing = useBilling(cloud && fresh && !own);
  if (!fresh) return undefined;
  if (own) return false;
  if (!cloud) return true;
  if (billing.data === undefined) return billing.error === null ? undefined : true;
  return !(billing.data.providedOn && topLine(billing.data) === null);
};
