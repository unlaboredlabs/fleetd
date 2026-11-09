// What needs the human now, and when a client may interrupt them: the
// quiet hours and the coalesce window `fleetd_status.notify` hands clients. Pure, apart from reading the hub's zone.
import { readlinkSync } from "node:fs";
import type { Hub } from "../api/hub.ts";
import { decisions } from "../ledger/decisions.ts";
import { isoMs } from "../store/time.ts";

/** At most one notification per this window; what arrives meanwhile is folded into the next one. */
export const COALESCE_MS = 20 * 60_000;
export const QUIET_HOURS_KEY = "policy.quiet_hours";
/** The global decision naming the zone that quiet hours and digests run in. */
export const POLICY_TZ_KEY = "policy.tz";
/** The hours that apply while no `policy.quiet_hours` decision exists. */
export const DEFAULT_QUIET_HOURS = "23:00-08:00";

/** Minutes after local midnight. */
export type QuietHours = { start: number; end: number };

const QUIET = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/;

/** `"23:00-08:00"`; undefined for anything else (such as "off"), which means no quiet hours. */
export function parseQuietHours(value: string): QuietHours | undefined {
  const c = QUIET.exec(value);
  if (!c) return undefined;
  const n = (i: number) => Number(c[i]);
  const q = { start: n(1) * 60 + n(2), end: n(3) * 60 + n(4) };
  return q.start !== q.end ? q : undefined;
}

/** The quiet hours a `policy.quiet_hours` decision sets, or the default when there is none. */
export const quietHours = (decided: string | undefined) => parseQuietHours(decided ?? DEFAULT_QUIET_HOURS);

/** An IANA zone name fleetd can use. */
export function zone(name: string): string | undefined {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

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

function localMinutes(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(
    new Date(nowMs),
  );
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const inside = (minutes: number, q: QuietHours) =>
  q.start < q.end ? minutes >= q.start && minutes < q.end : minutes >= q.start || minutes < q.end;

const minuteFloor = (ms: number) => ms - (((ms % 60_000) + 60_000) % 60_000);
const mod = (n: number, m: number) => ((n % m) + m) % m;

/** When the quiet hours around `nowMs` end, or undefined when it is not quiet now. */
export function quietUntil(nowMs: number, tz: string, quiet: QuietHours | undefined): number | undefined {
  if (!quiet) return undefined;
  const now = localMinutes(nowMs, tz);
  return inside(now, quiet) ? minuteFloor(nowMs) + mod(quiet.end - now + 1440, 1440) * 60_000 : undefined;
}

export type QuietWindow = { fromMs: number; toMs: number };

/** The quiet window under way at `nowMs` (if any) and the next one, as absolute times. */
export function quietWindows(nowMs: number, tz: string, quiet: QuietHours | undefined): QuietWindow[] {
  if (!quiet) return [];
  const windows: QuietWindow[] = [];
  const now = localMinutes(nowMs, tz);
  const currentEnd = quietUntil(nowMs, tz, quiet);
  if (currentEnd !== undefined) {
    windows.push({ fromMs: minuteFloor(nowMs) - mod(now - quiet.start + 1440, 1440) * 60_000, toMs: currentEnd });
  }
  const after = currentEnd ?? nowMs;
  const fromMs = minuteFloor(after) + mod(quiet.start - localMinutes(after, tz) + 1440, 1440) * 60_000;
  const toMs = quietUntil(fromMs, tz, quiet);
  if (toMs !== undefined) windows.push({ fromMs, toMs });
  return windows;
}

/** The quiet hours the global `policy.quiet_hours` decision sets, in `policy.tz` (else the hub's zone). */
export function quietPolicy(globalValue: (key: string) => string | undefined): [string, QuietHours | undefined] {
  const tzName = globalValue(POLICY_TZ_KEY);
  const tz = (tzName !== undefined ? zone(tzName) : undefined) ?? hubZone();
  return [tz, quietHours(globalValue(QUIET_HOURS_KEY))];
}

/** `fleetd_status.notify`: the coalesce window and the quiet windows from now, as absolute times. */
export function notifyPolicy(hub: Hub): { coalesceSec: number; quiet: { from: string; to: string }[] } {
  const [tz, quiet] = quietPolicy((k) => decisions(hub).globalValue(k));
  return {
    coalesceSec: COALESCE_MS / 1000,
    quiet: quietWindows(hub.clock.now(), tz, quiet).map((w) => ({ from: isoMs(w.fromMs), to: isoMs(w.toMs) })),
  };
}
