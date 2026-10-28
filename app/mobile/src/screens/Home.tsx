// The home screen: Chats (what needs you, your Navis, the projects) and Approvals, under the hub's name.
import { FlatList, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { approvals, lists, type Row } from "../lists";
import type { Session } from "../session";
import type { Key, State } from "../store";
import { color, size } from "../theme";
import { Empty } from "../ui";
import { ApprovalCard } from "./ApprovalCard";

export type Tab = "chats" | "approvals";

export function Tabs({ tab, onTab, waiting }: { tab: Tab; onTab: (tab: Tab) => void; waiting: number }) {
  const item = (t: Tab, label: string) => (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === t }} onPress={() => onTab(t)} style={[styles.tab, tab === t && styles.tabOn]}>
      <Text style={[styles.tabText, tab === t && { color: color.text }]}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={styles.tabs}>
      {item("chats", "Chats")}
      {item("approvals", waiting === 0 ? "Approvals" : `Approvals · ${String(waiting)}`)}
    </View>
  );
}

export function Chats({ state, onOpen }: { state: State; onOpen: (key: Key) => void }) {
  const shown = lists(state);
  if (shown === undefined) return <Empty text="Loading…" />;
  const sections = [
    { title: "Needs you", data: shown.needsYou },
    { title: "Navis", data: shown.navis },
    { title: "Projects", data: shown.projects },
  ].filter((s) => s.data.length > 0);
  if (sections.length === 0) return <Empty text="No Navis or projects yet. Make one in the desktop app." />;
  return (
    <SectionList
      sections={sections}
      keyExtractor={(r) => r.key}
      renderSectionHeader={({ section }) => <Text style={styles.section}>{section.title}</Text>}
      renderItem={({ item }) => <ProjectRow row={item} onPress={() => onOpen(item.key)} />}
      stickySectionHeadersEnabled={false}
    />
  );
}

function ProjectRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const detail = row.want ?? (row.working ? "Working…" : undefined);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: color.raised }]}>
      {row.want === undefined ? null : <View style={styles.dot} />}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.project.title}
        </Text>
        {detail === undefined ? null : (
          <Text style={[styles.rowDetail, row.want !== undefined && { color: color.warning }]} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** `focus`: the request a tapped notification named, first. */
export function Approvals({ state, session, focus }: { state: State; session: Session; focus?: string | undefined }) {
  if (state.requests === undefined) return <Empty text={state.hub.phase === "live" ? "Loading…" : "Not connected."} />;
  const listed = approvals(state.requests);
  const open = [...listed.filter((r) => r.requestId === focus), ...listed.filter((r) => r.requestId !== focus)];
  if (open.length === 0) return <Empty text="Nothing waits for your approval." />;
  return (
    <FlatList
      data={open}
      keyExtractor={(r) => r.requestId}
      contentContainerStyle={styles.cards}
      renderItem={({ item }) => (
        <ApprovalCard
          request={item}
          projectTitle={state.projects?.[`${item.projectRef.machineId}/${item.projectRef.projectId}`]?.title}
          answering={state.answering[item.requestId] === true}
          error={state.answerErrors[item.requestId]}
          onAnswer={(d) => void session.answer(item.requestId, d)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: color.accent },
  tabText: { color: color.quiet, fontSize: size.sm, fontWeight: "600" },
  section: { color: color.faint, fontSize: size.xs, fontWeight: "600", textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.warning },
  rowText: { flex: 1 },
  rowTitle: { color: color.text, fontSize: size.md },
  rowDetail: { color: color.quiet, fontSize: size.xs, marginTop: 2 },
  cards: { padding: 12, gap: 12 },
});
