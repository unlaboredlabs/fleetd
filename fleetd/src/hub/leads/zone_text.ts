// A person's zone and an instant on its clock, as a lead is told them (zone.ts works out whose zone it is).
import { zonedParts } from "../wakes/schedule.ts";

export type Zone = { tz: string; source: "device" | "policy" | "hub" };

/** The zone with how it was chosen when it isn't the person's own. */
export function told(z: Zone): string {
  if (z.source === "policy") return `${z.tz}, the hub's policy.tz: theirs isn't known yet`;
  if (z.source === "hub") return `${z.tz}, the hub machine's zone: theirs isn't known yet`;
  return z.tz;
}

export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const pad = (n: number) => String(n).padStart(2, "0");

export function parts(z: Zone, ms: number) {
  const t = zonedParts(ms, z.tz);
  const day = DAYS[new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay()] as string;
  return { ...t, dayName: day, monthName: MONTHS[t.month - 1] as string };
}

/** "Tue 3 Nov, 18:05": the instant on this zone's clock, for a list that names the zone once. */
export function short(z: Zone, ms: number): string {
  const t = parts(z, ms);
  return `${t.dayName} ${t.day} ${t.monthName}, ${pad(t.hour)}:${pad(t.minute)}`;
}

/** "Tue 3 Nov 2026, 18:05 Europe/Berlin": with the year and how the zone was chosen. */
export function stamp(z: Zone, ms: number): string {
  const t = parts(z, ms);
  return `${t.dayName} ${t.day} ${t.monthName} ${t.year}, ${pad(t.hour)}:${pad(t.minute)} ${told(z)}`;
}
