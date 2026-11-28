// When fleetd's computers start again after their own account's limit refused a start (its starts a day, its rate):
// the refusal's free-again time, in the person's own time (W791: "No computer was free" and "its plan's limit is
// reached" read as the team's own plan, which was at 0 of 25). Pure, so the thread, the menu and the phone say the same.

import { clock } from "./clock";

/** "12:18 PM" or "12:18", as the chat around it says a time (clock.ts), in `timeZone` (absent: this device's). */
export const clockAt = (ms: number, timeZone?: string): string => clock(ms, timeZone);

/** The line's end: "; they start again at 12:18", or nothing when the refusal didn't say when. */
export const startsAgain = (freeAt: string | number | undefined, timeZone?: string): string => {
  const ms = typeof freeAt === "string" ? Date.parse(freeAt) : freeAt;
  return ms === undefined || !Number.isFinite(ms) ? "" : `; they start again at ${clockAt(ms, timeZone)}`;
};
