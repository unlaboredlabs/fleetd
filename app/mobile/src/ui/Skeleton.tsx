// Loading, as shapes of what comes: grey blocks that breathe, instead of a spinner.
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Platform, StyleSheet, View, type DimensionValue } from "react-native";
import { space, useTheme } from "../theme";

const usePulse = (): Animated.Value => {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let loop: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      const step = (toValue: number) => Animated.timing(v, { toValue, duration: 800, useNativeDriver: Platform.OS !== "web" });
      loop = Animated.loop(Animated.sequence([step(0.45), step(1)]));
      loop.start();
    });
    return () => loop?.stop();
  }, [v]);
  return v;
};

export function SkeletonBlock({ width, height, radius = 6 }: { width: DimensionValue; height: number; radius?: number }) {
  const t = useTheme();
  const opacity = usePulse();
  return <Animated.View style={{ width, height, borderRadius: radius, backgroundColor: t.fillQuiet, opacity }} />;
}

/** A chats list row, loading. */
export function SkeletonRow({ wide = 0.6 }: { wide?: number }) {
  return (
    <View style={styles.row} accessibilityLabel="Loading">
      <SkeletonBlock width={52} height={52} radius={26} />
      <View style={styles.lines}>
        <SkeletonBlock width={`${String(Math.round(wide * 60))}%`} height={14} />
        <SkeletonBlock width={`${String(Math.round(wide * 130))}%`} height={12} />
      </View>
    </View>
  );
}

/** A thread's bubbles, loading. */
export function SkeletonThread() {
  const widths: Array<[boolean, DimensionValue, number]> = [
    [false, "62%", 38],
    [true, "48%", 36],
    [false, "70%", 58],
    [true, "36%", 36],
  ];
  return (
    <View style={styles.thread} accessibilityLabel="Loading">
      {widths.map(([mine, width, height], i) => (
        <View key={i} style={mine ? styles.mine : undefined}>
          <SkeletonBlock width={width} height={height} radius={18} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10 },
  lines: { flex: 1, gap: space.sm },
  thread: { gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.lg },
  mine: { alignItems: "flex-end" },
});
