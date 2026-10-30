// iOS's buttons: filled (the one primary action), tinted (a secondary one), and plain text. Destructive turns any of
// them red. Large is a full-width 50-point button, as at the bottom of a sheet; every size keeps a 44-point target.
// On iOS 26 a filled button is prominent Liquid Glass in its color, as the system's own.
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { shape, space, TOUCH, type, useTheme } from "../theme";
import { Glass, liquidGlass } from "./Glass";
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
  const solid = destructive ? t.danger : t.accentFill;
  // A disabled button greys out as iOS's do, rather than fading its color.
  const off = disabled && !busy;
  const fill = off && kind !== "plain" ? t.fillQuiet : kind === "filled" ? solid : kind === "tinted" ? (destructive ? t.dangerSoft : t.accentSoft) : "transparent";
  const ink = off ? t.tertiary : kind === "filled" ? t.onAccent : hue;
  const height = size === "large" ? 50 : size === "medium" ? TOUCH : 34;
  const radius = shape.capsule || size === "small" ? height / 2 : size === "large" ? 14 : 12;
  const glass = liquidGlass && kind === "filled" && !off;
  const button = (
    <Pressable
      accessibilityRole="button"
      // The words alone: VoiceOver would read the symbol's name too.
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={size === "small" ? 5 : 0}
      style={({ pressed }) => [
        styles.base,
        { minHeight: height, borderRadius: radius, backgroundColor: glass ? "transparent" : fill },
        kind === "plain" ? styles.plain : { paddingHorizontal: size === "small" ? 14 : space.lg },
        !glass && grow && styles.grow,
        !glass && size === "large" && styles.wide,
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
  if (!glass) return button;
  return (
    <Glass interactive tint={solid} style={[{ borderRadius: radius }, grow && styles.grow, size === "large" && styles.wide]}>
      {button}
    </Glass>
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
