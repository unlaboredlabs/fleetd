// What needs the human now, and when a client may interrupt them: the
// quiet hours and the coalesce window `fleetd_status.notify` hands clients. Pure (quiet.ts), apart from reading the hub's zone.
import { readlinkSync } from "node:fs";
import type { Hub } from "../api/hub.ts";
import { decisions } from "../ledger/decisions.ts";
import { isoMs } from "../store/time.ts";
import { COALESCE_MS, type QuietHours, quietPolicyWith, quietWindows, zone } from "./quiet.ts";

export {
  COALESCE_MS,
  DEFAULT_QUIET_HOURS,
  parseQuietHours,
  POLICY_TZ_KEY,
  QUIET_HOURS_KEY,
  type QuietHours,
  quietHours,
  quietUntil,
  type QuietWindow,
  quietWindows,
  zone,
} from "./quiet.ts";

/** The hub machine's zone: `TZ`, else `/etc/localtime`'s target, else UTC. */
export function hubZone(): string {
  const tz = process.env.TZ;
  if (tz) {
    const z = zone(tz.replace(/^:/, ""));
    if (z) return z;
  }
  try {
    const target = readlinkSync("/etc/localtime");
    const name = target.split("zoneinfo/")[1];
    if (name) return zone(name) ?? "UTC";
  } catch {}
  return "UTC";
}

/** The quiet hours the global `policy.quiet_hours` decision sets, in `policy.tz` (else the hub's zone). */
export function quietPolicy(globalValue: (key: string) => string | undefined): [string, QuietHours | undefined] {
  return quietPolicyWith(globalValue, hubZone);
}

/** `fleetd_status.notify`: the coalesce window and the quiet windows from now, as absolute times. */
export function notifyPolicy(hub: Hub): { coalesceSec: number; quiet: { from: string; to: string }[] } {
  const [tz, quiet] = quietPolicy((k) => decisions(hub).globalValue(k));
  return {
    coalesceSec: COALESCE_MS / 1000,
    quiet: quietWindows(hub.clock.now(), tz, quiet).map((w) => ({ from: isoMs(w.fromMs), to: isoMs(w.toMs) })),
  };
}
