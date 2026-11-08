// Settings' Update section, for admins (updates.ts): "Update fleetd" when the hub has a newer build, which asks
// first, then the run as it goes, the hub and each machine on a row of its own, to its outcome: Update now while
// machines wait for their agents, Retry on a machine that failed or was put back, Start over on a run that stopped
// moving. It is where the chats list's word for the hub leads (hubWord.ts): after an update everyone, members too,
// reads how it ended (what the hub runs now and how long it was away, or that it was put back and why), without buttons.
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from "react-native";
import { retryMachine, startOver, startUpdate, updateNow, useFlow, useReady, useRun, type Line } from "../desktop";
import { useHub } from "../hubContext";
import { space, type, useTheme, type Palette } from "../theme";
import { useAnnounce } from "../ui/announce";
import { Button } from "../ui/Button";
import { haptics } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import { ListRow, ListSection } from "../ui/List";
import { FAILED_FOR_MS, UPDATED_FOR_MS } from "../hubWord";
import type { HubUpdateData } from "../desktop";
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
  const told = toldOf(state.restart, state.hubUpdate, Date.now());
  if (section === null || (section.offer === null && section.progress === null)) {
    return told === null ? null : (
      <ListSection header="Update">
        <ToldRow {...told} />
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
      {told === null || section.progress !== null ? null : <ToldRow {...told} />}
      {section.offer === null ? null : <ListRow icon="update" tint={t.accentDeep} title={section.offer.title} detail={section.offer.detail} onPress={confirm} />}
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

/** What the section says of the hub's last update, without buttons: how it ended, as the hub told everyone. */
interface Told {
  readonly ok: boolean;
  readonly title: string;
  readonly detail: string;
}

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A put-back or failed update for an hour (the hub's sentence for it), else "Updated to …" for a while after: with how
 * long the hub was away when this phone saw it come back (store.ts Restart), else when it ended.
 */
const toldOf = (restart: Restart | null, update: HubUpdateData | undefined, now: number): Told | null => {
  const ended = update?.finishedAt === undefined ? undefined : Date.parse(update.finishedAt);
  const to = update?.to === undefined ? "" : `${shortVersion(update.to)} `;
  if (update !== undefined && ended !== undefined && now - ended < FAILED_FOR_MS && (update.state === "put_back" || update.state === "failed")) {
    return { ok: false, title: update.state === "put_back" ? `${to}was put back` : `${to}didn't install`, detail: update.message ?? clock(ended) };
  }
  if (restart?.t === "updated" && now - restart.at < UPDATED_FOR_MS) {
    return { ok: true, title: `Updated to ${shortVersion(restart.to)}`, detail: `${clock(restart.at)} · back in ${String(Math.max(1, Math.round(restart.took / 1000)))} s` };
  }
  if (update?.state === "updated" && ended !== undefined && now - ended < UPDATED_FOR_MS) return { ok: true, title: `Updated to ${shortVersion(update.to ?? "")}`, detail: clock(ended) };
  return null;
};

function ToldRow({ ok, title, detail }: Told) {
  const t = useTheme();
  return (
    <View style={styles.progress} accessible accessibilityLabel={`${title}, ${detail}`}>
      <Icon name={ok ? "check" : "irreversible"} size={20} color={ok ? t.success : t.danger} />
      <View style={styles.grow}>
        <Text style={[type.subhead, { color: ok ? t.label : t.danger }]}>{title.charAt(0).toUpperCase() + title.slice(1)}</Text>
        <Text style={[type.footnote, { color: t.secondary }]}>{detail}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  grow: { flex: 1 },
});
