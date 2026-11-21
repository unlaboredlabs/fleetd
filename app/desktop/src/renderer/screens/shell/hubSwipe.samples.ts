// A Mac trackpad's scrolls as macOS posts them, for the swipe's tests (hubSwipe.test.ts, hubs.dom.test.tsx) and the
// macOS runner's QA test, which posts them as CGEvents at the real app (qa/swipe.spec.ts): each event's deltas as the
// page reads them (deltaX + when the fingers go left), the fingers' phase or the momentum's after they lift, numbered
// as CGScrollPhase and CGMomentumScrollPhase number them, and the wait after it (ms). The fingers' events come every
// 16 ms or so; the momentum's decay for a second or more after they lift, and stop when fingers touch again.

/** CGScrollPhase: the fingers. */
export const FINGERS = { none: 0, began: 1, changed: 2, ended: 4, cancelled: 8, mayBegin: 128 } as const;
/** CGMomentumScrollPhase: the glide after they lift. */
export const MOMENTUM = { none: 0, begin: 1, continue: 2, end: 3 } as const;

export interface Scroll {
  readonly dx: number;
  readonly dy: number;
  readonly phase: number;
  readonly momentum: number;
  readonly wait: number;
}

const step = (dx: number, dy: number, phase: number, momentum: number, wait = 16): Scroll => ({ dx, dy, phase, momentum, wait });

/**
 * Fingers down, moving `deltas` (each [dx, dy]), and up: what a swipe or a scroll sends while they touch. The
 * touch and the lift carry no delta.
 */
export const fingers = (deltas: ReadonlyArray<readonly [number, number]>): Scroll[] => [
  step(0, 0, FINGERS.mayBegin, MOMENTUM.none),
  ...deltas.map(([dx, dy], i) => step(dx, dy, i === 0 ? FINGERS.began : FINGERS.changed, MOMENTUM.none)),
  step(0, 0, FINGERS.ended, MOMENTUM.none),
];

/**
 * The glide after the fingers lift: from `[dx, dy]`, each delta `decay` of the one before, until under a pixel, or
 * cut short after `count` events by fingers touching again; it ends with a momentum end, which carries no delta.
 */
export const momentum = (from: readonly [number, number], { decay = 0.92, count = Infinity } = {}): Scroll[] => {
  const out: Scroll[] = [];
  let [x, y] = from;
  for (let i = 0; i < count && Math.max(Math.abs(x), Math.abs(y)) >= 1; i++, x *= decay, y *= decay) {
    out.push(step(Math.round(x), Math.round(y), FINGERS.none, i === 0 ? MOMENTUM.begin : MOMENTUM.continue));
  }
  return [...out, step(0, 0, FINGERS.none, MOMENTUM.end)];
};

/** A deliberate two-finger swipe, `side` +1 the fingers going left (on to the next hub), -1 right; about 150 px. */
export const swipeFingers = (side: 1 | -1): Scroll[] => fingers([2, 4, 8, 12, 16, 20, 20, 18, 16, 14, 12].map((d) => [d * side, d > 10 ? 1 : 0] as const));

/** That swipe with its glide after the fingers lift, cut short after `count` of its events. */
export const swipe = (side: 1 | -1, count = Infinity): Scroll[] => [...swipeFingers(side), ...momentum([12 * side, 0], { count })];

/** A scroll down the list, drifting sideways a little, and its glide. */
export const scrollDown = (): Scroll[] => [...fingers([[1, 4], [2, 10], [4, 16], [6, 22], [4, 20], [2, 16]]), ...momentum([1, 14])];

/** What the page gets of them: the events with a delta. A touch, a lift and a momentum end are never wheel events. */
export const wheelsOf = (scrolls: readonly Scroll[]): Scroll[] => scrolls.filter((s) => s.dx !== 0 || s.dy !== 0);

/**
 * A swipe as the page got it on a slow Mac (macos-latest, W777): its events posted every 16 ms, handed over 40 to 320 ms
 * apart and bunched, the first of the touch the only cancelable one. Each: [ms, dx, dy, cancelable].
 */
export const SLOW_MAC_SWIPE: ReadonlyArray<readonly [number, number, number, 0 | 1]> = [[0, 2, 0, 1], [44, 4, 0, 0], [93, 8, 0, 0], [354, 68, 4, 0], [369, 18, 1, 0], [637, 42, 3, 0], [637, 12, 0, 0], [637, 11, 0, 0], [707, 10, 0, 0], [1028, 46, 0, 0], [1070, 6, 0, 0], [1106, 5, 0, 0], [1136, 5, 0, 0], [1178, 4, 0, 0], [1261, 4, 0, 0], [1262, 4, 0, 0], [1311, 3, 0, 0], [1326, 3, 0, 0], [1396, 3, 0, 0], [1445, 3, 0, 0], [1478, 2, 0, 0], [1526, 2, 0, 0], [1561, 2, 0, 0], [1577, 2, 0, 0], [1642, 2, 0, 0], [1693, 2, 0, 0], [1744, 1, 0, 0], [1777, 1, 0, 0], [1810, 1, 0, 0], [1870, 1, 0, 0], [1928, 1, 0, 0]];

/**
 * A swipe right as the page got it on another slow Mac (macos-latest, W777): each event at its own time, 16 to 80 ms
 * apart for a touch posted every 16 ms, so its speeds swing fourfold while its sizes are the trackpad's. Each: [ms, dx,
 * dy, cancelable].
 */
export const JITTERY_MAC_SWIPE: ReadonlyArray<readonly [number, number, number, 0 | 1]> = [[0, -2, 0, 1], [74, -4, 0, 0], [91, -8, 0, 0], [157, -12, 1, 0], [174, -16, 1, 0], [254, -20, 1, 0], [331, -20, 1, 0], [406, -18, 1, 0], [481, -16, 1, 0], [521, -14, 1, 0], [557, -12, 1, 0], [636, -12, 0, 0], [674, -11, 0, 0], [754, -10, 0, 0], [836, -9, 0, 0], [913, -9, 0, 0], [958, -8, 0, 0], [1033, -7, 0, 0], [1056, -7, 0, 0], [1129, -6, 0, 0], [1174, -6, 0, 0], [1253, -5, 0, 0], [1307, -5, 0, 0], [1374, -4, 0, 0], [1441, -4, 0, 0], [1507, -4, 0, 0], [1540, -3, 0, 0], [1621, -3, 0, 0], [1701, -3, 0, 0], [1773, -3, 0, 0], [1840, -2, 0, 0], [1875, -2, 0, 0], [1936, -2, 0, 0], [1991, -2, 0, 0], [2069, -2, 0, 0], [2141, -2, 0, 0], [2192, -1, 0, 0], [2218, -1, 0, 0], [2235, -1, 0, 0], [2256, -1, 0, 0], [2303, -1, 0, 0]];
