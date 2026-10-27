// Whether this app's person sees Administration: the sidebar's entry, the palette's command and the page itself ask
// here. Small and in the shell's chunk; the page is its own.
import type { Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { administers } from "./model";

const noInput = {};

export interface HubRoleView {
  readonly administers: boolean;
  /** The person this app acts as; undefined on a hub from before people. */
  readonly me: Person | undefined;
  /** hub_info hasn't answered yet. */
  readonly pending: boolean;
}

/**
 * hub_info's word on this app's person. No until it answers, so a member never sees the entry flash in; a hub too old
 * to have hub_info at all leaves the app to try, as Settings did, and refuses a change it doesn't allow.
 */
export function useHubRole(): HubRoleView {
  const info = useToolQuery("hub_info", noInput);
  const old = info.error instanceof CallError && lacksTool(info.error.error);
  return { administers: old || administers(info.data), me: info.data?.me, pending: info.isPending };
}

export const useAdministers = (): boolean => useHubRole().administers;
