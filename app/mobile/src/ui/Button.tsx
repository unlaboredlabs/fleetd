// iOS's buttons: filled (the one primary action), tinted (a secondary one), and plain text. Destructive turns any of
// them red. Large is a full-width 50-point button, as at the bottom of a sheet; every size keeps a 44-point target.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { space, TOUCH, type, useTheme } from "../theme";
import { Icon, type IconName } from "./Icon";

export function Button({
  label,
  onPress,
  kind = "filled",
  destructive = false,
  size = "medium",
  icon,
  busy = false,
  disabled = false,
  grow = false,
}: {
  label: string;
  onPress: () => void;
  kind?: "filled" | "tinted" | "plain";
  destructive?: boolean;
  size?: "large" | "medium" | "small";
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  /** Share a row's width with its neighbours. */
  grow?: boolean;
}) {
  const t = useTheme();
  const hue = destructive ? t.danger : t.accent;
  // A disabled button greys out as iOS's do, rather than fading its color.
  const off = disabled && !busy;
  const fill = off && kind !== "plain" ? t.fillQuiet : kind === "filled" ? hue : kind === "tinted" ? (destructive ? t.dangerSoft : t.accentSoft) : "transparent";
  const ink = off ? t.tertiary : kind === "filled" ? t.onAccent : hue;
  const height = size === "large" ? 50 : size === "medium" ? TOUCH : 34;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={size === "small" ? 5 : 0}
      style={({ pressed }) => [
        styles.base,
        { minHeight: height, borderRadius: size === "large" ? 14 : size === "medium" ? 12 : height / 2, backgroundColor: fill },
        kind === "plain" ? styles.plain : { paddingHorizontal: size === "small" ? 14 : space.lg },
        grow && styles.grow,
        size === "large" && styles.wide,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <View style={styles.row}>
          {icon === undefined ? null : <Icon name={icon} size={size === "small" ? 15 : 18} color={ink} weight="semibold" />}
          <Text style={[size === "small" ? type.subhead : type.headline, { color: ink }, size === "small" && styles.smallText]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center" },
  plain: { paddingHorizontal: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  grow: { flex: 1 },
  wide: { alignSelf: "stretch" },
  pressed: { opacity: 0.6 },
  smallText: { fontWeight: "600" },
});
