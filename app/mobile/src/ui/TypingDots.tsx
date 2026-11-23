// The lead's typing bubble, the desktop's own (Bubble.tsx TypingBubble): a grey one-line bubble with three square
// cells, one lit at a time, stepping left to right on the app's beat (motion.ts useBeat), two beats each, so it steps
// with every other loop on screen rather than gliding. With Reduce Motion all three hold half lit, still. Beside the bot
// in the reply's place while its lead takes your message and works on it (screens/WakeRow.tsx).
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { bubble } from "../bubble";
import { useTheme } from "../theme";
import { useBeat, useReduceMotion } from "./motion";

/** Beats each cell stays lit. */
const STEP_BEATS = 2;
const CELLS = [0, 1, 2] as const;

export function TypingDots({ label }: { label: string }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const beat = useBeat(!reduce);
  return (
    <View style={[styles.bubble, { backgroundColor: t.bubble }]} accessible accessibilityRole="text" accessibilityLabel={label}>
      {CELLS.map((cell) => (
        <Dot key={cell} cell={cell} beat={beat} still={reduce} color={t.secondary} />
      ))}
    </View>
  );
}

function Dot({ cell, beat, still, color }: { cell: number; beat: SharedValue<number>; still: boolean; color: string }) {
  const style = useAnimatedStyle(() => {
    if (still) return { opacity: 0.6 };
    return { opacity: Math.floor(Math.floor(beat.value) / STEP_BEATS) % CELLS.length === cell ? 1 : 0.3 };
  }, [still, cell]);
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

const styles = StyleSheet.create({
  // A one-line bubble: its words' line, in its padding.
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    height: bubble.lineHeight + 2 * bubble.padY,
    paddingHorizontal: bubble.padX + 2,
    borderRadius: bubble.radius,
    borderCurve: "continuous",
  },
  dot: { width: 6, height: 6, borderRadius: 1.5 },
});
