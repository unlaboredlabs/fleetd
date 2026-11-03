// A chat's Artifacts, pushed from its Info: the reports its lead, agents or Navi published, the newest first, each a row
// with its title and a line of its format, who, when and its version. Tapping one opens it (Artifact.tsx). The list
// reads again on artifacts.changed, so a new one shows while it is open.
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { listTime } from "../../chatView";
import type { ProjectRef } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import type { Session } from "../../session";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { useNow } from "../time";
import { listArtifacts, touchesArtifacts } from "./api";
import { rowLine, type ArtifactFormat } from "./model";

export function Artifacts({ navigation, route }: ChatInfoProps<"Artifacts">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  const list = useRead(() => (p === undefined ? Promise.resolve(undefined) : listArtifacts(session, p)), [session, p?.machineId, p?.projectId]);
  useArtifactsChanged(session, p, list.reload);
  const r = list.value;
  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={list.reload} tintColor={t.secondary} />}
    >
      {r === undefined ? (
        <ActivityIndicator style={styles.loading} color={t.secondary} />
      ) : !r.ok ? (
        <Problem text={`Couldn't read the artifacts: ${errorWords(r.error)}`} />
      ) : r.value.length === 0 ? (
        <EmptyState icon="folder" title="No Artifacts Yet" body="When the lead or an agent writes a report too long for the chat, it publishes it here, and the chat shows a card for it. Every version is kept." />
      ) : (
        <ListSection footer="Every version is kept: open one to see the older ones.">
          {r.value.map((a) => (
            <Pressable
              key={a.name}
              accessibilityRole="button"
              accessibilityLabel={`${a.newest.title}, ${rowLine(a.newest, listTime(a.newest.at, now))}`}
              onPress={() => {
                haptics.tap();
                navigation.navigate("Artifact", { key, name: a.name });
              }}
            >
              {({ pressed }) => (
                <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
                  <ArtifactTile format={a.newest.format} />
                  <View style={styles.grow}>
                    <Text style={[type.body, { color: t.label }]} numberOfLines={1}>
                      {a.newest.title}
                    </Text>
                    <Text style={[type.footnote, styles.meta, { color: t.secondary }]} numberOfLines={1}>
                      {rowLine(a.newest, listTime(a.newest.at, now))}
                    </Text>
                  </View>
                  <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
                </View>
              )}
            </Pressable>
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}

/** Reads again on an artifacts.changed for this chat, and on coming back to the screen (the first focus is the mount's read). */
export const useArtifactsChanged = (session: Session, p: ProjectRef | undefined, reload: () => void): void => {
  const machineId = p?.machineId;
  const projectId = p?.projectId;
  useEffect(() => {
    if (machineId === undefined || projectId === undefined) return;
    return session.onEvent((event) => {
      if (touchesArtifacts(event, { machineId, projectId })) reload();
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

/** A format's tile: a page of text for Markdown, a chart page for HTML. */
export function ArtifactTile({ format, size = 29 }: { format: ArtifactFormat; size?: number }) {
  const t = useTheme();
  const glyph = size * 0.58;
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: size * 0.24, backgroundColor: format === "html" ? (t.tints[6] ?? t.indigo) : t.accentFill }]}>
      {format === "html" ? (
        <Symbol ios="chart.bar.doc.horizontal.fill" android="insert_chart" size={glyph} color="#FFFFFF" weight="medium" />
      ) : (
        <Symbol ios="doc.text.fill" android="description" size={glyph} color="#FFFFFF" weight="medium" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 10 },
  tile: { alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, gap: 1 },
  meta: { marginTop: 2 },
});
