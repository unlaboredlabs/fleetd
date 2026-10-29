// Settings, as iOS's own: the hub this phone is paired with, its notifications, this phone and its app, and
// Disconnect, which asks first.
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { useCallback, useState } from "react";
import { Linking, ScrollView } from "react-native";
import { useHub } from "../hubContext";
import { space, useTheme } from "../theme";
import { ListRow, ListSection } from "../ui/List";
import { ConnectionLine } from "../ui/States";

const statusOf = (phase: string): string =>
  phase === "live" ? "Connected" : phase === "connecting" ? "Connecting…" : phase === "retrying" ? "Reconnecting…" : phase === "refused" ? "Key refused" : "Not connected";

/** What the running JavaScript is: the build's own, or an update over the air and when it was made. */
const updateWords = (): string => {
  if (!Updates.isEnabled) return "Off";
  if (Updates.isEmbeddedLaunch || Updates.createdAt === null) return "Built in";
  return Updates.createdAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

export function Settings() {
  const t = useTheme();
  const { paired, state, disconnect, pairAgain } = useHub();
  const [notifications, setNotifications] = useState<string | undefined>(undefined);
  // Read again each time the tab shows: the person may have changed it in iOS Settings meanwhile.
  useFocusEffect(
    useCallback(() => {
      void Notifications.getPermissionsAsync()
        .then((p) => setNotifications(p.granted ? "On" : p.canAskAgain ? "Not asked yet" : "Off"))
        .catch(() => setNotifications(undefined));
    }, []),
  );
  const hub = state.hub;
  const version = Constants.expoConfig?.version;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <ConnectionLine state={hub} onPairAgain={pairAgain} />
      <ListSection header="Hub">
        <ListRow icon="server" title="Name" value={paired.hubName} />
        <ListRow icon="link" tint={t.tints[5]} title="Address" value={paired.hub} selectable />
        <ListRow
          icon="update"
          tint={hub.phase === "live" ? t.success : t.warning}
          title="Status"
          value={hub.phase === "live" && hub.version !== undefined ? `${statusOf(hub.phase)} · ${hub.version}` : statusOf(hub.phase)}
        />
      </ListSection>
      <ListSection header="Notifications" footer="The hub seals each notification to this phone's own key, so only this phone can read it.">
        <ListRow icon="bell" tint={t.danger} title="Notifications" value={notifications} onPress={() => void Linking.openSettings()} />
      </ListSection>
      <ListSection header="This phone">
        <ListRow icon="phone" tint="#8E8E93" title="Name" value={Device.deviceName ?? undefined} />
        <ListRow icon="sparkles" tint={t.tints[3]} title="App version" value={version} selectable />
        <ListRow icon="update" tint={t.tints[6]} title="Update" value={updateWords()} />
      </ListSection>
      <ListSection footer={`Signs this phone out of ${paired.hubName}. Pairing again takes a new code.`}>
        <ListRow title="Disconnect" destructive onPress={disconnect} chevron={false} />
      </ListSection>
    </ScrollView>
  );
}
