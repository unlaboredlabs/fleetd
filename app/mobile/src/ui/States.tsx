// The quiet pieces around content: an empty state, a count badge, and the banner that says the hub isn't live.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import type { HubState } from "../desktop";
import { space, type, useTheme } from "../theme";
import { Button } from "./Button";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { dur, ease, useReduceMotion } from "./motion";

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
  const fill = muted ? t.muted : tone === "warning" ? t.warning : t.accent;
  if (count === undefined) return <View style={[styles.dot, { backgroundColor: fill }]} accessibilityLabel={label ?? "Needs you"} />;
  return (
    <View style={[styles.badge, { backgroundColor: fill }]} accessibilityLabel={label ?? `${String(count)} waiting`}>
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

/**
 * What the link is doing, as Telegram's "Connecting…": a glass pill with a spinner while it isn't live, which says
 * "Connected" for a moment once it is back, and nothing otherwise. It fades in and out on the snap curve.
 */
export function ConnectionBanner({ state, onPairAgain }: { state: HubState; onPairAgain: () => void }) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const words = connectionWords(state);
  const wasDown = useRef(false);
  const [back, setBack] = useState(false);
  const down = words !== undefined;
  useEffect(() => {
    if (down) {
      // A link that drops for less than a moment doesn't say it's back.
      const timer = setTimeout(() => (wasDown.current = true), 1500);
      return () => clearTimeout(timer);
    }
    if (!wasDown.current) return;
    wasDown.current = false;
    setBack(true);
    const timer = setTimeout(() => setBack(false), 1600);
    return () => clearTimeout(timer);
  }, [down]);
  const fade = { entering: FadeIn.duration(reduce ? 0 : dur.quick).easing(ease.snap), exiting: FadeOut.duration(reduce ? 0 : dur.quick).easing(ease.snap) };
  if (words === undefined && !back) return null;
  return (
    <Animated.View {...fade} style={styles.bannerWrap} accessibilityLiveRegion="polite">
      <Glass style={styles.banner} {...(words?.refused === true ? { tint: t.dangerSoft } : {})}>
        {words === undefined ? (
          <Icon name="done" size={14} color={t.success} weight="bold" />
        ) : words.busy ? (
          <ActivityIndicator size="small" color={t.secondary} />
        ) : (
          <Icon name={words.refused ? "error" : "offline"} size={15} color={words.refused ? t.danger : t.secondary} />
        )}
        <Text style={[type.footnote, styles.bannerText, { color: words?.refused === true ? t.danger : t.label }]} numberOfLines={2}>
          {words?.text ?? "Connected"}
        </Text>
        {words?.refused === true ? <Button label="Pair Again" kind="filled" destructive size="small" onPress={onPairAgain} /> : null}
      </Glass>
    </Animated.View>
  );
}

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
  empty: { alignItems: "center", gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.xl },
  disc: { width: 76, height: 76, borderRadius: 38, alignItems: "center", justifyContent: "center", marginBottom: space.sm },
  bannerWrap: { alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.xs },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: 20, borderCurve: "continuous", paddingHorizontal: space.lg, paddingVertical: 9, maxWidth: "100%" },
  bannerText: { flexShrink: 1, fontWeight: "500" },
  center: { textAlign: "center" },
  dot: { width: 12, height: 12, borderRadius: 6 },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#FFFFFF", fontWeight: "600" },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginVertical: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 12, minHeight: 40 },
  lineText: { flex: 1 },
});
