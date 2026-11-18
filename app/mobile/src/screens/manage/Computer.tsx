// A bot's Computer, pushed from its screen, as the desktop's Computer section: for its own directory and each other
// repo, what its setup installs (its commands, read-only here; the desktop edits them), the image its agents' computers
// start from (Ready, Building…, Failed with its log, Not built yet; when it was built and its size) and Rebuild
// (project_image_rebuild). The hub's project.settings brings each change, a build's end too.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ComputerImage, ProjectSummary } from "../../desktop";
import { useHub, type ChatInfoProps } from "../../hubContext";
import { refOf } from "../../store";
import { mono, shape, space, type, useTheme } from "../../theme";
import { haptics } from "../../ui/haptics";
import { ListRow, ListSection } from "../../ui/List";
import { PRESSED_OPACITY } from "../../ui/motion";
import { EmptyState } from "../../ui/States";
import { useNow } from "../time";
import { readComputer, rebuildImage } from "./api";
import { canRebuild, commandsOf, imageRows, setupTargets, touchesComputer, type SetupTarget } from "./computerModel";
import { errorWords, Problem, useRead } from "./parts";

export function Computer({ navigation, route }: ChatInfoProps<"Computer">) {
  const t = useTheme();
  const { state, session } = useHub();
  const key = route.params.key;
  const p = state.projects?.[key];
  // Pulled down, or a project.settings for this bot: every section reads again.
  const [gen, setGen] = useState(0);
  const again = useCallback(() => setGen((g) => g + 1), []);
  const machineId = p?.machineId;
  const projectId = p?.projectId;
  useEffect(() => {
    if (machineId === undefined || projectId === undefined) return;
    return session.onEvent((event) => (touchesComputer(event, { machineId, projectId }) ? again() : undefined));
  }, [session, machineId, projectId, again]);
  if (p === undefined) {
    return (
      <View style={[styles.fill, { backgroundColor: t.grouped }]}>
        {state.projects === undefined ? <ActivityIndicator style={styles.loading} color={t.secondary} /> : <EmptyState icon="folder" title="Not Here" body="The hub doesn't list it any more." />}
      </View>
    );
  }
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={again} tintColor={t.secondary} />}
    >
      {setupTargets(p).map((target) => (
        <Setup key={target.repo ?? ""} project={p} target={target} gen={gen} onLog={(log) => navigation.navigate("ComputerLog", { log })} />
      ))}
    </ScrollView>
  );
}

/** One repo's setup: its commands, its image's rows, and Rebuild. */
function Setup({ project: p, target, gen, onLog }: { project: ProjectSummary; target: SetupTarget; gen: number; onLog: (log: string) => void }) {
  const t = useTheme();
  const now = useNow();
  const { state, session } = useHub();
  const key = `${p.machineId}/${p.projectId}`;
  const read = useRead(() => readComputer(session, refOf(key), target.repo), [session, key, target.repo, gen]);
  // Rebuild's answer, shown at once until the next read brings the hub's.
  const [answered, setAnswered] = useState<ComputerImage | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const result = read.value;
  const settings = result?.ok === true ? result.value : undefined;
  useEffect(() => setAnswered(undefined), [settings]);
  const commands = commandsOf(settings?.setup);
  const image = answered ?? settings?.image;
  const rows = imageRows(image, commands.length > 0, now);
  const live = state.hub.phase === "live";

  const rebuild = () => {
    haptics.tap();
    setBusy(true);
    void rebuildImage(session, refOf(key), target.repo).then((r) => {
      setBusy(false);
      if (!r.ok) {
        haptics.warning();
        return Alert.alert("Couldn't rebuild", errorWords(r.error));
      }
      haptics.success();
      setAnswered(r.value);
    });
  };

  if (settings === undefined) {
    return (
      <>
        <ListSection header={target.title}>
          <ListRow title={result?.ok === false ? "Couldn't read it" : "Reading…"} {...(result === undefined ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})} />
        </ListSection>
        <Problem text={result?.ok === false ? errorWords(result.error) : undefined} />
      </>
    );
  }
  return (
    <>
      <ListSection header={target.title}>
        {commands.length === 0 ? <ListRow title="No commands" /> : commands.map((c, i) => <Command key={`${String(i)}:${c}`} text={c} />)}
      </ListSection>
      {rows.length === 0 ? null : (
        <ListSection>
          {rows.map((row) => (
            <ListRow
              key={row.title}
              title={row.title}
              value={row.value}
              valueColor={row.tone === "danger" ? t.danger : t.secondary}
              {...(row.tone === "busy" ? { accessory: <ActivityIndicator color={t.secondary} /> } : {})}
              {...(row.log === undefined ? {} : { onPress: () => onLog(row.log ?? "") })}
            />
          ))}
          {live && canRebuild(image, commands.length > 0) ? <Action title="Rebuild" busy={busy} onPress={rebuild} /> : null}
        </ListSection>
      )}
    </>
  );
}

/** A setup command as it runs: monospaced, wrapped, copyable. */
function Command({ text }: { text: string }) {
  const t = useTheme();
  return (
    <View style={styles.command}>
      <Text style={[styles.code, { color: t.label }]} selectable>
        {text}
      </Text>
    </View>
  );
}

/** A row that does one thing, its title in the accent, as iOS Settings' own; a spinner while it does. */
function Action({ title, busy, onPress }: { title: string; busy: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={onPress}>
      {({ pressed }) => (
        <View style={[styles.action, pressed && { backgroundColor: t.fillQuiet }]}>
          <Text style={[type.body, styles.fill, { color: t.accent, opacity: busy ? PRESSED_OPACITY : 1 }]}>{title}</Text>
          {busy ? <ActivityIndicator color={t.secondary} /> : null}
        </View>
      )}
    </Pressable>
  );
}

/** A failed build's log: the end of it, as the hub keeps it, copyable. */
export function ComputerLog({ route }: ChatInfoProps<"ComputerLog">) {
  const t = useTheme();
  return (
    <ScrollView style={{ backgroundColor: t.grouped }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <ListSection>
        <View style={styles.log}>
          <Text style={[styles.code, { color: t.label }]} selectable>
            {route.params.log}
          </Text>
        </View>
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  loading: { marginTop: 64 },
  command: { minHeight: shape.row, justifyContent: "center", paddingHorizontal: space.lg, paddingVertical: 11 },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 18 },
  action: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: shape.row, paddingHorizontal: space.lg, paddingVertical: 11 },
  log: { paddingHorizontal: space.lg, paddingVertical: space.md },
});
