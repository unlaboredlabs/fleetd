// The chat's search on its Info page (chatFind.ts): under iOS's own search bar, the filters on as tokens, a tap taking
// one off; with nothing asked yet, what to look for (a day, the links, the photos…) as a list's rows, as Messages'
// suggestions; then how many hits and the hits, newest first, who wrote each and when over its words with the matched
// ones in the label's ink, read on as the list nears its end. A hit opens the chat at its message (Chat.tsx), far back
// or not. A day is picked from a month's calendar in a sheet.
import { useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { canGoLater, monthOf, monthTitle, nextMonth, WEEKDAYS, weeksOf, type Month } from "../../calendar";
import { listTime } from "../../chatView";
import {
  asks,
  countLine,
  cursorOf,
  findInput,
  FIND_PAGE,
  FIND_REST_MS,
  HAS_WORDS,
  markedPieces,
  NO_FIND,
  noResults,
  queryKey,
  reduceFind,
  toggleHas,
  tokensOf,
  whoOf,
  withoutToken,
  type Find,
  type FindQuery,
} from "../../chatFind";
import type { ChatFindHas, ChatFindHit } from "../../desktop";
import type { Session } from "../../session";
import type { Key } from "../../store";
import { shape, space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { Icon, type IconName } from "../../ui/Icon";
import { PRESSED_OPACITY } from "../../ui/motion";
import { useNow } from "../time";

/**
 * The search's hits as the query changes: its first page once typing rests (a filter at once), the next as asked, an
 * answer for a query no longer asked dropped.
 */
export const useChatFind = (session: Session, key: Key, query: FindQuery, me: string | undefined): { find: Find; more: () => void; again: () => void } => {
  const [find, dispatch] = useReducer(reduceFind, NO_FIND);
  const on = asks(query);
  const qKey = on ? queryKey(query) : "";
  const [tries, setTries] = useState(0);
  const now = useRef({ query, me });
  now.current = { query, me };
  // Words wait for typing to rest; a filter changed, or a try again, goes at once.
  const words = query.words;
  const lastWords = useRef(words);
  useEffect(() => {
    dispatch({ t: "asked", key: qKey });
    if (qKey === "") return;
    const typing = lastWords.current !== words;
    lastWords.current = words;
    const timer = setTimeout(
      () => {
        const input = findInput(now.current.query, now.current.me, Date.now());
        void session.find(key, input, undefined, FIND_PAGE).then((r) => {
          if (r.ok) dispatch({ t: "page", key: qKey, hits: r.output.hits, more: r.output.more, next: false, count: r.output.count, countMore: r.output.countMore, indexing: r.output.indexing });
          else dispatch({ t: "failed", key: qKey, error: r.error });
        });
      },
      typing ? FIND_REST_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [session, key, qKey, words, tries]);
  // The next page, once asked for.
  const cursor = cursorOf(find);
  useEffect(() => {
    if (cursor === undefined) return;
    const asked = find.key;
    const input = findInput(now.current.query, now.current.me, Date.now());
    void session.find(key, input, cursor, FIND_PAGE).then((r) => {
      if (r.ok) dispatch({ t: "page", key: asked, hits: r.output.hits, more: r.output.more, next: true });
      else dispatch({ t: "failed", key: asked, error: r.error });
    });
  }, [session, key, cursor, find.key]);
  return { find, more: () => dispatch({ t: "next" }), again: () => setTries((n) => n + 1) };
};

/** What to look for with nothing asked yet: each a filter on, as Messages' and Telegram's suggestions. */
const SUGGESTED: ReadonlyArray<{ readonly has: ChatFindHas; readonly icon: IconName }> = [
  { has: "link", icon: "link" },
  { has: "image", icon: "photos" },
  { has: "file", icon: "fileDoc" },
  { has: "pr", icon: "pr" },
  { has: "pinned", icon: "pinned" },
];

export function FindView({
  query,
  setQuery,
  find,
  more,
  again,
  bot,
  me,
  onOpen,
  onPickDay,
}: {
  query: FindQuery;
  setQuery: (q: FindQuery) => void;
  find: Find;
  more: () => void;
  again: () => void;
  /** The chat's name: whose a lead's message is. */
  bot: string;
  me: string | undefined;
  onOpen: (hit: ChatFindHit) => void;
  onPickDay: () => void;
}) {
  const t = useTheme();
  const now = useNow();
  const tokens = tokensOf(query, bot, now.nowMs);
  const count = countLine(find);
  const head = (
    <View>
      {tokens.length === 0 ? null : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tokens} keyboardShouldPersistTaps="handled">
          {tokens.map((token) => (
            <Pressable
              key={token.t === "has" ? token.has : token.t}
              accessibilityRole="button"
              accessibilityLabel={token.label}
              accessibilityHint="Removes this filter"
              onPress={() => {
                haptics.tap();
                setQuery(withoutToken(query, token));
              }}
              style={({ pressed }) => [styles.token, { backgroundColor: t.accentSoft }, pressed && { opacity: PRESSED_OPACITY }]}
            >
              <Text style={[type.subhead, styles.strong, { color: t.label }]} maxFontSizeMultiplier={1.4}>
                {token.label}
              </Text>
              <Icon name="close" size={10} color={t.secondary} weight="bold" />
            </Pressable>
          ))}
        </ScrollView>
      )}
      {!asks(query) ? (
        <View style={[styles.group, { backgroundColor: t.cell }]}>
          <Suggestion icon="calendar" label="Pick a Day" onPress={onPickDay} first />
          {SUGGESTED.map((s) => (
            <Suggestion key={s.has} icon={s.icon} label={HAS_WORDS[s.has] ?? s.has} onPress={() => setQuery(toggleHas(query, s.has))} />
          ))}
        </View>
      ) : count !== undefined ? (
        <Text style={[type.footnote, styles.count, { color: t.secondary }]} accessibilityRole="header">
          {count}
        </Text>
      ) : null}
      {find.indexing === true ? <Text style={[type.footnote, styles.count, { color: t.secondary }]}>Older messages are still being indexed.</Text> : null}
    </View>
  );
  return (
    <FlatList
      data={asks(query) ? find.hits : []}
      keyExtractor={(h) => h.messageId}
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.list}
      ListHeaderComponent={head}
      onEndReachedThreshold={0.6}
      onEndReached={more}
      renderItem={({ item, index }) => <HitRow hit={item} first={index === 0} last={index === find.hits.length - 1} who={whoOf(item, me, bot)} when={listTime(item.createdAt, now)} onPress={() => onOpen(item)} />}
      ListFooterComponent={
        find.reading !== null && asks(query) ? (
          <ActivityIndicator style={styles.reading} color={t.secondary} />
        ) : find.error !== undefined ? (
          <Pressable accessibilityRole="button" accessibilityHint="Searches again" onPress={again} style={styles.reading}>
            <Text style={[type.footnote, styles.center, { color: t.secondary }]}>
              {`The search didn't finish. ${find.error.message} `}
              <Text style={{ color: t.accent }}>Try Again</Text>
            </Text>
          </Pressable>
        ) : noResults(find) && asks(query) ? (
          <Text style={[type.title3, styles.none, { color: t.secondary }]}>No Results</Text>
        ) : undefined
      }
    />
  );
}

function Suggestion({ icon, label, onPress, first = false }: { icon: IconName; label: string; onPress: () => void; first?: boolean }) {
  const t = useTheme();
  return (
    <View>
      {first ? null : <View style={[styles.separator, styles.tiledSeparator, { backgroundColor: t.separator }]} />}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          haptics.tap();
          onPress();
        }}
        style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: t.fillQuiet }]}
      >
        <Icon name={icon} size={18} color={t.accent} />
        <Text style={[type.body, { color: t.label }]}>{label}</Text>
      </Pressable>
    </View>
  );
}

function HitRow({ hit, first, last, who, when, onPress }: { hit: ChatFindHit; first: boolean; last: boolean; who: string; when: string; onPress: () => void }) {
  const t = useTheme();
  const pieces = markedPieces(hit.text, hit.marks);
  return (
    <View style={[styles.hitCell, { backgroundColor: t.cell }, first && styles.groupTop, last && styles.groupBottom]}>
      {first ? null : <View style={[styles.separator, { backgroundColor: t.separator }]} />}
      <Pressable accessibilityRole="button" accessibilityLabel={`${who}, ${when}: ${hit.text}`} accessibilityHint="Opens the chat at this message" onPress={onPress}>
        {({ pressed }) => (
          <View style={[styles.hit, pressed && { backgroundColor: t.fillQuiet }]}>
            <View style={styles.hitTop}>
              <Text style={[type.subhead, styles.who, { color: t.label }]} numberOfLines={1}>
                {who}
              </Text>
              <Text style={[type.footnote, { color: t.secondary }]}>{when}</Text>
            </View>
            <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
              {pieces.map((p, i) =>
                p.marked ? (
                  <Text key={i} style={[styles.strong, { color: t.label }]}>
                    {p.text}
                  </Text>
                ) : (
                  p.text
                ),
              )}
            </Text>
          </View>
        )}
      </Pressable>
    </View>
  );
}

/** A day picked from a month's calendar, in a sheet: the days after today can't be. */
export function DaySheet({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (day: string) => void }) {
  const t = useTheme();
  const now = useNow();
  const [month, setMonth] = useState<Month>(() => monthOf(Date.now()));
  if (!open) return null;
  const weeks = weeksOf(month, now.nowMs);
  const later = canGoLater(month, now.nowMs);
  const arrow = (label: string, icon: "pageBack" | "pageForward", by: number, enabled: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      hitSlop={10}
      onPress={() => {
        haptics.tap();
        setMonth((m) => nextMonth(m, by));
      }}
      style={({ pressed }) => [styles.arrow, pressed && { opacity: PRESSED_OPACITY }]}
    >
      <Icon name={icon} size={18} color={enabled ? t.accent : t.tertiary} weight="semibold" />
    </Pressable>
  );
  return (
    <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: t.grouped }]} onAccessibilityEscape={onClose}>
        <View style={styles.sheetHead}>
          <Text style={[type.headline, { color: t.label }]} accessibilityRole="header">
            Pick a Day
          </Text>
          <Button label="Cancel" kind="plain" onPress={onClose} />
        </View>
        <View style={[styles.calendar, { backgroundColor: t.cell }]}>
          <View style={styles.monthRow}>
            <Text style={[type.headline, styles.grow, { color: t.label }]} accessibilityRole="header">
              {monthTitle(month)}
            </Text>
            {arrow("Previous month", "pageBack", -1, true)}
            {arrow("Next month", "pageForward", 1, later)}
          </View>
          <View style={styles.week}>
            {WEEKDAYS.map((d, i) => (
              <Text key={i} style={[type.caption, styles.weekday, { color: t.tertiary }]} importantForAccessibility="no">
                {d}
              </Text>
            ))}
          </View>
          {weeks.map((week, w) => (
            <View key={w} style={styles.week}>
              {week.map((cell, i) =>
                cell === null ? (
                  <View key={i} style={styles.cell} />
                ) : (
                  <Pressable
                    key={i}
                    accessibilityRole="button"
                    accessibilityLabel={new Date(`${cell.day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                    accessibilityState={{ disabled: cell.future }}
                    disabled={cell.future}
                    onPress={() => {
                      haptics.tap();
                      onPick(cell.day);
                    }}
                    style={styles.cell}
                  >
                    {({ pressed }) => (
                      <View style={[styles.dayDisc, cell.today && { backgroundColor: t.accentSoft }, pressed && { backgroundColor: t.fillQuiet }]}>
                        <Text style={[type.body, cell.today && styles.strong, { color: cell.future ? t.tertiary : cell.today ? t.accent : t.label }]} maxFontSizeMultiplier={1.3}>
                          {String(cell.date)}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                ),
              )}
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const DAY = 40;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grow: { flex: 1 },
  center: { textAlign: "center" },
  strong: { fontWeight: "600" },
  list: { paddingBottom: space.xxl },
  tokens: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs },
  token: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, borderRadius: 16, borderCurve: "continuous", paddingLeft: 12, paddingRight: 10 },
  group: { marginHorizontal: space.lg, marginTop: space.md, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  suggestion: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  tiledSeparator: { marginLeft: space.lg + 18 + space.md },
  count: { paddingHorizontal: space.lg + space.lg, paddingTop: space.md, paddingBottom: 7 },
  hitCell: { marginHorizontal: space.lg, overflow: "hidden" },
  groupTop: { borderTopLeftRadius: shape.group, borderTopRightRadius: shape.group, marginTop: space.xs },
  groupBottom: { borderBottomLeftRadius: shape.group, borderBottomRightRadius: shape.group },
  hit: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 10 },
  hitTop: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  who: { flex: 1, fontWeight: "600" },
  reading: { paddingVertical: space.lg, paddingHorizontal: space.lg },
  none: { textAlign: "center", marginTop: space.xxl },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: space.lg, paddingRight: space.sm, paddingVertical: space.sm },
  calendar: { marginHorizontal: space.lg, marginTop: space.sm, borderRadius: shape.group, borderCurve: "continuous", padding: space.md },
  monthRow: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.xs, paddingBottom: space.sm },
  arrow: { padding: space.xs },
  week: { flexDirection: "row" },
  weekday: { flex: 1, textAlign: "center", paddingVertical: space.xs, fontWeight: "600" },
  cell: { flex: 1, alignItems: "center", paddingVertical: 2 },
  dayDisc: { width: DAY, height: DAY, borderRadius: DAY / 2, alignItems: "center", justifyContent: "center" },
});
