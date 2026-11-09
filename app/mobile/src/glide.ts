// New bubbles glide in, as on the desktop (app/desktop/src/renderer/screens/chat/glide.ts; decision
// ui.bubble-entrance, option A of the bubble-motion report): the thread moves as one sheet. A new bubble rides up from
// behind the composer with the rows above it on one critically damped spring, and only fades in on its own (ui/motion.ts
// bubbleIn); the rows above move on the same spring (Chat.tsx's itemLayoutAnimation). Pure, so it is unit-tested.
import type { ThreadRow } from "./chatView";

export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
  readonly mass: number;
}

/** The desktop's springs, the same values. */
export const GLIDE = {
  /** A reply: 95% there at 212 ms. */
  theirs: { stiffness: 500, damping: 44.7, mass: 1 },
  /** Your send, quicker, since you made it happen: 187 ms. */
  mine: { stiffness: 650, damping: 51, mass: 1 },
  /** The newest message growing, as a streamed reply's words come: 180 ms. */
  grow: { stiffness: 700, damping: 53, mass: 1 },
} as const satisfies Record<string, Spring>;

/**
 * The spring the rows move on, newest first: the newest message's. The list takes one at a time, and a row and its
 * neighbours on different springs would cross for a moment.
 */
export const glideOf = (newestFirst: readonly ThreadRow[]): Spring => {
  const newest = newestFirst.find((r) => r.t === "item");
  if (newest?.t !== "item") return GLIDE.theirs;
  if (newest.item.state === "streaming") return GLIDE.grow;
  return newest.side === "me" ? GLIDE.mine : GLIDE.theirs;
};
