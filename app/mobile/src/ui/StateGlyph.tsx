// The desktop's state glyph (ui/primitives/StateGlyph.tsx): a 3×3 dither cell whose shape is a state. Working is grain,
// thinking walks one lit cell round the ring; the rest hold a shape. The two live ones step on the app's one beat
// (motion.ts useBeat) on the UI thread, from the desktop's own frames (glyph.ts); off screen (`still`, or its screen
// covered by another) or with Reduce Motion they hold their still shapes, and then no beat runs for them.
import { useIsFocused } from "@react-navigation/native";
import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useDerivedValue, type SharedValue } from "react-native-reanimated";
import { glyphCells, glyphColor, LOOP_BEATS, type GlyphCell, type GlyphState } from "../glyph";
import { useTheme } from "../theme";
import { useBeat, useReduceMotion } from "./motion";

/** A cell's side and the gap between cells, in points: an 11 pt glyph, a line of small text's height. */
const CELL = 3;
const GAP = 1;
export const GLYPH_SIZE = 3 * CELL + 2 * GAP;

export const StateGlyph = memo(function StateGlyph({
  state,
  still = false,
  phase = 0,
  label,
}: {
  state: GlyphState;
  /** Off screen: a live state holds its still shape. */
  still?: boolean;
  /** Where in its loop it starts, 0 to 3 (desktop.ts phaseOf), so a list of them is out of step. */
  phase?: number;
  /** Named for VoiceOver; without one it is hidden from it. */
  label?: string;
}) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const live = state === "working" || state === "thinking";
  const focused = useIsFocused();
  const moving = live && !still && !reduce && focused;
  const beat = useBeat(moving);
  const step = useDerivedValue(() => Math.floor(beat.value) % LOOP_BEATS);
  // The same frames while the state holds, so each cell keeps its UI-thread style.
  const cells = useMemo(() => glyphCells(state, phase, moving), [state, phase, moving]);
  const color = glyphColor(t, state);
  return (
    <View
      style={styles.glyph}
      {...(label === undefined ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const } : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: label })}
    >
      {cells.map((cell, i) => (typeof cell === "number" ? <View key={i} style={[styles.cell, { backgroundColor: color, opacity: cell }]} /> : <Cell key={i} frames={cell} step={step} color={color} />))}
    </View>
  );
});

function Cell({ frames, step, color }: { frames: Exclude<GlyphCell, number>; step: SharedValue<number>; color: string }) {
  const lit = useAnimatedStyle(() => ({ opacity: frames[step.value] ?? 0 }));
  return <Animated.View style={[styles.cell, { backgroundColor: color }, lit]} />;
}

const styles = StyleSheet.create({
  glyph: { width: GLYPH_SIZE, height: GLYPH_SIZE, flexDirection: "row", flexWrap: "wrap", gap: GAP },
  cell: { width: CELL, height: CELL },
});
