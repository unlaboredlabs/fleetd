// A chat's screens. Each one's card stands in the thread where it opened (Nova's browser, what it's for, and Watch;
// once it ended, it says so), and the ones live now are one strip over the composer, however many: "Nova needs you" and
// Open while one asks, the one screen and Watch, or "3 screens live" with their tiles, which opens their list
// (ScreenList.tsx). A finished task's screen, still open a while, isn't live there: it is only in that list. Tapping a
// card opens its live view (Screen.tsx), watching; Take Over is there.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useHub, type RootParams } from "../hubContext";
import { cardOf, cardTitle, liveNow, screenCards, stripOf, type ScreenCard } from "../screen";
import type { Key } from "../store";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { Icon, type IconName } from "../ui/Icon";
import { PRESSED_OPACITY, rowIn, rowOut, useReduceMotion } from "../ui/motion";

export const ICON: Readonly<Record<ScreenCard["kind"], IconName>> = { browser: "browser", android: "device", ios: "device", linux_desktop: "desktop", mac: "desktop" };

/** The chat's live screens as one strip over the composer; nothing with none. */
export const ScreenStrip = memo(function ScreenStrip({ chatKey }: { chatKey: Key }) {
  const t = useTheme();
  const { state } = useHub();
  const who = state.projects?.[chatKey]?.title ?? "Its agent";
  const strip = stripOf(screenCards(state.screens[chatKey]), who);
  const reduce = useReduceMotion();
  const nav = useNavigation<NavigationProp<RootParams>>();
  if (strip === undefined) return null;
  const open = () => {
    haptics.tap();
    if (strip.opens === undefined) nav.navigate("ScreenList", { key: chatKey });
    else nav.navigate("Screen", { key: chatKey, sessionId: strip.opens });
  };
  return (
    <Animated.View entering={rowIn(reduce)} exiting={rowOut} style={styles.cards}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${strip.title}. ${strip.line}`}
        accessibilityHint={strip.opens === undefined ? "Lists them" : strip.asking ? "Opens the screen to take it over" : "Opens the screen to watch it"}
        onPress={open}
        style={({ pressed }) => [styles.strip, { backgroundColor: strip.asking ? t.warningSoft : t.surface }, pressed && styles.pressed]}
      >
        {/* A deck: the first screen's tile in front, the next ones peeking out behind it, fainter. */}
        <View style={[styles.tiles, { width: TILE + (strip.kinds.length - 1) * TILE_STEP }]}>
          {strip.kinds.map((kind, i) => (
            <View
              key={i}
              style={[
                styles.smallTile,
                { left: i * TILE_STEP, top: i * 2, height: TILE - i * 4, zIndex: strip.kinds.length - i, opacity: 1 - i * 0.3, backgroundColor: strip.asking ? t.warning : t.accentDeep },
              ]}
            >
              {i === 0 ? <Icon name={strip.asking ? "hand" : ICON[kind]} size={18} color="#FFFFFF" weight="semibold" /> : null}
            </View>
          ))}
        </View>
        <View style={styles.words}>
          <View style={styles.titleRow}>
            <Text style={[type.subhead, styles.strong, { color: t.label }]} numberOfLines={1}>
              {strip.title}
            </Text>
            {strip.asking ? null : <View style={[styles.dot, { backgroundColor: t.success }]} />}
          </View>
          <Text style={[type.footnote, { color: strip.asking ? t.label : t.secondary }]} numberOfLines={1}>
            {strip.line}
          </Text>
        </View>
        {strip.opens === undefined ? (
          <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
        ) : (
          <View style={[styles.button, { backgroundColor: strip.asking ? t.accentFill : t.fillQuiet }]}>
            <Text style={[type.subhead, styles.strong, { color: strip.asking ? t.onAccent : t.accent }]}>{strip.asking ? "Open" : "Watch"}</Text>
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
});

/** A screen's card where it opened in the thread; nothing for one the chat doesn't list. */
export const ScreenRow = memo(function ScreenRow({ chatKey, sessionId }: { chatKey: Key; sessionId: string }) {
  const { state } = useHub();
  const nav = useNavigation<NavigationProp<RootParams>>();
  const listed = state.screens[chatKey]?.find((s) => s.sessionId === sessionId);
  if (listed === undefined) return null;
  const who = state.projects?.[chatKey]?.title ?? "Its agent";
  const finished = listed.state === "live" && !liveNow(listed);
  return (
    <View style={styles.cards}>
      <ScreenCardView card={cardOf(listed)} who={who} finished={finished} onOpen={() => nav.navigate("Screen", { key: chatKey, sessionId })} />
    </View>
  );
});

/** `finished`: still open, but its task is done: it says so, and is no longer live. */
export function ScreenCardView({ card, who, finished = false, onOpen }: { card: ScreenCard; who: string; finished?: boolean; onOpen: () => void }) {
  const t = useTheme();
  const asking = card.reason !== undefined && !card.ended;
  const yours = card.control === "human";
  const title = cardTitle(card, who);
  const line = card.reason ?? card.purpose;
  const button = asking ? "Open" : yours ? "Open" : "Watch";
  const state = card.ended ? "Ended" : finished ? "Task done" : yours ? "You have control" : card.control === "handing_back" ? "Handed back" : asking ? "Waiting for you" : "Live";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${line}. ${state}`}
      accessibilityHint={card.ended ? undefined : asking ? "Opens the screen to take it over" : "Opens the screen to watch it"}
      accessibilityState={{ disabled: card.ended }}
      disabled={card.ended}
      onPress={() => {
        haptics.tap();
        onOpen();
      }}
      style={({ pressed }) => [styles.card, { backgroundColor: asking ? t.warningSoft : t.surface }, pressed && styles.pressed]}
    >
      <View style={[styles.tile, { backgroundColor: asking ? t.warning : card.ended ? t.fillQuiet : t.accentDeep }]}>
        <Icon name={asking ? "hand" : ICON[card.kind]} size={20} color={card.ended ? t.secondary : "#FFFFFF"} weight="semibold" />
      </View>
      <View style={styles.words}>
        <View style={styles.titleRow}>
          <Text style={[type.subhead, styles.strong, { color: t.label }]} numberOfLines={1}>
            {title}
          </Text>
          {/* Asking, the card's warm ground and its hand say so: the title keeps the room. */}
          {asking ? null : (
            <>
              {card.ended ? null : <View style={[styles.dot, { backgroundColor: finished ? t.tertiary : yours ? t.accent : t.success }]} />}
              <Text style={[type.caption, styles.state, { color: t.secondary }]} numberOfLines={1}>
                {state}
              </Text>
            </>
          )}
        </View>
        <Text style={[type.footnote, { color: asking ? t.label : t.secondary }]} numberOfLines={2}>
          {line}
        </Text>
      </View>
      {card.ended ? null : (
        <View style={[styles.button, { backgroundColor: asking ? t.accentFill : t.fillQuiet }]}>
          <Text style={[type.subhead, styles.strong, { color: asking ? t.onAccent : t.accent }]}>{button}</Text>
        </View>
      )}
    </Pressable>
  );
}

/** The strip's deck: its front tile this big, each behind it peeking out this far. */
const TILE = 36;
const TILE_STEP = 7;

const styles = StyleSheet.create({
  cards: { paddingHorizontal: space.md, paddingTop: space.sm },
  card: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: shape.card, borderCurve: "continuous", paddingVertical: space.md, paddingLeft: space.md, paddingRight: space.md },
  strip: { flexDirection: "row", alignItems: "center", gap: space.md, borderRadius: shape.card, borderCurve: "continuous", minHeight: 52, paddingVertical: space.sm, paddingLeft: space.md, paddingRight: space.md },
  tile: { width: 40, height: 40, borderRadius: 12, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  tiles: { height: TILE },
  smallTile: { position: "absolute", width: TILE, borderRadius: 11, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  words: { flex: 1, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  strong: { fontWeight: "600", flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  state: { flexShrink: 0 },
  button: { minHeight: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: "center" },
  pressed: { opacity: PRESSED_OPACITY },
});
