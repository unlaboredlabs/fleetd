// Whether this app's person sees Settings' Hub group: its sidebar rows, the palette's commands and the pages ask
// here. Small and in the shell's chunk; the page is its own.
import type { Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useToolQuery } from "../../src/data/react";
import { administers } from "./model";

const noInput = {};

export interface HubRoleView {
  readonly administers: boolean;
  /** The person this app acts as; undefined on a hub from before people. */
  readonly me: Person | undefined;
  /** hub_info hasn't answered yet, and the app is connected: it will. */
  readonly pending: boolean;
  /** No hub connected and no answer kept from one: nothing to wait for until it connects. */
  readonly offline: boolean;
}

/**
 * hub_info's word on this app's person. No until it answers, so a member never sees the entry flash in; a hub too old
 * to have hub_info at all leaves the app to try, as Settings did, and refuses a change it doesn't allow.
 */
export function useHubRole(): HubRoleView {
  const info = useToolQuery("hub_info", noInput);
  // The query waits for a fresh connection, so without one it would stay pending for ever.
  const fresh = useData((st) => st.fresh);
  const old = info.error instanceof CallError && lacksTool(info.error.error);
  const unanswered = info.data === undefined && info.error === null;
  return {
    administers: old || administers(info.data),
    me: info.data?.me,
    pending: unanswered && fresh,
    offline: unanswered && !fresh,
  };
}

export const useAdministers = (): boolean => useHubRole().administers;
