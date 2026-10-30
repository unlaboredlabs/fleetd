// A calm card: rounded, no border, a step off a chat's plain ground in the grouped ground's color.
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { shape, space, useTheme } from "../theme";

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.surface }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: shape.card, borderCurve: "continuous", padding: space.lg, gap: space.md, overflow: "hidden" },
});
