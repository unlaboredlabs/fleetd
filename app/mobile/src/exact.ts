// How the approval card draws a field exactly on the phone: each character that hides or reorders text (the desktop
// app's shared/hidden.ts, as the hub's push::plain) as its mark, ⟨U+202E⟩. React Native has no <bdi>, so the text
// carries its own isolates: the field in one (first strong, or left to right for machine text), each mark in a
// left-to-right one. The marks replaced every bidi control the text had, so these are the only ones and always pair.
import { pieces } from "./desktop";

/** First strong isolate, left-to-right isolate, and the pop that closes either. */
export const FSI = "⁨";
export const LRI = "⁦";
export const PDI = "⁩";

/** A run of a field as drawn: as written, or a mark in its own style. */
export interface Run {
  readonly text: string;
  readonly mark: boolean;
}

/** `text` as runs, each hidden character a mark in its own left-to-right isolate. `lines`: its \n breaks the line. */
export const markRuns = (text: string, lines = false): Run[] =>
  pieces(text, lines).map((p): Run => (p.mark === undefined ? { text: p.text, mark: false } : { text: `${LRI}${p.mark}${PDI}`, mark: true }));

/**
 * `text` as runs for nested <Text>, the whole in its own isolate. `lines`: a body or a block, whose \n breaks the line
 * as written. `ltr`: machine text (a command's word, an address, a path), left to right as a terminal shows it.
 */
export const exactRuns = (text: string, how: { lines?: boolean; ltr?: boolean } = {}): Run[] => [
  { text: how.ltr === true ? LRI : FSI, mark: false },
  ...markRuns(text, how.lines === true),
  { text: PDI, mark: false },
];
