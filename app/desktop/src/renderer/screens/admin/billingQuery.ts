// The team's billing as the cloud answers it (GET /billing/v1), read where it is needed: the Billing page, whether
// Settings shows it, and Get started's first step (fleetd's computers), which mustn't pull the page into the web app's
// first load.
import { useQuery } from "@tanstack/react-query";
import { billingOn, type BillingState } from "../../../shared/billing";
import type { PairFailure } from "../../../shared/pairing";
import { useHub } from "../../src/data/react";

const said = (f: PairFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

export const billingKey = (hub: string) => ["cloud_billing", hub] as const;

/**
 * The team's billing, read on opening the page and again each time the app comes back to the front: a checkout or the
 * portal finishes in the browser, and the person returns here to see it.
 */
export function useBilling(enabled: boolean) {
  const hub = useHub().id;
  return useQuery({
    queryKey: billingKey(hub),
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<BillingState> => {
      const out = await window.fleetd.cloud.billing(hub);
      if (!out.ok) throw new Error(said(out.failure));
      return out.billing;
    },
  });
}


/**
 * Whether the hub in scope has Billing: a fleetd cloud team whose answer says fleetd's computers are on for it. Read
 * only while `asked` (the Settings index, a Hub page's switch on Billing), sharing the page's own query.
 */
export function useBillingShown(asked = true): boolean {
  const cloud = useHub().cloud === true;
  const read = useBilling(asked && cloud);
  return cloud && billingOn(read.data);
}
