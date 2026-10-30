// The turn line at the end of a chat while its lead works, as the desktop draws it (screens/chat/ChatList.tsx
// LeadActivity): a live glyph (thinking walks its ring, anything else is grain), what the lead does now in the desktop's
// words, and how long the turn has run. Its activity comes from the lead's live lane (store.ts leadActivity), its start
// from the hub's "working" event (store.ts turnSince). Pure, so it is unit-tested.
import { doingWords, leadLaneId, sentenceCase, workedFor, type Activity } from "./desktop";
import { refOf, type Key, type State } from "./store";

export interface TurnView {
  readonly glyph: "thinking" | "working";
  /** What it does now: "Thinking", "Editing `a.ts`", "Working" when nothing more is known. */
  readonly now: string;
  /** How long the turn has run ("1m 12s"); absent when its start isn't known (the chat opened mid-turn). */
  readonly count?: string;
}

/** The lead's activity this moment: its live lane's, undefined while nothing more than "working" is known. */
export const leadActivityOf = (s: Pick<State, "leadActivity">, key: Key): Activity | undefined => s.leadActivity[leadLaneId(refOf(key))];

export const turnView = (activity: Activity | undefined, since: number | undefined, nowMs: number): TurnView => {
  const doing = activity === undefined ? "working" : doingWords(activity);
  return {
    glyph: doing === "thinking" || doing === "planning" ? "thinking" : "working",
    now: sentenceCase(doing),
    ...(since === undefined ? {} : { count: workedFor(nowMs - since) }),
  };
};

/** A line's words as plain and code runs: a file's name comes in backticks, set as code ("Editing `a.ts`"). */
export const codeRuns = (words: string): { readonly text: string; readonly code: boolean }[] =>
  words
    .split("`")
    .map((text, i) => ({ text, code: i % 2 === 1 }))
    .filter((r) => r.text !== "");

/**
 * The dither scan over what the lead does now (the desktop's base.css [data-sweep]): a band a fifth of the words wide
 * steps across them, one place a beat, then rests off to their left for the rest of the loop. Each place is where the
 * band's left edge sits, in band widths.
 */
export const SWEEP = [-1.1, -0.65, -0.19, 0.26, 0.72, 1.17, 1.62, 2.08, 2.53, 2.98, 3.44, 3.89, 4.35, 4.8] as const;
/** The band's width, of the words'. */
export const SWEEP_WIDTH = 0.22;
