// Whether this app's person sees Settings' Hub group: its sidebar rows, the palette's commands and the pages ask
// here. Small and in the shell's chunk; the page is its own.
import { useState } from "react";
import type { Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useToolQuery } from "../../src/data/react";
import { serves } from "../../../shared/hub";
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
  const unanswered = info.data === undefined && !old;
  return {
    administers: old || administers(info.data),
    me: info.data?.me,
    pending: unanswered && info.error === null && fresh,
    // A call that failed as the hub went away is no answer either: the owner was told to ask an admin.
    offline: unanswered && !fresh,
  };
}

export const useAdministers = (): boolean => useHubRole().administers;

/**
 * The same, held at the last answer while hub_info is asked again: what shows or hides with it (Settings' Hub group,
 * whose hub switcher asks each hub again as it mounts) never flips off and on with a refetch.
 */
export function useSettledAdministers(): boolean {
  const role = useHubRole();
  const [settled, setSettled] = useState(role.administers);
  if (!role.pending && settled !== role.administers) setSettled(role.administers);
  return role.pending ? settled : role.administers;
}

/**
 * Whether the hub in scope serves `tool` (shared/hub.ts `serves`): fleetd cloud leaves out self-update, restart,
 * doctor, setup and the SSH machine add, and their controls are absent there. No until hub_info first answers, then
 * held at the last answer while it is asked again, as useSettledAdministers; yes on a hub too old to have hub_info.
 */
export function useServes(tool: string): boolean {
  const info = useToolQuery("hub_info", noInput);
  const old = info.error instanceof CallError && lacksTool(info.error.error);
  const now = old ? true : info.data === undefined ? undefined : serves(info.data, tool);
  const [settled, setSettled] = useState(now);
  if (now !== undefined && settled !== now) setSettled(now);
  return now ?? settled ?? false;
}
