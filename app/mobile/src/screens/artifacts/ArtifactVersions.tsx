// An artifact's versions, pushed from its bar on Android (iOS's bar has a native menu): every version the hub keeps,
// newest first, with who published it and when. Tapping one shows it over the artifact it came from.
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { listTime } from "../../chatView";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { Icon } from "../../ui/Icon";
import { ListRow, ListSection } from "../../ui/List";
import { EmptyState } from "../../ui/States";
import { errorWords, Problem, useRead } from "../manage/parts";
import { useNow } from "../time";
import { readArtifact } from "./api";
import { useArtifactsChanged } from "./Artifacts";

export function ArtifactVersions({ navigation, route }: ChatInfoProps<"ArtifactVersions">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key, name, shown } = route.params;
  const p = state.projects?.[key];
  const read = useRead(() => (p === undefined ? Promise.resolve(undefined) : readArtifact(session, p, name)), [session, p?.machineId, p?.projectId, name]);
  useArtifactsChanged(session, p, read.reload);
  const r = read.value;
  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const versions = r.ok ? r.value.versions : [];
  const newest = versions[0]?.version;
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {!r.ok ? (
        <Problem text={`Couldn't read its versions: ${errorWords(r.error)}`} />
      ) : (
        <ListSection footer="Every version is kept.">
          {versions.map((v) => (
            <ListRow
              key={v.version}
              title={`Version ${String(v.version)}`}
              detail={`${v.by} · ${listTime(v.at, now)}`}
              chevron={false}
              {...(v.version === (shown ?? newest) ? { accessory: <Icon name="check" size={20} color={t.accent} /> } : {})}
              onPress={() => {
                haptics.tap();
                navigation.popTo("Artifact", { key, name, version: v.version === newest ? undefined : v.version });
              }}
            />
          ))}
        </ListSection>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
});
