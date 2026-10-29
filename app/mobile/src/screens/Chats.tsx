// Chats, as Messages and Telegram list them: what needs you on top, then your Navis, then the projects, each a
// full-bleed row with its avatar, its newest message and when, and a badge when it waits on you. Search filters by
// name; pulling down reads the hub again.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { listTime } from "../chatView";
import { useHub, type RootParams } from "../hubContext";
import { lists, type Row } from "../lists";
import { space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { SkeletonRow } from "../ui/Skeleton";
import { Badge, ConnectionLine, EmptyState } from "../ui/States";
import { useNow } from "./time";
import { useTabBarInset } from "./layout";

const AVATAR = 52;

export function Chats({ navigation }: NativeStackScreenProps<{ Chats: undefined }, "Chats">) {
  const t = useTheme();
  const { state, session, pairAgain } = useHub();
  const root = useNavigation<NavigationProp<RootParams>>();
  const bottom = useTabBarInset();
  const [query, setQuery] = useState("");
  const refreshing = useRefreshing(state.projects, state.hub.phase);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search",
        onChangeText: (e) => setQuery(e.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
        hideWhenScrolling: true,
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
      { title: "Needs You", data: keep(shown.needsYou) },
      { title: "Navis", data: keep(shown.navis) },
      { title: "Projects", data: keep(shown.projects) },
    ].filter((s) => s.data.length > 0);
  }, [shown, query]);

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
      contentContainerStyle={{ paddingBottom: bottom, flexGrow: 1 }}
      scrollIndicatorInsets={{ bottom }}
      keyboardDismissMode="on-drag"
      stickySectionHeadersEnabled={false}
      refreshControl={<RefreshControl refreshing={refreshing.on} onRefresh={() => refreshing.start(() => session.refresh())} tintColor={t.secondary} />}
      ListHeaderComponent={<ConnectionLine state={state.hub} onPairAgain={pairAgain} />}
      ListEmptyComponent={empty}
      renderSectionHeader={({ section }) =>
        sections.length > 1 || section.title === "Needs You" ? (
          <Text style={[type.footnote, styles.section, { color: t.secondary }]} accessibilityRole="header">
            {section.title.toUpperCase()}
          </Text>
        ) : null
      }
      renderItem={({ item, index, section }) => <ChatRow row={item} separator={index < section.data.length - 1} onPress={() => root.navigate("Chat", { key: item.key })} />}
    />
  );
}

/** Pull to refresh's spinner: on from the pull until a new snapshot lands or the link gives up, and a second at most past that. */
const useRefreshing = (projects: unknown, phase: string): { on: boolean; start: (go: () => void) => void } => {
  const [since, setSince] = useState<unknown>(null);
  const on = since !== null;
  useEffect(() => {
    if (!on) return;
    if (projects !== since || phase === "refused" || phase === "retrying") {
      setSince(null);
      return;
    }
    const timer = setTimeout(() => setSince(null), 8000);
    return () => clearTimeout(timer);
  }, [on, since, projects, phase]);
  return {
    on,
    start: (go) => {
      setSince(projects);
      go();
    },
  };
};

function ChatRow({ row, separator, onPress }: { row: Row; separator: boolean; onPress: () => void }) {
  const t = useTheme();
  const now = useNow();
  const line = row.working ? "Working…" : (row.preview ?? row.want ?? (row.navi ? "Navi" : row.project.workspaceRoot));
  const accentLine = row.working || (row.preview === undefined && row.want !== undefined);
  const label = [row.project.title, line, row.approvals > 0 ? `${String(row.approvals)} waiting for approval` : row.want].filter((s) => s !== undefined).join(", ");
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
              <Text style={[type.subhead, styles.preview, { color: accentLine ? t.accent : t.secondary }]} numberOfLines={1}>
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
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, minHeight: 72 },
  body: { flex: 1, alignSelf: "stretch", justifyContent: "center", gap: 2, paddingRight: space.lg, paddingVertical: 10 },
  top: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  title: { flex: 1 },
  bottom: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 22 },
  preview: { flex: 1 },
  separator: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
