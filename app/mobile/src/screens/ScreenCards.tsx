// A chat's live screens, as cards at the newest end of its thread, over the composer: one whose agent asks for you
// first ("Nova needs you", why, and Open), then any other screen running now (Nova's browser, what it's for, and Watch).
// Tapping one opens its live view (Screen.tsx), watching; Take Over is there.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useHub, type RootParams } from "../hubContext";
import { cardTitle, screenCards, type ScreenCard } from "../screen";
import type { Key } from "../store";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { Icon, type IconName } from "../ui/Icon";
import { PRESSED_OPACITY, rowIn, rowMove, rowOut, useReduceMotion } from "../ui/motion";

const ICON: Readonly<Record<ScreenCard["kind"], IconName>> = { browser: "browser", android: "device", ios: "device", linux_desktop: "desktop" };

export const ScreenCards = memo(function ScreenCards({ chatKey }: { chatKey: Key }) {
  const { state } = useHub();
  const cards = screenCards(state.screens[chatKey]);
  const who = state.projects?.[chatKey]?.title ?? "Its agent";
  const reduce = useReduceMotion();
  const nav = useNavigation<NavigationProp<RootParams>>();
  if (cards.length === 0) return null;
  return (
    <View style={styles.cards}>
      {cards.map((c) => (
        <Animated.View key={c.id} entering={rowIn(reduce)} exiting={rowOut} {...(reduce ? {} : { layout: rowMove })}>
          <Card card={c} who={who} onOpen={() => nav.navigate("Screen", { key: chatKey, sessionId: c.id })} />
        </Animated.View>
      ))}
    </View>
  );
});

function Card({ card, who, onOpen }: { card: ScreenCard; who: string; onOpen: () => void }) {
  const t = useTheme();
  const asking = card.reason !== undefined;
  const yours = card.control === "human";
  const title = cardTitle(card, who);
  const line = card.reason ?? card.purpose;
  const button = asking ? "Open" : yours ? "Open" : "Watch";
  const state = yours ? "You have control" : card.control === "handing_back" ? "Handing back" : asking ? "Waiting for you" : "Live";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${line}. ${state}`}
      accessibilityHint={asking ? "Opens the screen to take it over" : "Opens the screen to watch it"}
      onPress={() => {
        haptics.tap();
        onOpen();
      }}
      style={({ pressed }) => [styles.card, { backgroundColor: asking ? t.warningSoft : t.surface }, pressed && styles.pressed]}
    >
      <View style={[styles.tile, { backgroundColor: asking ? t.warning : t.accentFill }]}>
        <Icon name={asking ? "hand" : ICON[card.kind]} size={20} color="#FFFFFF" weight="semibold" />
      </View>
      <View style={styles.words}>
        <View style={styles.titleRow}>
          <Text style={[type.subhead, styles.strong, { color: t.label }]} numberOfLines={1}>
            {title}
          </Text>
          <View style={[styles.dot, { backgroundColor: asking ? t.warning : yours ? t.accent : t.success }]} />
          <Text style={[type.caption, { color: t.secondary }]} numberOfLines={1}>
            {state}
          </Text>
        </View>
        <Text style={[type.footnote, { color: asking ? t.label : t.secondary }]} numberOfLines={2}>
          {line}
        </Text>
      </View>
      <View style={[styles.button, { backgroundColor: asking ? t.accentFill : t.fillQuiet }]}>
        <Text style={[type.subhead, styles.strong, { color: asking ? t.onAccent : t.accent }]}>{button}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cards: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.sm },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: shape.card, borderCurve: "continuous", paddingVertical: space.md, paddingLeft: space.md, paddingRight: space.md },
  tile: { width: 40, height: 40, borderRadius: 12, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  words: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  strong: { fontWeight: "600", flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  button: { minHeight: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: "center" },
  pressed: { opacity: PRESSED_OPACITY },
});
