// Chats, as Messages and Telegram list them: what needs you on top, then your Navis, then the projects, each a
// full-bleed row with its avatar, its newest message and when, and a badge when it waits on you. Search filters by
// name; pulling down reads the hub again.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { listTime } from "../chatView";
import { useHub, type RootParams } from "../hubContext";
import { lists, type Row } from "../lists";
import { space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { useAnimatedRows } from "../ui/motion";
import { SkeletonRow } from "../ui/Skeleton";
import { Badge, ConnectionLine, EmptyState } from "../ui/States";
import { useRefreshing } from "./refresh";
import { useNow } from "./time";

const AVATAR = 52;

/**
 * The search field, under the large title as in Messages (iOS 26 would put it in a toolbar, which tabs don't show). It
 * has to be in the screen's options from its first frame (App.tsx): one set later never shows. Chats adds its handlers.
 */
export const searchBar = { placeholder: "Search", placement: "stacked", hideWhenScrolling: false } as const;

export function Chats({ navigation }: NativeStackScreenProps<{ Chats: undefined }, "Chats">) {
  const t = useTheme();
  const { state, session, pairAgain } = useHub();
  const root = useNavigation<NavigationProp<RootParams>>();
  const [query, setQuery] = useState("");
  const refreshing = useRefreshing(state.projects, state.hub.phase);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        ...searchBar,
        onChangeText: (e) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        tintColor: t.accent,
      },
    });
  }, [navigation, t.accent]);

  const shown = lists(state);
  const sections = useMemo(() => {
    if (shown === undefined) return [];
    const q = query.trim().toLocaleLowerCase();
    const keep = (rows: readonly Row[]) => (q === "" ? rows : rows.filter((r) => r.project.title.toLocaleLowerCase().includes(q)));
    return [
      { title: "Needs you", data: keep(shown.needsYou) },
      { title: "Navis", data: keep(shown.navis) },
      { title: "Projects", data: keep(shown.projects) },
    ].filter((s) => s.data.length > 0);
  }, [shown, query]);

  useAnimatedRows(sections.map((x) => `${x.title}:${x.data.map((r) => r.key).join(",")}`).join(" "));

  const empty =
    shown === undefined ? (
      <View>
        {[0.9, 0.6, 0.8, 0.5, 0.7, 0.6].map((w, i) => (
          <SkeletonRow key={i} wide={w} />
        ))}
      </View>
    ) : query.trim() !== "" ? (
      <EmptyState icon="chats" title="No Results" body={`No chat is called “${query.trim()}”.`} />
    ) : (
      <EmptyState icon="chats" title="No Chats Yet" body="Make a Navi or add a project in the desktop app, and its chat shows up here." />
    );

  return (
    <SectionList
      sections={sections}
      keyExtractor={(r) => r.key}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardDismissMode="on-drag"
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={refreshing.on} onRefresh={() => refreshing.start(() => session.refresh())} tintColor={t.secondary} />}
      ListHeaderComponent={<ConnectionLine state={state.hub} onPairAgain={pairAgain} />}
      ListEmptyComponent={empty}
      renderSectionHeader={({ section }) =>
        sections.length > 1 || section.title === "Needs you" ? (
          <Text style={[type.subhead, styles.section, { color: t.secondary }]} accessibilityRole="header">
            {section.title}
          </Text>
        ) : null
      }
      renderItem={({ item, index, section }) => <ChatRow row={item} separator={index < section.data.length - 1} onPress={() => root.navigate("Chat", { key: item.key })} />}
    />
  );
}

function ChatRow({ row, separator, onPress }: { row: Row; separator: boolean; onPress: () => void }) {
  const t = useTheme();
  const now = useNow();
  // Blank until its newest messages are read, rather than a stand-in that flickers away.
  const line = row.working ? "Working…" : (row.preview ?? row.want ?? (row.empty ? "No messages yet" : ""));
  const accentLine = row.working || (row.preview === undefined && row.want !== undefined);
  // What the badge says, unless the line already does.
  const badge = row.approvals > 0 ? `${String(row.approvals)} waiting for approval` : row.want;
  const label = [row.project.title, line, line === row.want ? undefined : badge].filter((s) => s !== undefined && s !== "").join(", ");
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {({ pressed }) => (
        <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
          <Avatar name={row.project.title} navi={row.navi} size={AVATAR} />
          <View style={styles.body}>
            <View style={styles.top}>
              <Text style={[type.headline, styles.title, { color: t.label }]} numberOfLines={1}>
                {row.project.title}
              </Text>
              <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
                {listTime(row.at, now)}
              </Text>
            </View>
            <View style={styles.bottom}>
              <Text style={[type.subhead, styles.preview, { color: accentLine ? t.accent : t.secondary }]} numberOfLines={accentLine ? 1 : 2}>
                {line}
              </Text>
              {row.approvals > 0 ? <Badge count={row.approvals} /> : row.want !== undefined ? <Badge /> : null}
            </View>
            {separator ? <View style={[styles.separator, { backgroundColor: t.separator }]} /> : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, minHeight: 76 },
  body: { flex: 1, alignSelf: "stretch", justifyContent: "center", gap: 2, paddingRight: space.lg, paddingVertical: 10 },
  top: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  title: { flex: 1 },
  // Two lines kept for every row, as Messages does, so rows keep one rhythm whatever their preview.
  bottom: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, minHeight: 40 },
  preview: { flex: 1 },
  separator: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
