// A calm card: rounded, no border, a step off its ground. On a grouped ground (Approvals) it is a row's color; on a
// chat's plain one, the grouped ground's.
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { space, useTheme } from "../theme";

export function Card({ children, on = "plain", style }: { children: ReactNode; on?: "plain" | "grouped"; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: on === "grouped" ? t.cell : t.surface }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, padding: space.lg, gap: space.md, overflow: "hidden" },
});
