// A project's nightly memory refresh, without the hub (refresh.ts runs it): its hour and how late it may start, the
// night due now and the next, the session's tools and message, and the line that reports what it changed.
import type { Decision, MemoryRefreshed, RememberedItem } from "../../shared/contracts.ts";
import { zonedParts, zonedToUtc } from "../wakes/schedule.ts";

/** The global decision that moves the night's hour: "HH:MM" in the person's zone. */
export const AT_KEY = "policy.memory_refresh_at";
export const DEFAULT_AT = "04:00";
/** The night's refresh starts within this long after its hour, or not that night. */
export const WINDOW_MS = 3 * 3_600_000;
/** A refresh session still going after this long is stopped, and finished as it stands. */
export const RUN_LIMIT_MS = 3_600_000;
/** The longest a zone's clocks have jumped forward at once, with room to spare. */
export const GAP_MINUTES = 180;
/** The ops the hub takes from a refresh session (lead_calls/policy.ts, Rust `MEMORY_REFRESH_OPS`). */
export const MEMORY_REFRESH_OPS = ["memory_read", "remember", "forget"];
/** The tools a refresh session may use, and nothing else: fleetd's memory calls. */
export const allowedTools = () => MEMORY_REFRESH_OPS.map((op) => `mcp__fleetd__${op}`);

export type Time = { hour: number; minute: number };
/** The day's `at` in `tz`, as epoch ms: the first minute that exists from it on (spring forward skips some). */
export function dayAt(year: number, month: number, day: number, at: Time, tz: string): number | undefined {
  for (let m = 0; m <= GAP_MINUTES; m++) {
    const d = new Date(Date.UTC(year, month - 1, day, at.hour, at.minute + m));
    const local = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 };
    const ms = zonedToUtc(local, tz);
    const back = zonedParts(ms, tz);
    if (back.year === local.year && back.month === local.month && back.day === local.day && back.hour === local.hour && back.minute === local.minute) return ms;
  }
  return undefined;
}

/** The local day `offset` days from the one `ms` falls on in `tz`. */
export function dayOf(ms: number, tz: string, offset: number): [number, number, number] {
  const t = zonedParts(ms, tz);
  const d = new Date(Date.UTC(t.year, t.month - 1, t.day + offset));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** The hour of the night due now: today's (or yesterday's) `at` in `tz`, when now is at most WINDOW_MS past it. */
export function nightDue(nowMs: number, tz: string, at: Time): number | undefined {
  for (const offset of [0, -1]) {
    const ms = dayAt(...dayOf(nowMs, tz, offset), at, tz);
    if (ms !== undefined && ms <= nowMs && nowMs - ms < WINDOW_MS) return ms;
  }
  return undefined;
}

/** The first hour of a night after `nowMs`. */
export function nextNight(nowMs: number, tz: string, at: Time): number | undefined {
  for (const offset of [0, 1, 2]) {
    const ms = dayAt(...dayOf(nowMs, tz, offset), at, tz);
    if (ms !== undefined && ms > nowMs) return ms;
  }
  return undefined;
}

export const parseTime = (v: string | undefined): Time | undefined => {
  const m = v === undefined ? null : /^(\d{1,2}):(\d{1,2})$/.exec(v);
  if (!m) return undefined;
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
};

export const sign = (i: RememberedItem) => (i.forgotten === true ? "−" : i.replaced !== undefined ? "~" : "+");

/** "Memory refreshed: +2 ~1 −1" (contracts memory.rs `refreshed_summary`). */
export function refreshedSummary(items: RememberedItem[]): string {
  const parts = ["+", "~", "−"].map((s) => [s, items.filter((i) => sign(i) === s).length] as const).filter(([, n]) => n > 0);
  return `Memory refreshed: ${parts.map(([s, n]) => `${s}${n}`).join(" ")}`;
}

/** The refresh session's one message: its prompt, then the memory, the decisions and the chat. */
export function prompt(rules: string, memory: string, decided: Decision[], chatText: string): string {
  const list =
    decided.length === 0
      ? "(none)"
      : decided.map((d) => `- ${d.decisionId} ${d.key}: ${d.value}${d.why !== undefined ? ` (${d.why})` : ""}`).join("\n");
  const said = chatText.trim() ? chatText : "(none)";
  return `${rules.trimEnd()}\n\n## Memory now\n${memory}\n\n## Active decisions\n${list}\n\n## Chat since the last refresh\n${said}`;
}

export const REFRESHED_LISTED = 200;

/** What a line lists of `items`: the first REFRESHED_LISTED, how many there are when that is not all, how many undone. */
export function listed(items: RememberedItem[]): MemoryRefreshed {
  const undone = items.filter((i) => i.undone === true).length;
  return {
    items: items.slice(0, REFRESHED_LISTED),
    ...(items.length > REFRESHED_LISTED ? { total: items.length } : {}),
    ...(undone > 0 ? { undone } : {}),
  };
}
