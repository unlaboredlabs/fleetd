// Whether this app's person sees Settings' Hub group: its sidebar rows, the palette's commands and the pages ask
// here. Small and in the shell's chunk; the page is its own.
import { useEffect, useState } from "react";
import type { Person } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
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

/** Each hub's last word on what it leaves out, by the hub's id: kept through a refetch and a remount, never another's. */
const lastLeftOut = new Map<string, readonly string[]>();
const NONE: readonly string[] = [];

/** Forgets every hub's last word (tests). */
export const resetServes = (): void => lastLeftOut.clear();

/**
 * Whether the hub in scope serves `tool` (shared/hub.ts `serves`): fleetd cloud leaves out self-update, restart,
 * doctor, setup and the SSH machine add, and their controls are absent there. Only a hub_info answer with `leftOut`
 * hides one: while hub_info hasn't answered or keeps failing, the hub's last answer holds, and a hub never seen (or
 * too old to have hub_info) serves everything, so a self-run hub never looks like a cloud team.
 */
export function useServes(tool: string): boolean {
  const { hub } = useDataLayer();
  const info = useToolQuery("hub_info", noInput);
  const leftOut = info.data === undefined ? undefined : (info.data.leftOut ?? NONE);
  useEffect(() => {
    if (leftOut !== undefined) lastLeftOut.set(hub, leftOut);
  }, [hub, leftOut]);
  return serves({ leftOut: leftOut ?? lastLeftOut.get(hub) }, tool);
}
