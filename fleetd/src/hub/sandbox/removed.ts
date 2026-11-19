// Providers fleetd removed that this hub had connected (table `providers_removed`, filled by the migration that removed
// each one, which deletes its stored key too): one plain line apiece, which Settings › Hub › Machines' Providers shows
// for SHOWN_MS after the update, then never again. Nothing else asks about them: agents place by what remains.
import type { Hub } from "../api/hub.ts";
import { REMOVED } from "../../shared/sandbox.ts";

/** How long a removed provider's line stays. */
export const SHOWN_MS = 30 * 24 * 3600 * 1000;

/** What each removed provider's line says: that it went, and what runs instead. */
const LINES: Readonly<Record<string, string>> = {
  revyl: "Revyl was removed from fleetd, with the key you connected: iOS simulators run on a Mac machine, Android on a Linux machine.",
  ...Object.fromEntries(
    Object.entries(REMOVED).map(([id, r]) => [id, `${r.name} was removed from fleetd, with the key you connected: ${r.why}. Agents run on your machines or boat.dev.`]),
  ),
};

/** The lines to show now, oldest removal first; empty once each is older than SHOWN_MS. */
export function removedLines(hub: Hub): string[] {
  const since = hub.clock.now() - SHOWN_MS;
  return hub.db.conn
    .query<{ provider: string }, [number]>("SELECT provider FROM providers_removed WHERE at_ms > ?1 ORDER BY at_ms, provider")
    .all(since)
    .flatMap((r) => (LINES[r.provider] ? [LINES[r.provider]!] : []));
}
