// The month a day is picked from, for a chat's search (chatFind.ts, a day's messages): weeks from Monday, each day
// with its local date, and the days after today out of reach. Pure, so it is unit-tested.
import { dayOf } from "./chatFind";

export interface Month {
  readonly year: number;
  /** 0 to 11. */
  readonly month: number;
}

export const monthOf = (ms: number): Month => {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() };
};

export const nextMonth = (m: Month, by: number): Month => {
  const d = new Date(m.year, m.month + by, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
};

/** The month's name as its title says it: "November 2026". */
export const monthTitle = (m: Month): string => new Date(m.year, m.month, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

/** The weekday letters over the columns, Monday first. */
export const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export type Cell = { readonly day: string; readonly date: number; readonly future: boolean; readonly today: boolean } | null;

/** The month's weeks, Monday first, a blank before its first day and after its last; days after today are `future`. */
export const weeksOf = (m: Month, nowMs: number): readonly (readonly Cell[])[] => {
  const today = dayOf(nowMs);
  const lead = (new Date(m.year, m.month, 1).getDay() + 6) % 7;
  const length = new Date(m.year, m.month + 1, 0).getDate();
  const cells: Cell[] = Array.from({ length: lead }, () => null);
  for (let date = 1; date <= length; date++) {
    const day = dayOf(new Date(m.year, m.month, date).getTime());
    cells.push({ day, date, future: day > today, today: day === today });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
};

/** Whether the month after this one has a day that isn't in the future. */
export const canGoLater = (m: Month, nowMs: number): boolean => {
  const now = monthOf(nowMs);
  return m.year < now.year || (m.year === now.year && m.month < now.month);
};
