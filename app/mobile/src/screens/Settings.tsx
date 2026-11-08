// Settings, behind the person's avatar on Chats, as calm grouped cards: the person on top (their picture or initials,
// their name, their role on the hub), which a tap offers to give or take away a photo; then the hub (how the link is,
// its address and version), for an admin its update, Import Memory, this phone (its notifications, name and app), and
// Disconnect, which asks first.
import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { useCallback, useState } from "react";
import { ActionSheetIOS, Alert, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { linkTone, linkWords as statusOf } from "../chatsBar";
import type { HubRole } from "../desktop";
import { useHub, type RootParams, type SettingsParams } from "../hubContext";
import { pushDeps } from "../notifications";
import { shape, space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { shortVersion } from "../updates";
import { removeMyPicture } from "./manage/api";
import { errorWords } from "./manage/parts";
import { fromLibrary } from "./manage/pick";
import { UpdateFleetd } from "./UpdateFleetd";

/** What the running JavaScript is: the build's own, or an update over the air and when it was made. */
const updateWords = (): string => {
  if (!Updates.isEnabled) return "Off";
  if (Updates.isEmbeddedLaunch || Updates.createdAt === null) return "Built in";
  return Updates.createdAt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** A role as the person reads it; one a newer hub has that this app doesn't know reads as a member's. */
const roleWord = (role: HubRole): string => (role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member");

export function Settings() {
  const t = useTheme();
  const { paired, state, session, disconnect } = useHub();
  const navigation = useNavigation<NavigationProp<SettingsParams & RootParams>>();
  const [notifications, setNotifications] = useState<string | undefined>(undefined);
  // Read again each time it shows, and each time the app comes back to the front on it: the person may have changed it
  // in iOS Settings meanwhile (Off opens it, and coming back leaves this screen as it was).
  const read = useCallback(() => {
    void Notifications.getPermissionsAsync()
      .then((p) => setNotifications(p.granted ? "On" : p.canAskAgain ? "Not asked yet" : "Off"))
      .catch(() => setNotifications(undefined));
  }, []);
  useFocusEffect(
    useCallback(() => {
      read();
      const sub = AppState.addEventListener("change", (s) => {
        if (s === "active") read();
      });
      return () => sub.remove();
    }, [read]),
  );
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

  // The person, once the hub says who they are; a hub before people says no one, and its own name stands in.
  const me = state.me;
  const name = state.meName ?? paired.hubName;
  const role = state.meRole === undefined ? undefined : `${roleWord(state.meRole)} · ${paired.hubName}`;
  const choosePhoto = () =>
    void fromLibrary().then((got) => {
      if (got !== null) navigation.navigate("Photo", got);
    });
  const removePhoto = () =>
    void removeMyPicture(session).then((r) => {
      if (!r.ok) return Alert.alert("Couldn't remove the photo", errorWords(r.error));
      haptics.success();
    });
  // Choose Photo, then Move and Scale; Remove Photo once there is one.
  const onMe = () => {
    haptics.select();
    const has = state.meAvatar !== undefined;
    if (Platform.OS === "ios") {
      const options = has ? ["Choose Photo", "Remove Photo", "Cancel"] : ["Choose Photo", "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: options.length - 1, ...(has ? { destructiveButtonIndex: 1 } : {}) }, (i) => {
        if (i === 0) choosePhoto();
        else if (has && i === 1) removePhoto();
      });
    } else {
      Alert.alert("Your photo", undefined, [{ text: "Choose Photo", onPress: choosePhoto }, ...(has ? [{ text: "Remove Photo", style: "destructive" as const, onPress: removePhoto }] : []), { text: "Cancel", style: "cancel" }]);
    }
  };
  const profile = (pressed: boolean) => (
    <View style={[styles.me, pressed && { backgroundColor: t.fillQuiet }]}>
      <Avatar person name={name} size={58} picture={me === undefined ? undefined : { personId: me, avatar: state.meAvatar }} />
      <View style={styles.meText}>
        <Text style={[styles.name, { color: t.label }]} numberOfLines={1}>
          {name}
        </Text>
        {role === undefined ? null : (
          <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
            {role}
          </Text>
        )}
      </View>
    </View>
  );

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={[styles.card, { backgroundColor: t.cell }]}>
        {me === undefined ? (
          <View accessible accessibilityLabel={name}>
            {profile(false)}
          </View>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={role === undefined ? name : `${name}, ${role}`} accessibilityHint="Chooses or removes your photo." onPress={onMe}>
            {({ pressed }) => profile(pressed)}
          </Pressable>
        )}
      </View>
      <ListSection header="Hub">
        <ListRow title="Status" value={statusOf(hub.phase)} valueDot={{ live: t.success, busy: t.warning, down: t.tertiary }[linkTone(hub.phase)]} />
        <ListRow title="Address" value={paired.hub} selectable />
        {hub.phase === "live" && hub.version !== undefined ? (
          <ListRow
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
      <ListSection header="Memory">
        <ListRow title="Import Memory" detail="What another assistant knows about you" onPress={() => navigation.navigate("ImportMemory")} />
      </ListSection>
      <ListSection header="This phone">
        <ListRow title="Notifications" detail="Sealed so only this phone reads them" value={notifications} onPress={onNotifications} />
        <ListRow title="Name" value={Device.deviceName ?? undefined} />
        <ListRow title="App version" value={version} selectable />
        <ListRow title="App update" value={updateWords()} />
      </ListSection>
      <ListSection footer={`Signs this phone out of ${paired.hubName}. Pairing again takes a new code.`}>
        <ListRow title="Disconnect" destructive onPress={disconnect} chevron={false} />
      </ListSection>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.sm, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  me: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: space.lg, paddingVertical: 14 },
  meText: { flex: 1, gap: 2 },
  name: { fontSize: 20, lineHeight: 25, fontWeight: "600", letterSpacing: -0.2 },
});
