// The quiet pieces around content: an empty state, a count badge, and the line that says the hub isn't live.
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { HubState } from "../desktop";
import { space, type, useTheme } from "../theme";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  const t = useTheme();
  return (
    <View style={styles.empty}>
      <Icon name={icon} size={44} color={t.tertiary} />
      <Text style={[type.title3, { color: t.label }, styles.center]}>{title}</Text>
      {body === undefined ? null : <Text style={[type.subhead, { color: t.secondary }, styles.center]}>{body}</Text>}
      {action === undefined ? null : <Button label={action.label} kind="tinted" size="small" onPress={action.onPress} />}
    </View>
  );
}

/** A count, or a dot when there is none to give. */
export function Badge({ count }: { count?: number }) {
  const t = useTheme();
  if (count === undefined) return <View style={[styles.dot, { backgroundColor: t.accent }]} accessibilityLabel="Needs you" />;
  return (
    <View style={[styles.badge, { backgroundColor: t.accent }]} accessibilityLabel={`${String(count)} waiting`}>
      <Text style={[type.footnote, styles.badgeText]} maxFontSizeMultiplier={1.4}>
        {count > 99 ? "99+" : String(count)}
      </Text>
    </View>
  );
}

/** What the link is doing when it isn't live, in a few words; undefined while it is. */
export const connectionWords = (state: HubState): { text: string; busy: boolean; refused: boolean } | undefined => {
  switch (state.phase) {
    case "live":
    case "unpaired":
      return undefined;
    case "connecting":
      return { text: "Connecting…", busy: true, refused: false };
    case "retrying":
      return { text: `${state.reason}. Trying again…`, busy: true, refused: false };
    default:
      return { text: state.message, busy: false, refused: state.phase === "refused" };
  }
};

/** Says what the link is doing when it isn't live; nothing while it is. */
export function ConnectionLine({ state, onPairAgain }: { state: HubState; onPairAgain: () => void }) {
  const t = useTheme();
  const words = connectionWords(state);
  if (words === undefined) return null;
  return (
    <View style={[styles.line, { backgroundColor: words.refused ? t.dangerSoft : t.fillQuiet }]} accessibilityLiveRegion="polite">
      {words.busy ? <ActivityIndicator size="small" color={t.secondary} /> : <Icon name={words.refused ? "error" : "offline"} size={16} color={words.refused ? t.danger : t.secondary} />}
      <Text style={[type.footnote, styles.lineText, { color: words.refused ? t.danger : t.secondary }]}>{words.text}</Text>
      {words.refused ? <Button label="Pair Again" kind="filled" destructive size="small" onPress={onPairAgain} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingVertical: 64 },
  center: { textAlign: "center" },
  dot: { width: 12, height: 12, borderRadius: 6 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FFFFFF", fontWeight: "600" },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginVertical: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 12, minHeight: 40 },
  lineText: { flex: 1 },
});
