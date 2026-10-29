// A chat's avatar: its initials on a color picked from its name. A Navi's is a circle in a soft top-to-bottom gradient
// of its color, as Telegram draws a person's; a project's a soft rounded square, like a folder of work.
import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, Text, View } from "react-native";
import { initials, tintIndex } from "../avatar";
import { useTheme } from "../theme";

/** "#RRGGBB" mixed toward white by `amount` (0 to 1). */
export const lighter = (hex: string, amount: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${String(mix((n >> 16) & 255))},${String(mix((n >> 8) & 255))},${String(mix(n & 255))})`;
};

/** "#RRGGBB" at an opacity. */
export const withAlpha = (hex: string, alpha: number): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${String((n >> 16) & 255)},${String((n >> 8) & 255)},${String(n & 255)},${String(alpha)})`;
};

export function Avatar({ name, navi, size = 52 }: { name: string; navi: boolean; size?: number }) {
  const t = useTheme();
  const tint = t.tints[tintIndex(name, t.tints.length)] ?? t.accent;
  const text = initials(name);
  const box = { width: size, height: size, borderRadius: navi ? size / 2 : size * 0.28 };
  return (
    <View accessible={false} style={[styles.base, box, { backgroundColor: navi ? tint : withAlpha(tint, t.dark ? 0.28 : 0.16) }]}>
      {navi ? <LinearGradient colors={[lighter(tint, 0.32), tint]} style={StyleSheet.absoluteFill} /> : null}
      <Text
        allowFontScaling={false}
        style={{ color: navi ? "#FFFFFF" : tint, fontSize: size * (text.length > 1 ? 0.36 : 0.42), fontWeight: "600", letterSpacing: 0.2 }}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
