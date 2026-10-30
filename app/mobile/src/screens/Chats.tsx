// Chats, as Telegram and Messages list them: one list, your pinned chats on top, then whatever spoke last, each a
// full-bleed row with its avatar, its newest message and when, and a count of what you haven't read (grey when
// muted). Filters above it narrow it to the unread, the Navis or the projects. Swipe a row right to mark it read or
// unread or to pin it, left to mute it; hold it for the same as a menu. Pin, mute and read live on this phone
// (prefs.ts). Search finds chats by name and messages by their words (search.ts). Pulling down reads the hub again.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated from "react-native-reanimated";
import { listTime } from "../chatView";
import { useHub, type RootParams } from "../hubContext";
import { chatList, type ChatRow, type Filter } from "../lists";
import { MAX_PINNED } from "../prefs";
import { dispatchPrefs, usePrefs } from "../prefsStore";
import { matchesName, queryOf, searchMessages, type MessageHit } from "../search";
import type { ChatMessage } from "../desktop";
import type { Key } from "../store";
import { space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { Glass, GlassGroup, liquidGlass } from "../ui/Glass";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem, type Rect } from "../ui/Menu";
import { rowIn, rowMove, rowOut, useReduceMotion } from "../ui/motion";
import { rowFace } from "../ui/rowFace";
import { SkeletonRow } from "../ui/Skeleton";
import { Badge, ConnectionBanner, EmptyState } from "../ui/States";
import { useRefreshing } from "./refresh";
import { useNow } from "./time";

const AVATAR = 56;

/**
 * The search field, under the large title as in Messages (iOS 26 would put it in a toolbar, which tabs don't show). It
 * has to be in the screen's options from its first frame (App.tsx): one set later never shows. Chats adds its handlers.
 */
export const searchBar = { placeholder: "Search", placement: "stacked", hideWhenScrolling: false } as const;

const FILTERS: ReadonlyArray<{ readonly id: Filter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "navis", label: "Navis" },
  { id: "projects", label: "Projects" },
];

type Line = { readonly t: "head"; readonly key: string; readonly title: string } | { readonly t: "chat"; readonly key: string; readonly row: ChatRow } | { readonly t: "hit"; readonly key: string; readonly hit: MessageHit };

/** Keys the list held when it was last drawn: one that turns up later rises in (ui/motion.ts rowIn), once. */
const useArrived = (keys: readonly string[]): ReadonlySet<string> => {
  const known = useRef<Set<string> | null>(null);
  const joined = keys.join("\n");
  return useMemo(() => {
    const now = joined === "" ? [] : joined.split("\n");
    const fresh = known.current === null ? new Set<string>() : new Set(now.filter((k) => !known.current?.has(k)));
    known.current = new Set(now);
    return fresh;
  }, [joined]);
};

export function Chats({ navigation }: NativeStackScreenProps<{ Chats: undefined }, "Chats">) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const { state, session, pairAgain } = useHub();
  const prefs = usePrefs();
  const root = useNavigation<NavigationProp<RootParams>>();
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const refreshing = useRefreshing(state.projects, state.hub.phase);
  const query = queryOf(typed);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ...searchBar,
        onChangeText: (e) => setTyped(e.nativeEvent.text),
        onCancelButtonPress: () => setTyped(""),
        onFocus: () => void session.readCorpus(),
        tintColor: t.accent,
      },
    });
  }, [navigation, t.accent, session]);

  // Chats seen for the first time count as read up to what they hold: a new phone doesn't open on a wall of counts.
  const lastSeqs = useMemo(() => Object.fromEntries(Object.entries(state.chatStates).map(([k, c]) => [k, c.lastSeq])), [state.chatStates]);
  useLayoutEffect(() => dispatchPrefs({ t: "seen", lastSeqs }), [lastSeqs]);

  const all = chatList(state, prefs);
  const shown = chatList(state, prefs, filter);
  const lines = useMemo((): readonly Line[] => {
    if (shown === undefined || all === undefined) return [];
    if (query === "") return shown.map((row) => ({ t: "chat", key: row.key, row }));
    const chats = all.filter((r) => matchesName(r.project.title, query));
    const sources: Record<Key, ChatMessage[]> = {};
    for (const [k, ms] of [...Object.entries(state.corpus), ...Object.entries(state.latest), ...Object.entries(state.chats).map(([k, c]) => [k, c.messages] as const)]) sources[k] = [...(sources[k] ?? []), ...ms];
    const hits = searchMessages(sources, query).filter((h) => state.projects?.[h.key] !== undefined);
    return [
      ...(chats.length === 0 ? [] : [{ t: "head" as const, key: "h:chats", title: "Chats" }, ...chats.map((row) => ({ t: "chat" as const, key: `c:${row.key}`, row }))]),
      ...(hits.length === 0 ? [] : [{ t: "head" as const, key: "h:messages", title: "Messages" }, ...hits.map((hit) => ({ t: "hit" as const, key: `m:${hit.messageId}`, hit }))]),
    ];
  }, [shown, all, query, state.corpus, state.latest, state.chats, state.projects]);
  const arrived = useArrived(lines.map((l) => l.key));

  const [held, setHeld] = useState<{ at: Rect; node: ReactNode; items: readonly MenuItem[] } | null>(null);
  const open = (key: Key, messageId?: string) => root.navigate("Chat", messageId === undefined ? { key } : { key, messageId });
  const unreadCount = all?.filter((r) => (r.unread > 0 && !r.muted) || r.markedUnread).length ?? 0;

  const empty =
    shown === undefined ? (
      <View>
        {[0.9, 0.6, 0.8, 0.5, 0.7, 0.6].map((w, i) => (
          <SkeletonRow key={i} wide={w} />
        ))}
      </View>
    ) : query !== "" ? (
      <EmptyState icon="search" title="No Results" body={`Nothing in your chats says “${query}”.`} />
    ) : filter === "unread" ? (
      <EmptyState icon="doneAll" title="All Caught Up" body="Nothing you haven't read." />
    ) : (
      <EmptyState icon="bubble" title="No Chats Yet" body="Make a Navi or add a project in the desktop app, and its chat shows up here." />
    );

  return (
    <>
      <Animated.FlatList
        data={lines}
        keyExtractor={(l) => l.key}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        {...(reduce ? {} : { itemLayoutAnimation: rowMove })}
        refreshControl={
          <RefreshControl
            refreshing={refreshing.on}
            onRefresh={() => {
              haptics.tap();
              refreshing.start(() => session.refresh());
            }}
            tintColor={t.secondary}
          />
        }
        ListHeaderComponent={
          <View>
            <ConnectionBanner state={state.hub} onPairAgain={pairAgain} />
            {query === "" && all !== undefined && all.length > 0 ? <Filters value={filter} onChange={setFilter} unread={unreadCount} /> : null}
          </View>
        }
        ListEmptyComponent={empty}
        renderItem={({ item: line, index }) => {
          const next = lines[index + 1];
          const separator = next !== undefined && next.t !== "head";
          return (
            <Animated.View {...(arrived.has(line.key) ? { entering: rowIn(reduce) } : {})} exiting={rowOut}>
              {line.t === "head" ? (
                <Text style={[type.subhead, styles.section, { color: t.secondary }]} accessibilityRole="header">
                  {line.title}
                </Text>
              ) : line.t === "hit" ? (
                <HitRow hit={line.hit} title={state.projects?.[line.hit.key]?.title ?? ""} navi={all?.find((r) => r.key === line.hit.key)?.navi ?? false} separator={separator} onPress={() => open(line.hit.key, line.hit.messageId)} />
              ) : (
                <SwipeRow row={line.row} separator={separator} onPress={() => open(line.row.key)} onHold={setHeld} />
              )}
            </Animated.View>
          );
        }}
      />
      <Menu at={held?.at ?? null} preview={held?.node} items={held?.items ?? []} onClose={() => setHeld(null)} />
    </>
  );
}

/**
 * The list's filters, as Telegram's folder tabs on iOS 26: a Liquid Glass capsule each, as the tab bar's, the chosen
 * one tinted with the accent rather than filled. Without glass, quiet fills and the accent.
 */
function Filters({ value, onChange, unread }: { value: Filter; onChange: (f: Filter) => void; unread: number }) {
  const t = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} accessibilityRole="tablist">
      <GlassGroup style={styles.filterGroup} spacing={4}>
        {FILTERS.map((f) => {
          const on = f.id === value;
          const face = (
            <>
              <Text style={[type.subhead, styles.filterText, { color: on ? t.onAccent : t.label }]}>{f.label}</Text>
              {f.id === "unread" && unread > 0 ? (
                <View style={[styles.filterCount, { backgroundColor: on ? t.onAccent : t.accent }]}>
                  <Text style={[type.caption2, styles.filterCountText, { color: on ? t.accent : t.onAccent }]}>{unread}</Text>
                </View>
              ) : null}
            </>
          );
          return (
            <Pressable
              key={f.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={f.id === "unread" && unread > 0 ? `${f.label}, ${String(unread)}` : f.label}
              onPress={() => {
                if (on) return;
                haptics.select();
                onChange(f.id);
              }}
            >
              {liquidGlass ? (
                <Glass interactive style={styles.filter} {...(on ? { tint: t.accent } : {})}>
                  {face}
                </Glass>
              ) : (
                <View style={[styles.filter, { backgroundColor: on ? t.accent : t.fillQuiet }]}>{face}</View>
              )}
            </Pressable>
          );
        })}
      </GlassGroup>
    </ScrollView>
  );
}

/**
 * What can be done to a chat from the list: swiped, held, or with VoiceOver's actions. Read is up to the chat's newest
 * message, so what comes after counts again. A pin past the most says why it didn't take.
 */
const rowActions = (row: ChatRow, pinsFull: boolean): ReadonlyArray<MenuItem & { readonly color: "accent" | "success" | "warning" }> => {
  const unread = row.unread > 0 || row.markedUnread;
  const pin = () => {
    if (row.pinned || !pinsFull) return dispatchPrefs({ t: "pin", key: row.key, on: !row.pinned });
    haptics.warning();
    Alert.alert(`You can pin up to ${String(MAX_PINNED)} chats`, "Unpin one to pin this one.");
  };
  return [
    {
      label: unread ? "Mark as Read" : "Mark as Unread",
      icon: unread ? "read" : "unread",
      color: "accent",
      onPress: () => dispatchPrefs(unread ? { t: "read", key: row.key, seq: row.lastSeq } : { t: "unread", key: row.key }),
    },
    { label: row.pinned ? "Unpin" : "Pin", icon: row.pinned ? "unpin" : "pin", color: "success", onPress: pin },
    { label: row.muted ? "Unmute" : "Mute", icon: row.muted ? "unmute" : "mute", color: "warning", onPress: () => dispatchPrefs({ t: "mute", key: row.key, on: !row.muted }) },
  ];
};

/** A chat row that swipes: right for read and pin, left for mute, each a full-height button as Telegram's. */
function SwipeRow({ row, separator, onPress, onHold }: { row: ChatRow; separator: boolean; onPress: () => void; onHold: (h: { at: Rect; node: ReactNode; items: readonly MenuItem[] }) => void }) {
  const t = useTheme();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const swipe = useRef<SwipeableMethods>(null);
  const acts = rowActions(row, usePrefs().pinned.length >= MAX_PINNED);
  const [read, pin, mute] = acts as [(typeof acts)[number], (typeof acts)[number], (typeof acts)[number]];
  const tone = { accent: t.accent, success: t.success, warning: t.warning } as const;
  const button = (a: (typeof acts)[number]) => (
    <Pressable
      key={a.label}
      accessibilityRole="button"
      accessibilityLabel={a.label}
      onPress={() => {
        haptics.select();
        swipe.current?.close();
        a.onPress();
      }}
      style={[styles.action, { backgroundColor: tone[a.color] }]}
    >
      <Icon name={a.icon} size={22} color="#FFFFFF" />
      <Text style={[type.caption, styles.actionText]} numberOfLines={1} adjustsFontSizeToFit>
        {a.label.replace("Mark as ", "")}
      </Text>
    </Pressable>
  );
  // In a view of its own, so holding it can measure where it is.
  const face = <ChatRowFace row={row} separator={separator} />;
  return (
    <ReanimatedSwipeable
      ref={swipe}
      friction={1.6}
      overshootLeft={false}
      overshootRight={false}
      leftThreshold={48}
      rightThreshold={48}
      onSwipeableWillOpen={() => haptics.select()}
      // VoiceOver has them as the row's actions instead.
      renderLeftActions={() => (
        <View style={styles.actions} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[read, pin].map(button)}
        </View>
      )}
      renderRightActions={() => (
        <View style={styles.actions} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {button(mute)}
        </View>
      )}
    >
      <Pressable
        ref={ref}
        collapsable={false}
        onPress={onPress}
        onLongPress={() =>
          ref.current?.measureInWindow((x: number, y: number, width: number, height: number) => onHold({ at: { x, y, width, height }, node: <View style={{ backgroundColor: t.bg }}>{face}</View>, items: acts }))
        }
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={rowLabel(row)}
        accessibilityActions={acts.map((a) => ({ name: a.label, label: a.label }))}
        onAccessibilityAction={(e) => acts.find((a) => a.label === e.nativeEvent.actionName)?.onPress()}
        style={({ pressed }) => [{ backgroundColor: rowFace(t, pressed) }]}
      >
        {face}
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const rowLabel = (row: ChatRow): string => {
  const line = row.working ? "Working…" : (row.preview ?? row.want ?? (row.empty ? "No messages yet" : ""));
  const counts = [
    row.pinned ? "Pinned" : undefined,
    row.muted ? "Muted" : undefined,
    row.unread > 0 ? `${String(row.unread)} unread` : row.markedUnread ? "Unread" : undefined,
    row.approvals > 0 ? `${String(row.approvals)} waiting for approval` : line === row.want ? undefined : row.want,
  ];
  return [row.project.title, line, ...counts].filter((s) => s !== undefined && s !== "").join(", ");
};

function ChatRowFace({ row, separator }: { row: ChatRow; separator: boolean }) {
  const t = useTheme();
  const now = useNow();
  // Blank until its newest messages are read, rather than a stand-in that flickers away.
  const line = row.working ? "Working…" : (row.preview ?? row.want ?? (row.empty ? "No messages yet" : ""));
  const accentLine = row.working || (row.preview === undefined && row.want !== undefined);
  const unread = row.unread > 0;
  const mine = !accentLine && line.startsWith("You: ");
  return (
    <View style={styles.row}>
      <Avatar name={row.project.title} navi={row.navi} size={AVATAR} />
      <View style={styles.body}>
        <View style={styles.top}>
          <View style={styles.name}>
            <Text style={[type.headline, styles.nameText, { color: t.label }]} numberOfLines={1}>
              {row.project.title}
            </Text>
            {row.muted ? <Icon name="mute" size={13} color={t.tertiary} /> : null}
          </View>
          <Text style={[type.subhead, { color: unread && !row.muted ? t.accent : t.secondary }]} numberOfLines={1}>
            {listTime(row.at, now)}
          </Text>
        </View>
        <View style={styles.bottom}>
          <Text style={[type.subhead, styles.preview, { color: accentLine ? t.accent : t.secondary }]} numberOfLines={accentLine ? 1 : 2}>
            {mine ? <Text style={{ color: t.label }}>You: </Text> : null}
            {mine ? line.slice(5) : line}
          </Text>
          <View style={styles.marks}>
            {row.approvals > 0 ? <Badge count={row.approvals} tone="warning" label={`${String(row.approvals)} waiting for approval`} /> : null}
            {unread ? (
              <Badge count={row.unread} muted={row.muted} label={`${String(row.unread)} unread`} />
            ) : row.markedUnread ? (
              <Badge muted={row.muted} label="Unread" />
            ) : row.want !== undefined && row.approvals === 0 ? (
              <Badge />
            ) : row.pinned ? (
              <Icon name="pinned" size={14} color={t.tertiary} />
            ) : null}
          </View>
        </View>
        {separator ? <View style={[styles.separator, { backgroundColor: t.separator }]} /> : null}
      </View>
    </View>
  );
}

/** A message that says what was searched for: its chat, when, and its words with the match in bold. */
function HitRow({ hit, title, navi, separator, onPress }: { hit: MessageHit; title: string; navi: boolean; separator: boolean; onPress: () => void }) {
  const t = useTheme();
  const now = useNow();
  const [from, to] = hit.match;
  const who = hit.author === "human" ? "You: " : "";
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${title}, ${who}${hit.snippet}`}>
      {({ pressed }) => (
        <View style={[styles.row, styles.hitRow, pressed && { backgroundColor: t.fillQuiet }]}>
          <Avatar name={title} navi={navi} size={44} />
          <View style={[styles.body, styles.hitBody]}>
            <View style={styles.top}>
              <Text style={[type.headline, styles.nameText, { color: t.label }]} numberOfLines={1}>
                {title}
              </Text>
              <Text style={[type.footnote, { color: t.secondary }]}>{listTime(hit.at, now)}</Text>
            </View>
            <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
              {who === "" ? null : <Text style={{ color: t.label }}>{who}</Text>}
              {hit.snippet.slice(0, from)}
              <Text style={[styles.match, { color: t.label }]}>{hit.snippet.slice(from, to)}</Text>
              {hit.snippet.slice(to)}
            </Text>
            {separator ? <View style={[styles.separator, { backgroundColor: t.separator }]} /> : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const ACTION_W = 78;

const styles = StyleSheet.create({
  section: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs, fontWeight: "600" },
  filters: { paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.md },
  filterGroup: { flexDirection: "row", gap: space.sm },
  filter: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 18, borderCurve: "continuous", paddingHorizontal: 16, minHeight: 36 },
  filterText: { fontWeight: "600" },
  filterCount: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: "center", justifyContent: "center" },
  filterCountText: { fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, minHeight: 78 },
  hitRow: { minHeight: 68 },
  body: { flex: 1, alignSelf: "stretch", justifyContent: "center", gap: 1, paddingRight: space.lg, paddingVertical: 10 },
  hitBody: { paddingVertical: 8 },
  top: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  name: { flex: 1, flexDirection: "row", alignItems: "center", gap: 4 },
  nameText: { flexShrink: 1 },
  // Two lines kept for every row, as Telegram does, so rows keep one rhythm whatever their preview.
  bottom: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, minHeight: 40 },
  preview: { flex: 1 },
  marks: { flexDirection: "row", alignItems: "center", gap: 4, paddingTop: 2 },
  match: { fontWeight: "600" },
  separator: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  actions: { flexDirection: "row" },
  action: { width: ACTION_W, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { color: "#FFFFFF", fontWeight: "600", paddingHorizontal: 4 },
});
