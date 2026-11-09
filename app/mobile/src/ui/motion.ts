// The desktop app's motion, on the phone (app/desktop/src/renderer/ui/tokens.css and ui/DESIGN.md): snappy, things
// arrive fast and stop dead, nothing bounces or floats, and only transform and opacity move. The same curves and
// durations, as Reanimated's:
// - a bubble that arrives glides in: it rides up from behind the composer with the rows above it on the desktop's
//   springs (glide.ts), fading in over its first 100 ms, a reply's bubbles 50 ms apart; nothing scales
// - a list row rises 3 pt in 160 ms; one that leaves fades in place for 140 ms, then the gap closes as rows move up
// - state changes (a send button, a menu, a banner, a press) take 140 ms on the snap curve
// - the lead's turn line changes its words in place: the new ones rise in 3 pt as the old rise out, over 200 ms
// - loops (the state glyph's grain and ring) step on the desktop's 120 ms beat, one beat for the whole app, rather than glide
// With Reduce Motion nothing moves: what arrives fades in place (a bubble 200 ms, your send 140 ms), and loops stand still. iOS's own transitions (a
// pushed screen, a sheet) stay iOS's.
import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { cancelAnimation, Easing, FadeOut, LinearTransition, makeMutable, withDelay, withRepeat, withSpring, withTiming, type EntryAnimationsValues, type ExitAnimationsValues, type SharedValue } from "react-native-reanimated";
import { GLIDE, type Spring } from "../glide";
import { BEAT_MS, LOOP_BEATS } from "../glyph";

/** --ease-snap, for every transition and entrance; --ease-out, for fades (a menu's backdrop, a highlight). */
export const ease = { snap: Easing.bezier(0.2, 0, 0, 1), out: Easing.bezier(0.22, 1, 0.36, 1) } as const;

export const dur = {
  /** --dur-fast and --dur-base: a fade, a sheet-like overlay's backdrop. */
  fast: 120,
  base: 180,
  /** --dur-quick: a state change, a press, a leaving row. */
  quick: 140,
  /** --dur-enter: a bubble's fade as it glides in. */
  fade: 100,
  /** --dur-enter and --dur-enter-mine with reduced motion: a bubble's fade in place. */
  enter: 200,
  enterMine: 140,
  /** --dur-row-in. */
  rowIn: 160,
  /** --enter-stagger. */
  stagger: 50,
  /** The turn line's crossfade (the desktop's view.module.css .turnLayer). */
  swap: 200,
  /** ui/lib/beat: loops step on it. */
  beat: BEAT_MS,
} as const;

/** --row-rise. */
const rise = { row: 3 } as const;

/** A reply's bubbles enter a step apart, up to this many: a long one doesn't keep you waiting for its last. */
const MAX_STEP = 5;

/** The phone's Reduce Motion, followed while the app runs. */
export const useReduceMotion = (): boolean => {
  const [on, setOn] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setOn);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setOn);
    return () => sub.remove();
  }, []);
  return on;
};

const riseIn = (by: number, duration: number, delay: number) => (_: EntryAnimationsValues) => {
  "worklet";
  const timing = (to: number) => withDelay(delay, withTiming(to, { duration, easing: ease.snap }));
  return { initialValues: { opacity: 0, transform: [{ translateY: by }] }, animations: { opacity: timing(1), transform: [{ translateY: timing(0) }] } };
};

/**
 * Rides up by its own height on `spring`, from behind the composer to its place, as the rows above it move up by the
 * same on the same spring (glide); it fades in over its first 100 ms, after `delay`. The thread is an inverted list,
 * which flips both its scroll view and each row, so a row's move is the screen's.
 */
const rideIn = (spring: Spring, delay: number) => (v: EntryAnimationsValues) => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: v.targetHeight }] },
    animations: { opacity: withDelay(delay, withTiming(1, { duration: dur.fade, easing: ease.out })), transform: [{ translateY: withSpring(0, spring) }] },
  };
};

/**
 * A bubble that came in while the chat was open, `step` places into its burst: it glides in on its side's spring
 * (yours quicker), or with Reduce Motion fades in place.
 */
export const bubbleIn = (mine: boolean, step: number, reduce: boolean) =>
  reduce ? riseIn(0, mine ? dur.enterMine : dur.enter, 0) : rideIn(mine ? GLIDE.mine : GLIDE.theirs, Math.min(step, MAX_STEP) * dur.stagger);

/** The thread's rows making room for a new bubble, or the newest growing, on `spring` (glide.ts glideOf). */
export const glide = (spring: Spring) => LinearTransition.springify().stiffness(spring.stiffness).damping(spring.damping).mass(spring.mass);

/** A list row that turned up while the list was on screen. */
export const rowIn = (reduce: boolean) => riseIn(reduce ? 0 : rise.row, dur.rowIn, 0);

/** A line's words taking the place of others, in place: they rise in by --row-rise as the old ones rise out. */
export const swapIn = (reduce: boolean) => (_: EntryAnimationsValues) => {
  "worklet";
  const timing = (to: number) => withTiming(to, { duration: dur.swap, easing: ease.out });
  return { initialValues: { opacity: 0, transform: [{ translateY: reduce ? 0 : rise.row }] }, animations: { opacity: timing(1), transform: [{ translateY: timing(0) }] } };
};
export const swapOut = (reduce: boolean) => (_: ExitAnimationsValues) => {
  "worklet";
  const timing = (to: number) => withTiming(to, { duration: dur.swap, easing: ease.out });
  return { initialValues: { opacity: 1, transform: [{ translateY: 0 }] }, animations: { opacity: timing(0), transform: [{ translateY: timing(reduce ? 0 : -rise.row) }] } };
};

/** A row leaving: one quick fade where it stood. */
export const rowOut = FadeOut.duration(dur.quick).easing(ease.snap);

/** Rows that move (a pin, a new message that lifts a chat to the top) slide to their places. */
export const rowMove = LinearTransition.duration(dur.base).easing(ease.snap);

/** A state change: a button that shows, a banner, a menu opening. Closing a menu is instant, as on the desktop. */
export const quick = { duration: dur.quick, easing: ease.snap } as const;

/** Pressed: a step quieter, at once, back in a quick fade. */
export const PRESSED_OPACITY = 0.6;

/** A view whose size changes (the composer growing a line) moves to its new frame on the snap curve. */
export const grows = (reduce: boolean): { layout?: typeof rowMove } => (reduce ? {} : { layout: LinearTransition.duration(dur.quick).easing(ease.snap) });

/** The app's one beat, 0 up to LOOP_BEATS and round again on the UI thread: every loop steps on it, together. */
const beat = makeMutable(0);
let loops = 0;

/**
 * The beat, running while any loop that wants it (`run`) is mounted, as the desktop's runs only while something live
 * is on screen. Read it as `Math.floor(beat.value)`: whole beats, so a loop steps rather than glides.
 */
export const useBeat = (run: boolean): SharedValue<number> => {
  useEffect(() => {
    if (!run) return;
    if (loops++ === 0) {
      beat.value = 0;
      beat.value = withRepeat(withTiming(LOOP_BEATS, { duration: LOOP_BEATS * dur.beat, easing: Easing.linear }), -1, false);
    }
    return () => {
      if (--loops === 0) cancelAnimation(beat);
    };
  }, [run]);
  return beat;
};
