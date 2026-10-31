// A skill's history, pushed from its view: every version the hub keeps, newest first, each with its why, who wrote it
// (the Navi, or a person) and when. Tapping one opens what it changed (SkillVersion.tsx).
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { errorWords, Problem, Symbol, useRead } from "./parts";
import { useSkillsChanged } from "./Skills";
import { readSkill } from "./skillsApi";
import { versionLine, type SkillVersion } from "./skillsModel";

export function SkillHistory({ navigation, route }: ChatInfoProps<"SkillHistory">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key, origin, name } = route.params;
  const p = state.projects?.[key];
  const read = useRead(() => (p === undefined ? Promise.resolve(undefined) : readSkill(session, p, origin, name)), [session, p?.machineId, p?.projectId, origin, name]);
  useSkillsChanged(session, p, read.reload);
  const r = read.value;
  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const versions = r.ok ? r.value.versions : [];
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {!r.ok ? (
        <Problem text={`Couldn't read its history: ${errorWords(r.error)}`} />
      ) : (
        <ListSection footer="Every change is kept, with who made it and why. Tap one to see what it changed.">
          {versions.map((v, i) => (
            <VersionRow
              key={v.version}
              icon
              v={v}
              current={i === 0}
              line={versionLine(v, now, state.meName)}
              onPress={() => {
                haptics.tap();
                navigation.navigate("SkillVersion", { key, origin, name, version: v.version });
              }}
            />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}

/** `icon` is ListSection's sign to inset the separator past the mark. */
function VersionRow({ v, current, line, onPress }: { v: SkillVersion; current: boolean; line: { title: string; detail: string }; icon: true; onPress: () => void }) {
  const t = useTheme();
  const agent = v.author === "agent";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Version ${String(v.version)}${current ? ", current" : ""}: ${line.title}. ${line.detail}`} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.row, pressed && { backgroundColor: t.fillQuiet }]}>
          <View style={[styles.mark, { backgroundColor: agent ? t.accentSoft : t.fillQuiet }]}>
            {agent ? <Icon name="sparkles" size={15} color={t.accent} weight="medium" /> : <Symbol ios="person.fill" android="person" size={15} color={t.secondary} weight="medium" />}
          </View>
          <View style={styles.grow}>
            <Text style={[type.body, { color: t.label }]} numberOfLines={2}>
              {line.title}
            </Text>
            <Text style={[type.footnote, { color: t.secondary }]} numberOfLines={1}>
              {line.detail}
            </Text>
          </View>
          <Text style={[type.footnote, styles.number, { color: current ? t.accent : t.tertiary }]}>{current ? "Current" : `v${String(v.version)}`}</Text>
          <Icon name="chevron" size={14} color={t.tertiary} weight="semibold" />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 10 },
  mark: { width: 29, height: 29, borderRadius: 14.5, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, gap: 1 },
  number: { fontVariant: ["tabular-nums"] },
});
