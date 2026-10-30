// A list row that swipes as a chat in iOS 26's Messages (the motion's numbers and why: swipe.ts). The row lifts into a
// rounded grey card and follows the finger; coloured circles pop in beside it, each with its SF Symbol. Let go past
// halfway (or flick) and it stays open: a circle's tap runs it. Past the commit point the first circle stretches into a
// capsule across the gap, the row jumps ahead with a tick, and letting go there runs it and the row springs back.
// Everything moves on the UI thread with Reanimated's springs, which jump straight to their end under Reduce Motion.
// One row is open at a time (SwipeGroup): a swipe on another row or the list scrolling closes it, and a tap while one is
// open only closes it. VoiceOver has the same actions on the row itself (ui/HoldMenu.tsx), and the circles' labels.
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { interpolateColor, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { BODY, BUTTON, CARD_RADIUS, circles, closed, drag, FADE, grab, handedVelocity, openDistance, POP, release, shouldClose, SLOP, SURFACE, tapCloses, type Drag, type Opened } from "../swipe";
import { useTheme } from "../theme";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";

export interface SwipeAction {
  readonly label: string;
  readonly icon: IconName;
  readonly color: string;
  readonly onPress: () => void;
}

/** The list's open row, shared by its rows: one open at a time. */
const Group = createContext<SharedValue<Opened> | null>(null);

/** A list whose rows swipe. Close its open row as it starts to scroll: `open.value = null`. */
export const useSwipeGroup = (): SharedValue<Opened> => useSharedValue<Opened>(null);

export function SwipeGroup({ open, children }: { open: SharedValue<Opened>; children: ReactNode }) {
  return <Group.Provider value={open}>{children}</Group.Provider>;
}

const reduce = { reduceMotion: ReduceMotion.System } as const;
const body = { ...BODY, ...reduce };
const surface = { ...SURFACE, ...reduce };
const pop = { ...POP, ...reduce };
const fade = { ...FADE, ...reduce };

/** The most circles a side has (circlesOf). */
const MOST = 2;

/**
 * The row. `children` gets `tap`, to wrap what a tap on the row does (it only closes an open row), and `lifted`, 0 to 1
 * as the card lifts, which the row's own separator fades with.
 */
export function SwipeRow({
  id,
  leading,
  trailing,
  children,
}: {
  id: string;
  /** Swiping right: the first is the outermost, and a full swipe runs it. */
  leading: readonly SwipeAction[];
  /** Swiping left, the same. */
  trailing: readonly SwipeAction[];
  children: (tap: (run: () => void) => () => void, lifted: SharedValue<number>) => ReactNode;
}) {
  const t = useTheme();
  const group = useContext(Group);
  const fallback = useSharedValue<Opened>(null);
  const open = group ?? fallback;
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  /** +1 swiping right (leading), -1 left. */
  const dir = useSharedValue(1);
  /** How far the row is across, along `dir`, and where it's headed. */
  const x = useSharedValue(0);
  const target = useSharedValue(0);
  const expansion = useSharedValue(0);
  const lift = useSharedValue(0);
  const liftOpacity = useSharedValue(0);
  /** Each circle's pop (scale) and fade, springing toward where the row is headed. */
  const circlesOf = [
    [useSharedValue(0), useSharedValue(0)],
    [useSharedValue(0), useSharedValue(0)],
  ] as const;
  const state = useSharedValue<{ drag: Drag; from: number; dragging: boolean; ignored: boolean; springing: boolean }>({
    drag: { initial: 0, adjust: 0, armed: false },
    from: 0,
    dragging: false,
    ignored: false,
    springing: false,
  });
  // The circles are only drawn while the row is out: a list of closed rows draws none.
  const [side, setSide] = useState<0 | 1 | -1>(0);
  const actions = side === 1 ? leading : side === -1 ? trailing : [];

  const counts = { leading: Math.min(MOST, leading.length), trailing: Math.min(MOST, trailing.length) };
  // What a full swipe runs: the row's newest actions, read when it commits.
  const latest = useRef({ leading, trailing });
  latest.current = { leading, trailing };

  const pan = useMemo(() => {
    const count = (d: number): number => {
      "worklet";
      return d > 0 ? counts.leading : counts.trailing;
    };
    /** The circles' pop and fade toward where the row is headed. */
    const aim = (to: number, armed: boolean, dragging: boolean) => {
      "worklet";
      const cs = circles(to, armed ? 1 : 0, count(dir.value), width.value);
      circlesOf.forEach(([scale, opacity], i) => {
        scale.value = withSpring(cs[i]?.scale ?? 0, pop);
        opacity.value = withSpring(cs[i]?.opacity ?? 0, dragging ? fade : body);
      });
    };
    const settle = (to: number, velocity: number) => {
      "worklet";
      target.value = to;
      x.value = withSpring(to, { ...body, velocity: handedVelocity(velocity, x.value, to) }, (done) => {
        if (done === true && to === 0 && target.value === 0) scheduleOnRN(setSide, 0);
      });
      expansion.value = withSpring(0, body);
      lift.value = withSpring(to > 0 ? 1 : 0, surface);
      liftOpacity.value = withSpring(to > 0 ? 1 : 0, surface);
      aim(to, false, false);
      if (to === 0) open.value = closed(open.value, id);
    };
    const run = (d: number) => (d > 0 ? latest.current.leading : latest.current.trailing)[0]?.onPress();
    return Gesture.Pan()
      .activeOffsetX([-SLOP, SLOP])
      .failOffsetY([-SLOP, SLOP])
      .onStart((e) => {
        const s = state.value;
        // Another row is open: this touch only closes it, as in Messages.
        if (open.value !== null && open.value !== id) {
          open.value = null;
          state.value = { ...s, ignored: true };
          return;
        }
        const out = Math.abs(x.value) > 0.5 || target.value !== 0;
        if (!out) dir.value = e.translationX > 0 ? 1 : -1;
        const n = count(dir.value);
        if (n === 0) {
          state.value = { ...s, ignored: true };
          return;
        }
        open.value = id;
        scheduleOnRN(setSide, dir.value > 0 ? 1 : -1);
        state.value = { drag: grab(x.value, expansion.value, n, width.value), from: e.translationX, dragging: true, ignored: false, springing: Math.abs(x.value - target.value) > 0.5 };
        lift.value = withSpring(1, surface);
        liftOpacity.value = withSpring(1, surface);
      })
      .onUpdate((e) => {
        const s = state.value;
        if (s.ignored || !s.dragging) return;
        const n = count(dir.value);
        const along = (e.translationX - s.from) * dir.value;
        const fromEdge = dir.value > 0 ? width.value - e.absoluteX : e.absoluteX;
        const next = drag(s.drag, along, e.velocityX * dir.value, fromEdge, n, width.value);
        if (next.drag.armed !== s.drag.armed) {
          scheduleOnRN(haptics.select);
          expansion.value = withSpring(next.drag.armed ? 1 : 0, body);
        }
        // Once armed, the row springs to where the finger puts it for the rest of the swipe, so the jump ahead and
        // back again glide rather than snap.
        const springing = s.springing || next.drag.armed;
        target.value = next.to;
        x.value = springing ? withSpring(next.to, body) : next.to;
        aim(next.to, next.drag.armed, true);
        state.value = { ...s, drag: next.drag, springing };
      })
      .onFinalize((e, success) => {
        const s = state.value;
        if (s.ignored || !s.dragging) {
          state.value = { ...s, ignored: false, dragging: false };
          return;
        }
        state.value = { ...s, dragging: false, springing: false };
        const n = count(dir.value);
        const along = (e.translationX - s.from) * dir.value;
        const v = e.velocityX * dir.value;
        const r = success ? release(s.drag, along, v, n) : { commit: false, open: Math.abs(target.value) > openDistance(n) / 2 };
        settle(r.open ? openDistance(n) : 0, v);
        if (r.commit) scheduleOnRN(run, dir.value);
      });
    // The shared values are stable, and the actions are read when they run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, counts.leading, counts.trailing]);

  // Another row took hold, or the list scrolled: close.
  useAnimatedReaction(
    () => open.value,
    (now) => {
      if (!shouldClose(now, id) || state.value.dragging || target.value === 0) return;
      target.value = 0;
      x.value = withSpring(0, body, (done) => {
        if (done === true && target.value === 0) scheduleOnRN(setSide, 0);
      });
      expansion.value = withSpring(0, body);
      lift.value = withSpring(0, surface);
      liftOpacity.value = withSpring(0, surface);
      circlesOf.forEach(([scale, opacity]) => {
        scale.value = withSpring(0, pop);
        opacity.value = withSpring(0, body);
      });
    },
  );

  const close = () => {
    open.value = null;
  };
  const tap = (run: () => void) => () => {
    if (tapCloses(open.value)) close();
    else run();
  };

  const card = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value * dir.value }],
    backgroundColor: interpolateColor(liftOpacity.value, [0, 1], [t.bg, t.lifted]),
    borderRadius: Math.min(CARD_RADIUS, height.value / 2) * Math.min(1, Math.max(0, lift.value)),
  }));
  // The row above keeps its separator on the card's top edge: it fades as the card lifts, as in Messages.
  const above = useAnimatedStyle(() => ({ opacity: liftOpacity.value }));

  return (
    <GestureDetector gesture={pan}>
      <View
        collapsable={false}
        onLayout={(e) => {
          width.value = e.nativeEvent.layout.width;
          height.value = e.nativeEvent.layout.height;
        }}
      >
        <Animated.View pointerEvents="none" style={[styles.above, { backgroundColor: t.bg }, above]} />
        {actions.slice(0, MOST).map((a, i) => (
          <Circle
            key={a.label}
            action={a}
            index={i}
            count={Math.min(MOST, actions.length)}
            side={side === -1 ? -1 : 1}
            x={x}
            expansion={expansion}
            width={width}
            scale={(circlesOf[i] ?? circlesOf[0])[0]}
            opacity={(circlesOf[i] ?? circlesOf[0])[1]}
            onPress={() => {
              close();
              a.onPress();
            }}
          />
        ))}
        <Animated.View style={[styles.card, card]}>{children(tap, liftOpacity)}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const ICON = 20;

/** A circle beside the row, stretched into a capsule when it's the full swipe's; its symbol rides at the row's edge. */
function Circle({
  action,
  index,
  count,
  side,
  x,
  expansion,
  width,
  scale,
  opacity,
  onPress,
}: {
  action: SwipeAction;
  index: number;
  count: number;
  side: 1 | -1;
  x: SharedValue<number>;
  expansion: SharedValue<number>;
  width: SharedValue<number>;
  scale: SharedValue<number>;
  opacity: SharedValue<number>;
  onPress: () => void;
}) {
  // Read in a derived value of its own: a style tracks only the shared values it reads itself.
  const shape = useDerivedValue(() => {
    const c = circles(x.value, expansion.value, count, width.value)[index] ?? { center: 0, width: BUTTON };
    return { center: side > 0 ? c.center : width.value - c.center, w: c.width };
  });
  const anchor = useAnimatedStyle(() => ({ opacity: opacity.value, transform: [{ translateX: shape.value.center - BUTTON / 2 }, { scale: scale.value }] }));
  const start = useAnimatedStyle(() => ({ transform: [{ translateX: (BUTTON - shape.value.w) / 2 }] }));
  const end = useAnimatedStyle(() => ({ transform: [{ translateX: (shape.value.w - BUTTON) / 2 }] }));
  const middle = useAnimatedStyle(() => ({ transform: [{ scaleX: Math.max(0.001, shape.value.w - BUTTON) }] }));
  // Armed, the symbol moves from the capsule's middle to its end by the row, a cap's radius in.
  const icon = useAnimatedStyle(() => {
    const ride = index === 0 ? ((shape.value.w - BUTTON) / 2) * side * Math.min(1, Math.max(0, expansion.value)) : 0;
    return { transform: [{ translateX: ride }] };
  });
  const fill = { backgroundColor: action.color };
  return (
    <Animated.View style={[styles.anchor, anchor]}>
      <Pressable accessibilityRole="button" accessibilityLabel={action.label} onPress={onPress} style={styles.hit}>
        <Animated.View style={[styles.cap, fill, start]} />
        <Animated.View style={[styles.middle, fill, middle]} />
        <Animated.View style={[styles.cap, fill, end]} />
        <Animated.View style={[styles.icon, icon]}>
          <Icon name={action.icon} size={ICON} color="#FFFFFF" weight="medium" />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderCurve: "continuous", overflow: "hidden" },
  above: { position: "absolute", left: 0, right: 0, top: -StyleSheet.hairlineWidth, height: StyleSheet.hairlineWidth },
  anchor: { position: "absolute", left: 0, top: "50%", marginTop: -BUTTON / 2, width: BUTTON, height: BUTTON },
  hit: { width: BUTTON, height: BUTTON },
  cap: { position: "absolute", left: 0, top: 0, width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2 },
  middle: { position: "absolute", left: BUTTON / 2 - 0.5, top: 0, width: 1, height: BUTTON },
  icon: { position: "absolute", left: 0, top: 0, width: BUTTON, height: BUTTON, alignItems: "center", justifyContent: "center" },
});
