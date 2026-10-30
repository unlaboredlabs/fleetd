// Messages' times: drag the thread left and each message's time comes in at its right, your bubbles sliding over to
// make room while the other side's keep their place; let go and it all goes back. The drag runs on the UI thread. It
// starts only leftward and away from the screen's left edge, so iOS's swipe back from that edge stays iOS's, and a
// mostly vertical drag stays the thread's scroll.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { REVEAL, revealOf } from "../reveal";
import { type, useTheme } from "../theme";
import { quick } from "./motion";

/** The screen's left edge, kept for iOS's swipe back. */
const EDGE = 24;

const Shown = createContext<{ shown: SharedValue<number>; margin: number } | null>(null);

/** The thread's area, its rows `margin` in from the screen's sides: a leftward drag anywhere but the left edge shows the times. */
export function RevealArea({ margin, children }: { margin: number; children: ReactNode }) {
  const shown = useSharedValue(0);
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(-10)
        .failOffsetY([-10, 10])
        .hitSlop({ left: -EDGE })
        .onUpdate((e) => {
          shown.value = revealOf(e.translationX);
        })
        .onFinalize(() => {
          shown.value = withTiming(0, quick);
        }),
    [shown],
  );
  const area = useMemo(() => ({ shown, margin }), [shown, margin]);
  return (
    <Shown.Provider value={area}>
      <GestureDetector gesture={pan}>
        <View style={styles.fill}>{children}</View>
      </GestureDetector>
    </Shown.Provider>
  );
}

/** A message's row: its time waits past the screen's right edge; yours slides left with it, theirs stays. */
export function Revealed({ mine, time, children }: { mine: boolean; time: string; children: ReactNode }) {
  const t = useTheme();
  const area = useContext(Shown);
  const shown = area?.shown;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: -(shown?.value ?? 0) }] }));
  return (
    <View>
      <Animated.View style={mine ? slide : undefined}>{children}</Animated.View>
      <Animated.View style={[styles.time, { marginLeft: area?.margin ?? 0 }, slide]} pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
        <Text style={[type.caption, styles.timeText, { color: t.secondary }]} maxFontSizeMultiplier={1.2} numberOfLines={1}>
          {time}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // Past the row's right end and the thread's margin: off the screen until the thread slides.
  time: { position: "absolute", top: 0, bottom: 0, left: "100%", width: REVEAL, justifyContent: "center" },
  timeText: { fontVariant: ["tabular-nums"], paddingLeft: 6 },
});
