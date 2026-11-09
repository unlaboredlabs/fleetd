// A project's DMs between agents, pushed from its Info's Agents section: every DM its agents sent each other, newest
// first, each a row with who to whom and when, its opening words, and what became of it (delivered, held, woke it,
// didn't wake it, not sent). Tapping one opens its full text and who got it when (Dm.tsx). The older ones come as the list
// nears its end; the log reads again on a DM or a receipt in the project and on coming back to it. Read-only.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { listTime } from "../../chatView";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { useNow } from "../time";
import { readDms } from "./api";
import { glyphOf, joinPages, opening, route as routeLine, rowLabel, rowOutcome, touchesDms, type AgentMessage, type DmGlyph } from "./model";

/** How near the end the older ones are read: about two screens' worth of rows ahead. */
const AHEAD = 600;

export function Dms({ navigation, route }: ChatInfoProps<"Dms">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  const first = useRead(() => (p === undefined ? Promise.resolve(undefined) : readDms(session, p)), [session, p?.machineId, p?.projectId]);
  const [older, setOlder] = useState<{ messages: readonly AgentMessage[]; more: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  const [olderError, setOlderError] = useState<string | undefined>(undefined);
  // A fresh first page starts the list over: what was read past it reads again as it is scrolled to.
  useEffect(() => {
    setOlder(null);
    setOlderError(undefined);
  }, [first.value]);
  useDmsChanged(p === undefined ? undefined : { machineId: p.machineId, projectId: p.projectId }, first.reload);

  const page = first.value?.ok === true ? first.value.value : undefined;
  const messages = page === undefined ? [] : older === null ? page.messages : joinPages(page.messages, older.messages);
  const more = older === null ? page?.more === true : older.more;

  const busy = useRef(false);
  const readOlder = useCallback(() => {
    const oldest = messages[messages.length - 1];
    if (p === undefined || !more || busy.current || oldest === undefined) return;
    busy.current = true;
    setReading(true);
    void readDms(session, p, oldest.id).then((r) => {
      busy.current = false;
      setReading(false);
      if (!r.ok) return setOlderError(`Couldn't read older DMs: ${errorWords(r.error)}`);
      setOlderError(undefined);
      setOlder({ messages: joinPages(older?.messages ?? [], r.value.messages), more: r.value.more });
    });
  }, [messages, more, older, p, session]);

  const onScroll = ({ nativeEvent: e }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - AHEAD) readOlder();
  };

  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      onScroll={onScroll}
      scrollEventThrottle={100}
      refreshControl={<RefreshControl refreshing={false} onRefresh={first.reload} tintColor={t.secondary} />}
    >
      {first.value === undefined ? (
        <ActivityIndicator style={styles.loading} color={t.secondary} />
      ) : !first.value.ok ? (
        <Problem text={`Couldn't read the DMs: ${errorWords(first.value.error)}`} />
      ) : messages.length === 0 ? (
        <EmptyState icon="bubble" title="No DMs Yet" body="When one of its agents writes to another, the DM shows here, with who got it and when. Nobody can edit or delete one." />
      ) : (
        <>
          <ListSection {...(more ? {} : { footer: "Kept as sent: nobody can edit or delete a DM." })}>
            {messages.map((m) => (
              <DmRow
                key={m.id}
                message={m}
                when={listTime(m.sentAt, now)}
                onPress={() => {
                  haptics.tap();
                  navigation.navigate("Dm", { key, message: m });
                }}
              />
            ))}
          </ListSection>
          {reading ? <ActivityIndicator style={styles.more} color={t.secondary} /> : null}
          <Problem text={olderError} />
        </>
      )}
    </ScrollView>
  );
}

/** A DM's row, as a mail list's: who to whom and when, two lines of its words, and what became of it. */
function DmRow({ message: m, when, onPress }: { message: AgentMessage; when: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={rowLabel(m, when)} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
          <View style={styles.top}>
            <Text style={[type.headline, styles.grow, { color: t.label }]} numberOfLines={1}>
              {routeLine(m)}
            </Text>
            <Text style={[type.subhead, { color: t.secondary }]}>{when}</Text>
            <Icon name="chevron" size={13} color={t.tertiary} weight="semibold" />
          </View>
          <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={2}>
            {opening(m.text)}
          </Text>
          <View style={styles.outcome}>
            <OutcomeGlyph glyph={glyphOf(m)} />
            <Text style={[type.footnote, styles.grow, { color: t.secondary }]} numberOfLines={1}>
              {rowOutcome(m)}
            </Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const GLYPHS = {
  delivered: { ios: "checkmark", android: "check" },
  held: { ios: "clock", android: "schedule" },
  woke: { ios: "bell", android: "notifications" },
  notWoken: { ios: "moon.zzz", android: "bedtime" },
  refused: { ios: "xmark", android: "close" },
} as const;

/** What became of it, as a small mark in the line's own ink. */
export function OutcomeGlyph({ glyph, size = 12 }: { glyph: DmGlyph; size?: number }) {
  const t = useTheme();
  return <Symbol ios={GLYPHS[glyph].ios} android={GLYPHS[glyph].android} size={size} color={t.secondary} weight="semibold" />;
}

/** Reads again on a DM or a receipt in this project, and on coming back to the screen (the first focus is the mount's read). */
export const useDmsChanged = (p: { machineId: string; projectId: string } | undefined, reload: () => void): void => {
  const { session } = useHub();
  const machineId = p?.machineId;
  const projectId = p?.projectId;
  useEffect(() => {
    if (machineId === undefined || projectId === undefined) return;
    return session.onEvent((event) => {
      if (touchesDms(event, { machineId, projectId })) reload();
    });
  }, [session, machineId, projectId, reload]);
  const shown = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (shown.current) reload();
      shown.current = true;
    }, [reload]),
  );
};

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  more: { marginTop: space.lg },
  row: { gap: 2, paddingHorizontal: space.lg, paddingVertical: 11 },
  top: { flexDirection: "row", alignItems: "center", gap: space.sm },
  outcome: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  grow: { flex: 1 },
});
