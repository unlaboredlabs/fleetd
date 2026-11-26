// How often a moving bot (ui/Being.tsx) is drawn again. Its springs step every frame, but each drawing is its SVG
// rastered again on the main thread, its glow a Gaussian blur through Core Image: at the screen's rate (120 Hz on a
// ProMotion iPhone), for every live bot in the chats list, that kept the main thread busy and the phone hot. Its
// motion is a few points of hop and squash: 30 drawings a second in a list, 60 for a large bot on its own.
import { LARGE } from "./desktop";

/** Between drawings of a bot `size` points across, in ms. */
export const drawEveryMs = (size: number): number => 1000 / (size >= LARGE ? 60 : 30);

/**
 * A frame `dtMs` after the last: whether the bot is drawn on it, and the time since its last drawing after it. A frame
 * a millisecond short of its turn is drawn, so a 120 Hz screen's four frames make one drawing at 30.
 */
export const drawStep = (since: number, dtMs: number, every: number): { readonly draw: boolean; readonly since: number } => {
  "worklet";
  const at = since + dtMs;
  if (at < every - 1) return { draw: false, since: at };
  return { draw: true, since: Math.max(0, Math.min(at - every, every)) };
};
