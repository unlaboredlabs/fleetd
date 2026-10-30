// How a chat row swipes (ui/SwipeRow.tsx), as iOS 26's Messages does: the row lifts into a rounded card and slides,
// and 50 pt circles come in beside it, each popping in as the row passes it. Past the commit point the first circle
// stretches into a capsule across the gap, the row jumps ahead, and letting go there runs it. Measured on the iOS 26
// simulator (Messages: circles 50 pt, 10 pt from the edge and each other, the card's corner 26 pt) and, for what a
// screenshot can't show, Telegram's open-source port of UIKit's own (ItemListRevealMotion.swift): the commit and armed
// distances, the edge zone, the 0.7 power resistance, the open-or-close rule and the springs' response and damping.
// Distances are points along the swipe's direction; velocities, points a second. Every function here is a worklet: the
// gesture runs them on the UI thread.

/** A circle's size, and its gap to the screen's edge and to the next one. */
export const BUTTON = 50;
export const GAP = 10;
/** The lifted row's corner: Messages', which is Telegram's. */
export const CARD_RADIUS = 26;
/** Points sideways before a drag is a swipe; a mostly vertical one before that stays the list's scroll. */
export const SLOP = 12;

/** How far the row slides to show `count` circles: Messages' 70 pt for one, 130 pt for two. */
export const openDistance = (count: number): number => {
  "worklet";
  return count === 0 ? 0 : 2 * GAP + count * BUTTON + (count - 1) * GAP;
};

/** Where a full swipe commits: past the circles by 20 pt and at least half the row (52.5%), never past the row. */
export const commitDistance = (count: number, width: number): number => {
  "worklet";
  return Math.round(Math.min(width, Math.max(openDistance(count) + 20, width * 0.525)) * 3) / 3;
};

/** Where the row jumps to once a swipe will commit: three quarters across. */
export const armedDistance = (count: number, width: number): number => {
  "worklet";
  return Math.max(commitDistance(count, width), width * 0.75);
};

/** A finger this close to the edge the row moves toward commits sooner: at two thirds of the way, later when it's fast. */
const edgeZone = (width: number): number => {
  "worklet";
  return width >= 414 ? 90 : width === 375 ? 75 : 50;
};

const edgeFraction = (width: number, velocity: number): number => {
  "worklet";
  return Math.min(width >= 414 ? 0.75 : 0.8, Math.max(width >= 414 ? 0.5 : 0.66, Math.abs(velocity) / 2500));
};

/** Past the commit point, and backwards past closed, the row follows the finger at a 0.7 power: a rubber band. */
export const resisted = (d: number, commit: number, inverse = false): number => {
  "worklet";
  const power = inverse ? 1 / 0.7 : 0.7;
  if (d < 0) return -Math.pow(-d, power);
  if (d > commit) return commit + Math.pow(d - commit, power);
  return d;
};

/** One swipe, from the touch that takes hold of the row to the finger lifting. */
export interface Drag {
  /** Where the finger's travel starts, before resistance: the row's place when it was grabbed. */
  readonly initial: number;
  /** How far the row was carried toward the commit point early, near the edge. */
  readonly adjust: number;
  readonly armed: boolean;
}

/**
 * A row grabbed at `at` (a settling row: where it is, without the armed jump, so grabbing it again doesn't arm it at
 * once).
 */
export const grab = (at: number, expansion: number, count: number, width: number): Drag => {
  "worklet";
  const commit = commitDistance(count, width);
  const tracking = at - (armedDistance(count, width) - commit) * expansion;
  return { initial: resisted(tracking, commit, true), adjust: 0, armed: false };
};

/**
 * The finger moved `translation` along the swipe, `fromEdge` points from the edge the row moves toward: where the row
 * goes, and whether the swipe now commits. Armed, the row is carried ahead to the armed distance.
 */
export const drag = (d: Drag, translation: number, velocity: number, fromEdge: number, count: number, width: number): { drag: Drag; to: number } => {
  "worklet";
  const commit = commitDistance(count, width);
  let adjust = d.adjust;
  let proposed = d.initial + translation + adjust;
  let armed = proposed >= commit;
  if (!armed && proposed > commit * edgeFraction(width, velocity) && fromEdge < edgeZone(width)) {
    armed = true;
    if (adjust === 0) {
      adjust = commit - proposed;
      proposed = commit;
    }
  }
  const to = resisted(proposed, commit) + (armed ? armedDistance(count, width) - commit : 0);
  return { drag: { initial: d.initial, adjust, armed }, to };
};

/** The finger lifted: an armed swipe runs its action and closes; otherwise a flick or past halfway opens it. */
export const release = (d: Drag, translation: number, velocity: number, count: number): { commit: boolean; open: boolean } => {
  "worklet";
  if (d.armed) return { commit: true, open: false };
  const open = Math.abs(velocity) > 50 ? velocity > 50 : d.initial + translation > openDistance(count) / 2;
  return { commit: false, open };
};

/** The finger's speed handed to the settling spring, at most 100 times the way left per second, never backwards. */
export const handedVelocity = (velocity: number, at: number, to: number): number => {
  "worklet";
  const left = to - at;
  if (Math.abs(left) < 1e-6) return 0;
  return Math.min(100, Math.max(0, velocity / left)) * left;
};

/** A circle: its centre and width from the screen's edge, and how far it has popped in. */
export interface Circle {
  readonly center: number;
  readonly width: number;
  readonly scale: number;
  readonly opacity: number;
}

/**
 * Where the circles stand with the row `reveal` across, the first (the full swipe's) outermost. Each pops in as the row
 * passes it; past open, the first stretches after the row and the others ride along with it, fading. `expansion` (0 to
 * 1, armed) stretches the first across the whole gap and folds the others away.
 */
export const circles = (reveal: number, expansion: number, count: number, width: number): readonly Circle[] => {
  "worklet";
  const d = Math.max(0, reveal);
  const open = openDistance(count);
  const fold = Math.min(1, Math.max(0, expansion));
  const commit = commitDistance(count, width);
  const out: Circle[] = [];
  for (let i = 0; i < count; i++) {
    const outside = GAP + i * (BUTTON + GAP);
    const end = outside + BUTTON + GAP;
    const start = end - BUTTON + 2 * GAP;
    let scale = Math.min(1, Math.max(0, (d - start) / Math.max(1, end - start)));
    let opacity = scale;
    let width = BUTTON;
    let center = outside + width / 2;
    if (i === 0) {
      const stretched = width + Math.max(0, d - open);
      const expanded = Math.max(width, d - 2 * GAP);
      width = stretched + (expanded - stretched) * fold;
      center = GAP + width / 2;
    }
    if (d > open + 0.001) {
      if (i === 0) {
        scale = 1;
        opacity = 1;
      } else {
        center += d - open;
        scale = 1 - fold;
        opacity = (1 - Math.min(1, d / Math.max(1, commit)) * 0.7) * (1 - fold);
      }
    }
    out.push({ center, width, scale, opacity: opacity < 0.01 ? 0 : opacity });
  }
  return out;
};

/** Reanimated's spring for UIKit's response (seconds a cycle) and damping ratio, at unit mass. */
const spring = (response: number, damping: number) => ({ mass: 1, stiffness: (2 * Math.PI / response) ** 2, damping: (4 * Math.PI * damping) / response });

/** The row and the first circle's stretch: critically damped, half a second. */
export const BODY = spring(0.5, 1);
/** The card lifting and settling back: a touch slower, barely springy. */
export const SURFACE = spring(0.66, 0.95);
/** A circle popping in: springy. */
export const POP = spring(0.5, 0.7);
/** A circle fading under the finger: quick. */
export const FADE = spring(0.25, 1);

/**
 * Only one row is open at a time. `open` is the row that is, or the last a swipe took hold of: a swipe on another row,
 * or the list starting to scroll (null), closes it, and a tap while one is open only closes it.
 */
export type Opened = string | null;

/** A row went back closed: nothing is open, unless another took hold since. */
export const closed = (open: Opened, key: string): Opened => {
  "worklet";
  return open === key ? null : open;
};

/** Whether a row shown open should close now that `open` is the open one. */
export const shouldClose = (open: Opened, key: string): boolean => {
  "worklet";
  return open !== key;
};

/** A tap on a row: with one open, it only closes it (and nothing opens); otherwise it opens the chat. */
export const tapCloses = (open: Opened): boolean => open !== null;
