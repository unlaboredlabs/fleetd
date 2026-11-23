// When fleetd's computers start again after their own account's limit refused a start (its starts a day, its rate):
// the refusal's free-again time, in the person's own time (W791: "No computer was free" and "its plan's limit is
// reached" read as the team's own plan, which was at 0 of 25). Pure, so the thread, the menu and the phone say the same.

/** "12:18", the 24-hour clock in `timeZone` (absent: this device's). */
export const clockAt = (ms: number, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) }).format(ms);

/** The line's end: "; they start again at 12:18", or nothing when the refusal didn't say when. */
export const startsAgain = (freeAt: string | number | undefined, timeZone?: string): string => {
  const ms = typeof freeAt === "string" ? Date.parse(freeAt) : freeAt;
  return ms === undefined || !Number.isFinite(ms) ? "" : `; they start again at ${clockAt(ms, timeZone)}`;
};
