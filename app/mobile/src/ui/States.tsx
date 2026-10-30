// The quiet pieces around content: an empty state and a count badge. The link's state is in the title (linkHeader.tsx).
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { space, type, useTheme } from "../theme";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";

/**
 * Nothing here yet: a symbol in a soft disc, a title, a line on what comes, and the one thing to do. Only as tall as
 * that, a little way down the screen: a list under iOS's automatic insets that stretched it to the screen's height
 * would scroll by its bars' height past it (emptyScroll.test.ts).
 */
export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  const t = useTheme();
  const { height } = useWindowDimensions();
  return (
    <View style={[styles.empty, { paddingTop: Math.round(height * EMPTY_DROP) }]}>
      <View style={[styles.disc, { backgroundColor: t.accentSoft }]}>
        <Icon name={icon} size={34} color={t.accent} />
      </View>
      <Text style={[type.title3, { color: t.label }, styles.center]}>{title}</Text>
      {body === undefined ? null : <Text style={[type.subhead, { color: t.secondary }, styles.center]}>{body}</Text>}
      {action === undefined ? null : <Button label={action.label} kind="tinted" size="small" onPress={action.onPress} />}
    </View>
  );
}

/** How far down the screen an empty state starts, as a share of its height: about the middle of what the bars leave. */
const EMPTY_DROP = 0.14;

/** A count, or a dot when there is none to give; grey for a muted chat. */
export function Badge({ count, muted = false, label, tone = "accent" }: { count?: number; muted?: boolean; label?: string; tone?: "accent" | "warning" }) {
  const t = useTheme();
  const fill = muted ? t.muted : tone === "warning" ? t.warning : t.accentFill;
  if (count === undefined) return <View style={[styles.dot, { backgroundColor: fill }]} accessibilityLabel={label ?? "Needs you"} />;
  return (
    <View style={[styles.badge, { backgroundColor: fill }]} accessibilityLabel={label ?? `${String(count)} waiting`}>
      <Text style={[type.footnote, styles.badgeText]} maxFontSizeMultiplier={1.4}>
        {count > 99 ? "99+" : String(count)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.xl },
  disc: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  center: { textAlign: "center" },
  dot: { width: 12, height: 12, borderRadius: 6 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FFFFFF", fontWeight: "600" },
});
