// One artifact, pushed from the chat's Artifacts, its card or a link in a message: its newest version, or the one they
// named. Markdown reads as the chat's own formatted text, raw HTML dropped; an HTML page runs in its fenced WebView
// (ArtifactFrame) on iPhone, and Android says where to open it. A link to another of the chat's artifacts opens that
// one. With more than one version, the bar's Versions picks one (a menu on iOS, a pushed list on Android:
// ArtifactVersions), and an older one says so over the page with the way back to the newest.
import { useCallback, useLayoutEffect } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { listTime } from "../../chatView";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { space, type, useTheme } from "../../theme";
import { Button } from "../../ui/Button";
import { haptics } from "../../ui/haptics";
import { ArtifactLinks, Markdown } from "../../ui/Markdown";
import { EmptyState } from "../../ui/States";
import { errorWords, Problem, Symbol, useRead } from "../manage/parts";
import { useNow } from "../time";
import { readArtifact } from "./api";
import { ArtifactFrame } from "./ArtifactFrame";
import { useArtifactsChanged } from "./Artifacts";
import { linkTarget, rowLine, type ArtifactVersion } from "./model";

export function Artifact({ navigation, route }: ChatInfoProps<"Artifact">) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const { key, name, version } = route.params;
  const p = state.projects?.[key];
  const read = useRead(() => (p === undefined ? Promise.resolve(undefined) : readArtifact(session, p, name, version)), [session, p?.machineId, p?.projectId, name, version]);
  useArtifactsChanged(session, p, read.reload);
  const r = read.value;
  const v = r?.ok === true ? r.value : undefined;
  const versions = v?.versions ?? [];
  const shown = v?.artifact.version;

  useLayoutEffect(() => {
    const pick = (n: number) => {
      haptics.tap();
      navigation.setParams({ version: n === versions[0]?.version ? undefined : n });
    };
    const label = (x: ArtifactVersion) => `Version ${String(x.version)}`;
    const detail = (x: ArtifactVersion) => `${x.by} · ${listTime(x.at, now)}`;
    navigation.setOptions({
      title: v?.artifact.title ?? "",
      ...(Platform.OS === "ios"
        ? {
            unstable_headerRightItems: () =>
              versions.length > 1
                ? [
                    {
                      type: "menu",
                      label: "Versions",
                      icon: { type: "sfSymbol", name: "clock.arrow.circlepath" },
                      accessibilityLabel: "Versions",
                      menu: {
                        title: "Versions",
                        items: versions.map((x) => ({ type: "action", label: label(x), subtitle: detail(x), state: x.version === shown ? "on" : "off", onPress: () => pick(x.version) })),
                      },
                    },
                  ]
                : [],
          }
        : {
            headerRight: () =>
              versions.length > 1 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Versions"
                  hitSlop={12}
                  onPress={() => {
                    haptics.tap();
                    navigation.navigate("ArtifactVersions", { key, name, shown });
                  }}
                >
                  <Symbol ios="clock.arrow.circlepath" android="history" size={22} color={t.accent} />
                </Pressable>
              ) : null,
          }),
    });
  }, [navigation, t, v?.artifact.title, versions, shown, now, key, name]);

  // A link in a report to another of the chat's artifacts opens it over this one.
  const openLink = useCallback(
    (url: string) => {
      const to = linkTarget(url);
      if (to !== undefined) {
        haptics.tap();
        navigation.push("Artifact", { key, name: to.name, version: to.version });
      }
      return to !== undefined;
    },
    [navigation, key],
  );

  if (p === undefined) return <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  if (!r.ok) {
    if (r.error.code === "not_found") return <EmptyState icon="folder" title="Not Here" body="This chat doesn't have that artifact." />;
    return (
      <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic">
        <Problem text={`Couldn't read it: ${errorWords(r.error)}`} />
      </ScrollView>
    );
  }
  const a = r.value.artifact;
  const newest = versions[0]?.version ?? a.version;
  const older =
    a.version === newest ? null : (
      <View style={[styles.older, { backgroundColor: t.surface }]}>
        <Text style={[type.footnote, styles.grow, { color: t.secondary }]}>{`Version ${String(a.version)} of ${String(newest)}`}</Text>
        <Button label="Show Newest" kind="plain" onPress={() => navigation.setParams({ version: undefined })} />
      </View>
    );
  // Android's WebView can't be kept off the network as iOS's is (a preconnect, which no CSP covers, has no proxy to
  // meet there), so it doesn't run a report's page yet.
  if (a.format === "html" && Platform.OS === "android") {
    return (
      <View style={[styles.grow, { backgroundColor: t.bg }]}>
        {older}
        <EmptyState icon="fileDoc" title="Open on iPhone or Desktop" body="HTML reports run on iPhone and in the desktop app. Android doesn't run them yet: its web view can't be kept off the network the same way." />
      </View>
    );
  }
  if (a.format === "html") {
    return (
      <View style={[styles.grow, { backgroundColor: t.bg }]}>
        {older}
        <ArtifactFrame key={`${name}@${String(a.version)}`} html={r.value.content} title={a.title} />
      </View>
    );
  }
  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.doc}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {older}
      <Text style={[type.footnote, { color: t.secondary }]}>{rowLine(a, listTime(a.at, now))}</Text>
      <ArtifactLinks.Provider value={openLink}>
        <Markdown text={r.value.content} ink={t.label} holdsBlocks={false} ground={t.bg} />
      </ArtifactLinks.Provider>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
  grow: { flex: 1 },
  doc: { padding: space.lg, gap: space.md, paddingBottom: space.xxl },
  older: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 44 },
});
