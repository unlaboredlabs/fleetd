// Settings' Update section, for admins (updates.ts): "Update fleetd" when the hub has a newer build, which asks
// first, then the run as it goes, the hub and each machine on a row of its own, to its outcome: Update now while
// machines wait for their agents, Retry on a machine that failed or was put back, Start over on a run that stopped
// moving. It is where the chats list's word for the hub leads (hubWord.ts): after the hub came back on a new build,
// everyone, members too, reads what it runs now and how long it was away, without buttons.
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { retryMachine, startOver, startUpdate, updateNow, useFlow, useReady, useRun, type Line } from "../desktop";
import { useHub } from "../hubContext";
import { space, type, useTheme, type Palette } from "../theme";
import { useAnnounce } from "../ui/announce";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { UPDATED_FOR_MS } from "../hubWord";
import type { Restart } from "../store";
import { UPDATE_NOTE, shortVersion, updateSection } from "../updates";

const ink = (t: Palette, tone: Line["tone"]): string => (tone === "danger" ? t.danger : tone === "warning" ? t.warning : tone === "accent" ? t.accent : t.secondary);

export function UpdateFleetd() {
  const t = useTheme();
  const { state, session } = useHub();
  const flow = useFlow();
  const run = useRun();
  const ready = useReady();
  const section = updateSection({ admin: state.admin, hub: state.hub, machines: state.machines, run, flow, ready });
  useAnnounce(section?.progress?.text);
  const updated = updatedOf(state.restart);
  if (section === null || (section.offer === null && section.progress === null)) {
    return updated === null ? null : (
      <ListSection header="Update">
        <UpdatedRow {...updated} />
      </ListSection>
    );
  }

  const confirm = () => {
    const title = section.offer?.title ?? "Update fleetd";
    // What it updates to, then what it does.
    const message = section.offer?.detail === undefined ? UPDATE_NOTE : `${section.offer.detail}. ${UPDATE_NOTE}`;
    const go = () => {
      haptics.firm();
      void startUpdate(session.updates);
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title, message, options: ["Update", "Cancel"], cancelButtonIndex: 1 }, (i) => {
        if (i === 0) go();
      });
    } else {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: go },
      ]);
    }
  };

  return (
    <ListSection header="Update" {...(section.offer === null ? {} : { footer: UPDATE_NOTE })}>
      {updated === null || section.progress !== null ? null : <UpdatedRow {...updated} />}
      {/* TODO(T2570): t.accentDeep once the neutral accent lands: a white glyph vanishes on dark mode's near-white accentFill. */}
      {section.offer === null ? null : <ListRow icon="update" tint={t.accentFill} title={section.offer.title} detail={section.offer.detail} onPress={confirm} />}
      {section.progress === null ? null : (
        <View style={styles.progress} accessibilityLiveRegion="polite">
          {section.going ? (
            <ActivityIndicator size="small" color={t.secondary} />
          ) : (
            <Icon name={section.progress.tone === "danger" ? "error" : section.progress.tone === "warning" ? "irreversible" : "check"} size={20} color={section.progress.tone === "quiet" ? t.success : ink(t, section.progress.tone)} />
          )}
          <Text style={[type.subhead, styles.grow, { color: section.progress.tone === "quiet" ? t.label : ink(t, section.progress.tone) }]}>{section.progress.text}</Text>
        </View>
      )}
      {section.parts.map((p) => {
        const retry = p.retry;
        return (
          <ListRow
            key={p.key}
            title={p.name}
            detail={p.reason}
            value={p.state}
            valueColor={ink(t, p.tone)}
            accessory={
              retry?.kind === "machine" ? (
                <Button label="Retry" kind="tinted" size="small" onPress={() => void retryMachine(session.updates, retry.machineId)} />
              ) : retry?.kind === "update" ? (
                <Button label="Retry" kind="tinted" size="small" onPress={confirm} />
              ) : undefined
            }
          />
        );
      })}
      {!section.updateNow ? null : (
        <ListRow
          title="Update Now"
          detail="Restarts the machines without waiting for their agents' step"
          onPress={() => {
            haptics.firm();
            void updateNow(session.updates);
          }}
        />
      )}
      {section.startOver === null ? null : <ListRow title="Start Over" detail={section.startOver.note} onPress={() => void startOver(session.updates)} />}
    </ListSection>
  );
}

/** The hub's update as the phone saw it come back, for a while after (hubWord.ts UPDATED_FOR_MS); else null. */
const updatedOf = (restart: Restart | null): { readonly to: string; readonly at: number; readonly took: number } | null =>
  restart?.t === "updated" && Date.now() - restart.at < UPDATED_FOR_MS ? { to: restart.to, at: restart.at, took: restart.took } : null;

/** "Updated to 0.9.2", when, and how long the hub was away. */
function UpdatedRow({ to, at, took }: { to: string; at: number; took: number }) {
  const t = useTheme();
  const when = new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const away = Math.max(1, Math.round(took / 1000));
  return (
    <View style={styles.progress} accessible accessibilityLabel={`Updated to ${shortVersion(to)}, at ${when}, back in ${String(away)} seconds`}>
      <Icon name="check" size={20} color={t.success} />
      <View style={styles.grow}>
        <Text style={[type.subhead, { color: t.label }]}>Updated to {shortVersion(to)}</Text>
        <Text style={[type.footnote, { color: t.secondary }]}>
          {when} · back in {String(away)} s
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  grow: { flex: 1 },
});
