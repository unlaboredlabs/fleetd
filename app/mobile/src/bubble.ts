// iMessage's bubble geometry, measured from Messages in the iOS 26 simulator (iPhone 17 Pro, 402 pt wide, 3x shots):
// one place for the thread's words, its pictures and files, and the menu's lifted preview, pinned by bubble.test.ts.
// Points, at the default text size.

export const bubble = {
  /** The words: SF at body size. Messages sets its lines 20 apart, not the type scale's 22. */
  fontSize: 17,
  lineHeight: 20,
  /** Inside the bubble: from its edge to the words, side and top. A one-line bubble is 40 tall. */
  padX: 14,
  padY: 10,
  /** A bubble's corners, on iOS's continuous curve: a one-liner is a capsule. */
  radius: 20,
  /** Between bubbles of one burst, and between bursts (a new sender, or the same after a pause): body to body. */
  gap: 4,
  burstGap: 10,
  /** The thread's side margin, screen edge to bubble edge. */
  margin: 16,
  /** A bubble's widest, as a share of the screen's width. */
  maxShare: 0.7,
  /**
   * The tail on a burst's last bubble, as iOS 26 draws it: a hook under the bottom corner, hanging 7 pt into the gap.
   * A bar `width` x `height` turned `angle` degrees, its tip's corner rounded by `tipRadius`, `inset` from the bubble's
   * side and `drop` below its bottom (before turning); then a circle of the ground, `notch` across, `notchInset` past
   * the side and `notchDrop` below, cuts the pinch between the corner and the tail.
   */
  tail: { width: 16, height: 9, angle: 32, tipRadius: 1.5, inset: 5.7, drop: 4.05, notch: 11.6, notchInset: 1.1, notchDrop: 6.2 },
  /** Emoji alone, without a bubble: one is drawn at `one`, two or three at `few`, each with its line's height. */
  jumbo: { one: 72, oneLineHeight: 86, few: 48, fewLineHeight: 57, most: 3 },
} as const;

/**
 * How wide a bubble's words draw, from their paragraphs' line widths: the longest line, rounded up to the screen's
 * pixel (`scale` to a point) so it still fits. Messages sizes a bubble to its longest line, where a Text takes all the
 * width it may.
 */
export const fitWidth = (lines: readonly number[], scale: number): number => Math.max(0, Math.ceil(Math.max(0, ...lines) * scale - 0.01)) / scale;

/** The widest a bubble draws on a screen `width` points wide. */
export const bubbleMax = (width: number): number => Math.round(width * bubble.maxShare);

// One emoji as a person sees it: a pictograph with its variation, skin tone and joined ones; a flag; a keycap.
const emoji = /(?:\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)/gu;

/** How many emoji `text` is, when it's emoji alone (spaces aside) and few enough to draw big; otherwise 0. */
export const jumbo = (text: string): number => {
  const bare = text.replace(/\s/g, "");
  if (bare === "") return 0;
  const found = bare.match(emoji) ?? [];
  if (found.join("") !== bare) return 0;
  return found.length <= bubble.jumbo.most ? found.length : 0;
};
