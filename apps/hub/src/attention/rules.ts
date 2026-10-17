// What needs the human now, and when a client may interrupt them. Pure, so the rules are tested without a clock. The
// hub stamps `attention` on the events it emits; clients (the desktop app's notifications) follow the field and the
// attention_policy tool rather than repeating these rules.
import type { Ask, Attention } from "@fleetd/contracts";

/** At most one notification per this window; what arrives meanwhile is folded into the next one as "+N more". */
export const COALESCE_MS = 20 * 60_000;

export const QUIET_HOURS_KEY = "policy.quiet_hours";

/**
 * A money, credential or irreversible ask that blocks a step needs the human (gated runs of class irreversible or
 * money block the lead's step by construction), and so does any approval put back in front of them because it never
 * ran or its result is unknown. Money and irreversible ones are urgent: they break through quiet hours. Product calls
 * and non-blocking asks wait for the inbox and the digest.
 */
export const askAttention = (ask: Ask, reopened: boolean): Attention | undefined => {
  const blocking = ask.class !== "product" && ask.blocks !== "nothing";
  const unrunApproval = reopened && ask.kind === "approve";
  if (ask.state !== "open" || !(blocking || unrunApproval)) return undefined;
  return ask.class === "money" || ask.class === "irreversible" ? "urgent" : "loud";
};

export interface QuietHours {
  /** Minutes after local midnight. */
  readonly start: number;
  readonly end: number;
}

/** DESIGN §4: the hours that apply while no `policy.quiet_hours` decision exists. */
export const DEFAULT_QUIET_HOURS = "23:00-08:00";

/** `"23:00-08:00"`; undefined for anything else (such as "off"), which means no quiet hours. */
export const parseQuietHours = (value: string): QuietHours | undefined => {
  const match = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$/u.exec(value);
  if (match === null) return undefined;
  const [, h1, m1, h2, m2] = match.map(Number) as [number, number, number, number, number];
  const quiet = { start: h1 * 60 + m1, end: h2 * 60 + m2 };
  return quiet.start === quiet.end ? undefined : quiet;
};

/** The quiet hours a `policy.quiet_hours` decision sets, or the default when there is none. */
export const quietHours = (decided: string | undefined) => parseQuietHours(decided ?? DEFAULT_QUIET_HOURS);

const localMinutes = (nowMs: number, tz: string) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(nowMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
};

const inside = (minutes: number, quiet: QuietHours) =>
  quiet.start < quiet.end ? minutes >= quiet.start && minutes < quiet.end : minutes >= quiet.start || minutes < quiet.end;

const minuteFloor = (ms: number) => ms - (ms % 60_000);

/** When the quiet hours around `nowMs` end, or undefined when it is not quiet now. */
export const quietUntil = (nowMs: number, tz: string, quiet: QuietHours | undefined): number | undefined => {
  if (quiet === undefined) return undefined;
  const now = localMinutes(nowMs, tz);
  if (!inside(now, quiet)) return undefined;
  return minuteFloor(nowMs) + ((quiet.end - now + 1440) % 1440) * 60_000;
};

export interface QuietWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * The quiet window under way at `nowMs` (if any) and the next one, as absolute times, so a client needs no time zone
 * rules. Like quietUntil, a window that spans a DST change can be an hour off at its far end.
 */
export const quietWindows = (nowMs: number, tz: string, quiet: QuietHours | undefined): Array<QuietWindow> => {
  if (quiet === undefined) return [];
  const windows: Array<QuietWindow> = [];
  const now = localMinutes(nowMs, tz);
  const currentEnd = quietUntil(nowMs, tz, quiet);
  if (currentEnd !== undefined) windows.push({ fromMs: minuteFloor(nowMs) - ((now - quiet.start + 1440) % 1440) * 60_000, toMs: currentEnd });
  const after = currentEnd ?? nowMs;
  const fromMs = minuteFloor(after) + ((quiet.start - localMinutes(after, tz) + 1440) % 1440) * 60_000;
  const toMs = quietUntil(fromMs, tz, quiet);
  if (toMs !== undefined) windows.push({ fromMs, toMs });
  return windows;
};
