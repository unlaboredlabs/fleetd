import * as Effect from "effect/Effect";
import { hubZone, isZone, POLICY_TZ_KEY } from "../digests/HumanDigests.ts";
import type { Decisions } from "../ledger/Decisions.ts";
import { QUIET_HOURS_KEY, quietHours } from "./rules.ts";

/** The quiet hours the global `policy.quiet_hours` decision sets, in `policy.tz` (else the hub's zone). */
export const quietPolicy = (decisions: Decisions["Service"]) =>
  Effect.map(decisions.list({ scope: { kind: "global" }, limit: 500 }), (global) => {
    const value = (key: string) => global.find((d) => d.key === key)?.value.trim();
    const tz = value(POLICY_TZ_KEY);
    return { tz: tz !== undefined && isZone(tz) ? tz : hubZone(), quiet: quietHours(value(QUIET_HOURS_KEY)) };
  });
