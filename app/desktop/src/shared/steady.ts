// What an agent or the lead is doing, held steady where it shows (the agents' rows, the island over the composer, the
// phone's turn line): most tool calls end in well under a second, so drawn as each came the line flipped thinking →
// running … → thinking many times a second. Through useSteady a shown line stays at least HOLD_MS before the next
// takes its place (the newest waiting wins), and a fall back to the quiet state (thinking, nothing more to say) waits
// GAP_MS first, so the short gap between two tool calls never shows. Nothing is slowed or dropped at the hub: the line
// always ends on the latest state, and a tool that runs long shows at once, or HOLD_MS later at most. Pure but for
// React, so the phone app holds its line the same way (app/mobile, through its src/desktop.ts).
import { useEffect, useRef, useState } from "react";

/** The least time a shown line stays. */
export const HOLD_MS = 1000;
/** How long a quiet line must be the latest before it shows. */
export const GAP_MS = 600;

/** How long the latest line, the latest since `nowMs`, waits before it takes the place of one shown since `shownAt`. */
export const steadyWait = (shownAt: number, nowMs: number, quiet: boolean): number => Math.max(0, shownAt + HOLD_MS - nowMs, quiet ? GAP_MS : 0);

/**
 * `value` as it should show: the line on show until the latest, `key` (two lines with the same key read the same),
 * may take its place. `quiet` marks the in-between state, which shows only once it has lasted GAP_MS.
 */
export function useSteady<T>(value: T, key: string, quiet: boolean): T {
  const [shown, setShown] = useState<{ readonly value: T; readonly key: string }>(() => ({ value, key }));
  // When the line on show took its place: 0 for the first, so the first change shows at once.
  const shownAt = useRef(0);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  useEffect(() => {
    if (key === shown.key) return;
    const timer = setTimeout(
      () => {
        shownAt.current = Date.now();
        setShown({ value: latest.current, key });
      },
      steadyWait(shownAt.current, Date.now(), quiet),
    );
    return () => clearTimeout(timer);
  }, [key, quiet, shown.key]);
  // The same line, newer: its own values (a count, a tone), never a stale copy.
  return key === shown.key ? value : shown.value;
}
