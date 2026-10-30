// Settings, as iOS's own and Telegram's: the hub this phone is paired with at the top, on a card as iOS's Apple Account
// (fleetd's mark, its name and how the link is), then its address and version, for an admin its update, its
// notifications, this phone and its app, and Disconnect, which asks first.
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { useCallback, useState } from "react";
import { Image, Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { useHub } from "../hubContext";
import { pushDeps } from "../notifications";
import { shape, space, type, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { shortVersion } from "../updates";
import { UpdateFleetd } from "./UpdateFleetd";

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
  const { paired, state, disconnect } = useHub();
  const [notifications, setNotifications] = useState<string | undefined>(undefined);
  // Read again each time the tab shows: the person may have changed it in iOS Settings meanwhile.
  const read = useCallback(() => {
    void Notifications.getPermissionsAsync()
      .then((p) => setNotifications(p.granted ? "On" : p.canAskAgain ? "Not asked yet" : "Off"))
      .catch(() => setNotifications(undefined));
  }, []);
  useFocusEffect(read);
  // Never asked: asks here (its new token registers the phone with the hub); else iOS Settings is where it changes.
  const onNotifications = () => {
    if (notifications !== "Not asked yet") return void Linking.openSettings();
    void pushDeps
      .token()
      .catch(() => null)
      .then(read);
  };
  const hub = state.hub;
  const version = Constants.expoConfig?.version;
  // A tap shows the hub's whole version, as iOS's About shows its build.
  const [wholeVersion, setWholeVersion] = useState(false);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={[styles.head, { backgroundColor: t.cell }]} accessible accessibilityRole="header" accessibilityLabel={`${paired.hubName}, ${statusOf(hub.phase)}`}>
        {/* A hairline edge in dark, where the mark's dark tile would melt into the card. */}
        <Image source={require("../../assets/icon.png")} style={[styles.mark, t.dark && { borderWidth: StyleSheet.hairlineWidth, borderColor: t.separator }]} accessibilityIgnoresInvertColors />
        <View style={styles.headText}>
          <Text style={[type.title3, { color: t.label }]} numberOfLines={1}>
            {paired.hubName}
          </Text>
          <View style={styles.state}>
            <View style={[styles.dot, { backgroundColor: hub.phase === "live" ? t.success : t.warning }]} />
            <Text style={[type.subhead, styles.stateText, { color: t.secondary }]} numberOfLines={1}>
              {statusOf(hub.phase)}
            </Text>
          </View>
        </View>
      </View>
      <ListSection header="Hub">
        <ListRow icon="link" tint={t.tints[5]} title="Address" value={paired.hub} selectable />
        {hub.phase === "live" && hub.version !== undefined ? (
          <ListRow
            icon="server"
            tint={t.tints[6]}
            title="Version"
            {...(wholeVersion ? { detail: hub.version } : { value: shortVersion(hub.version) })}
            onPress={() => {
              haptics.select();
              setWholeVersion((w) => !w);
            }}
            chevron={false}
          />
        ) : null}
      </ListSection>
      <UpdateFleetd />
      <ListSection header="Notifications" footer="The hub seals each notification to this phone's own key, so only this phone can read it.">
        <ListRow icon="bell" tint={t.danger} title="Notifications" value={notifications} onPress={onNotifications} />
      </ListSection>
      <ListSection header="This phone">
        <ListRow icon="phone" tint="#8E8E93" title="Name" value={Device.deviceName ?? undefined} />
        <ListRow icon="info" tint="#8E8E93" title="App version" value={version} selectable />
        <ListRow icon="update" tint={t.tints[1]} title="App update" value={updateWords()} />
      </ListSection>
      <ListSection footer={`Signs this phone out of ${paired.hubName}. Pairing again takes a new code.`}>
        <ListRow title="Disconnect" destructive onPress={disconnect} chevron={false} />
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.md, marginHorizontal: space.lg, marginTop: space.sm, padding: space.md, borderRadius: shape.group, borderCurve: "continuous" },
  mark: { width: 60, height: 60, borderRadius: 14, borderCurve: "continuous" },
  headText: { flex: 1, gap: 2 },
  state: { flexDirection: "row", alignItems: "center", gap: 6 },
  stateText: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
