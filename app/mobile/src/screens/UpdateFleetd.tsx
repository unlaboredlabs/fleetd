// Settings' Update section, for admins (updates.ts): "Update fleetd" when the hub has a newer build, which asks
// first, then the run as it goes, the hub and each machine on a row of its own, to its outcome: Update now while
// machines wait for their agents, Retry on a machine that failed or was put back, Start over on a run that stopped
// moving.
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { retryMachine, startOver, startUpdate, updateNow, useFlow, useReady, useRun, type Line } from "../desktop";
import { useHub } from "../hubContext";
import { space, type, useTheme, type Palette } from "../theme";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { UPDATE_NOTE, updateSection } from "../updates";

const ink = (t: Palette, tone: Line["tone"]): string => (tone === "danger" ? t.danger : tone === "warning" ? t.warning : tone === "accent" ? t.accent : t.secondary);

export function UpdateFleetd() {
  const t = useTheme();
  const { state, session } = useHub();
  const flow = useFlow();
  const run = useRun();
  const ready = useReady();
  const section = updateSection({ admin: state.admin, hub: state.hub, machines: state.machines, run, flow, ready });
  if (section === null) return null;

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

const styles = StyleSheet.create({
  progress: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  grow: { flex: 1 },
});
