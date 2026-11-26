// Settings, behind the person's avatar on Chats, as calm grouped cards: the person on top (their picture or initials,
// which a tap offers to give or take away a photo; their name, changed in place; their role on the hub); then the hub
// (how the link is, its address and version; on a fleetd cloud team, its owner's Delete Team), Connections (Connections.tsx: Paper, Notion, Tailscale and custom
// MCPs), the person's Devices on it (Devices.tsx), the hubs this phone keeps to switch between and the fleetd account
// (Cloud.tsx), for an admin Restart Hub and its update, Machines (the machines, the team's providers and what runs where) and
// Providers (what agents run on: Anthropic, Google; Providers.tsx), on a
// fleetd cloud team Billing once fleetd's computers are on for it (Billing.tsx), the Vault (screens/vault) on a
// hub that has one, Memory (the person's own, with Import Memory), this phone (its notifications, name and app), fleetd.sh's
// Privacy Policy, Terms of Service and Support in Safari (App Store 5.1.1(i)), and Disconnect, which asks first.
import { useFocusEffect, useNavigation, type NavigationProp } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useState } from "react";
import { ActionSheetIOS, Alert, AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { linkTone, linkWords as statusOf } from "../chatsBar";
import type { HubRole } from "../desktop";
import { useHub, type RootParams, type SettingsParams } from "../hubContext";
import { atRest, MY_NAME_MAX, NameField, shownName, type NameEdit } from "../myName";
import { pushDeps } from "../notifications";
import { shape, space, type, useTheme } from "../theme";
import { Avatar } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { shortVersion } from "../updates";
import { removeMyPicture, setMyName } from "./manage/api";
import { errorWords } from "./manage/parts";
import { fromLibrary } from "./manage/pick";
import { CloudSettings } from "./Cloud";
import { RestartHub } from "./RestartHub";
import { UpdateFleetd } from "./UpdateFleetd";
import { vaultShown } from "./vault/model";
import { machinesShown } from "../machines";
import { billingShown, readTeamBilling, type BillingState } from "../billing";
import { claudeShown } from "../claude";
import { deleteTeam, deleteTeamShown } from "../team";
import { LEGAL_PAGES } from "../accountDelete";

/** Settings' words for fleetd.sh's pages, in iOS's title case. */
const LEGAL_TITLES = { privacy: "Privacy Policy", terms: "Terms of Service", support: "Support" } as const;

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
  const { paired, state, session, disconnect, forget } = useHub();
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
  // Whether the team has Billing yet: read on each visit, as the page itself is; a failed read keeps the last answer.
  const [billing, setBilling] = useState<BillingState | null>(null);
  const asksBilling = paired.cloud === true && state.admin === true;
  useFocusEffect(
    useCallback(() => {
      if (!asksBilling) return;
      let live = true;
      void readTeamBilling(paired).then((got) => {
        if (live && got.ok) setBilling(got.value);
      });
      return () => {
        live = false;
      };
    }, [asksBilling, paired]),
  );
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
  // One confirm: the team's name typed again, which the team checks too. Gone, the phone forgets it.
  const [deleting, setDeleting] = useState(false);
  const onDeleteTeam = () => {
    const remove = (typed?: string) => {
      if (typed === undefined || typed.trim() === "") return;
      setDeleting(true);
      void deleteTeam(paired, typed)
        .then((out) => {
          if (!out.ok) {
            haptics.warning();
            Alert.alert("The team wasn't deleted", `${out.failure.message} ${out.failure.fix ?? ""}`.trim());
            return;
          }
          haptics.success();
          forget();
        })
        .finally(() => setDeleting(false));
    };
    if (Platform.OS === "ios") {
      Alert.prompt(
        `Delete ${paired.hubName}?`,
        `Its bots, chats, memory and vault are erased for good. Type ${paired.hubName} to confirm.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: remove },
        ],
        "plain-text",
      );
    } else {
      Alert.alert("Delete Team", "Delete the team on the desktop app or the web app.");
    }
  };
  const picture = <Avatar person name={name} size={58} picture={me === undefined ? undefined : { personId: me, avatar: state.meAvatar }} />;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: space.xxl }}>
      <View style={[styles.card, styles.me, { backgroundColor: t.cell }]}>
        {me === undefined || state.meName === undefined ? (
          <>
            {picture}
            <View style={styles.meText} accessible accessibilityLabel={name}>
              <Text style={[styles.name, { color: t.label }]} numberOfLines={1}>
                {name}
              </Text>
            </View>
          </>
        ) : (
          <>
            <Pressable accessibilityRole="button" accessibilityLabel="Your photo" accessibilityHint="Chooses or removes your photo." hitSlop={8} onPress={onMe} style={({ pressed }) => pressed && styles.pressed}>
              {picture}
            </Pressable>
            <MyName saved={state.meName} role={role} />
          </>
        )}
      </View>
      {/* A fleetd cloud team is a team to the person, and it updates itself: no version of its own to read. */}
      <ListSection header={paired.cloud === true ? "Team" : "Hub"}>
        <ListRow title="Status" value={statusOf(hub.phase)} valueDot={{ live: t.success, busy: t.warning, down: t.tertiary }[linkTone(hub.phase)]} />
        <ListRow title="Address" value={paired.hub} selectable />
        {hub.phase === "live" && hub.version !== undefined && paired.cloud !== true ? (
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
        {deleteTeamShown(paired, state.meRole) ? <ListRow title={deleting ? "Deleting…" : "Delete Team"} destructive {...(deleting ? {} : { onPress: onDeleteTeam })} chevron={false} /> : null}
      </ListSection>
      <ListSection>
        <ListRow title="Connections" onPress={() => navigation.navigate("Connections")} />
        <ListRow title="Devices" onPress={() => navigation.navigate("Devices")} />
      </ListSection>
      <CloudSettings />
      <RestartHub />
      <UpdateFleetd />
      {machinesShown(state.admin) ? (
        <ListSection>
          <ListRow title="Machines" onPress={() => navigation.navigate("Machines")} />
          {claudeShown(state.admin) ? <ListRow title="Providers" onPress={() => navigation.navigate("Providers")} /> : null}
          {billingShown(paired, state.admin, billing) ? <ListRow title="Billing" onPress={() => navigation.navigate("Billing")} /> : null}
        </ListSection>
      ) : null}
      {vaultShown(hub) ? (
        <ListSection footer="The team's logins, cards and addresses, which agents use without seeing them.">
          <ListRow title="Vault" onPress={() => navigation.navigate("Vault")} />
        </ListSection>
      ) : null}
      <ListSection>
        <ListRow title="Memory" onPress={() => navigation.navigate("Memory")} />
      </ListSection>
      <ListSection header="This phone">
        <ListRow title="Notifications" detail="Sealed so only this phone reads them" value={notifications} onPress={onNotifications} />
        <ListRow title="Name" value={Device.deviceName ?? undefined} />
        <ListRow title="App version" value={version} selectable />
        <ListRow title="App update" value={updateWords()} />
      </ListSection>
      <ListSection>
        {LEGAL_PAGES.map((page) => (
          <ListRow
            key={page.id}
            title={LEGAL_TITLES[page.id]}
            onPress={() => void Linking.openURL(page.url)}
            accessory={<Icon name="external" size={14} color={t.tertiary} />}
            chevron={false}
          />
        ))}
      </ListSection>
      <ListSection footer={`Signs this phone out of ${paired.hubName}. Pairing again takes a new code.`}>
        <ListRow title="Disconnect" destructive onPress={disconnect} chevron={false} />
      </ListSection>
    </ScrollView>
  );
}

/**
 * The person's name, changed in place as a contact's is: Done or leaving the field saves it (person_name_set). The hub's
 * cleaned name shows once kept; what it refuses (an empty name) shows under the field in its words, in the role's place,
 * with what was typed kept. The hub's people.changed brings the name back as every open app has it. Back with the
 * keyboard still up takes the screen away before the field hears it was left, so going away saves what was typed too;
 * with no field left to say why the hub refused that, an alert does.
 */
function MyName({ saved, role }: { saved: string; role: string | undefined }) {
  const t = useTheme();
  const { session } = useHub();
  const [edit, setEdit] = useState<NameEdit>(atRest);
  // One for the field's life: the session never changes while paired.
  const [field] = useState(
    () =>
      new NameField(saved, {
        save: async (name) => {
          const r = await setMyName(session, name);
          if (r.ok) haptics.success();
          else haptics.warning();
          return r.ok ? { ok: true, name: r.value } : { ok: false, error: errorWords(r.error) };
        },
        show: setEdit,
        lost: (error) => Alert.alert("Couldn't change your name", error),
      }),
  );
  // The hub's name changed (ours kept, or a change made on another device): the field shows it.
  useEffect(() => field.named(saved), [field, saved]);
  useEffect(() => () => field.gone(), [field]);
  return (
    <View style={styles.meText}>
      <TextInput
        value={shownName(edit, saved)}
        onChangeText={(text) => field.typed(text)}
        onBlur={() => field.left()}
        editable={!edit.busy}
        maxLength={MY_NAME_MAX}
        placeholder={saved}
        placeholderTextColor={t.tertiary}
        selectionColor={t.accent}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
        clearButtonMode="while-editing"
        accessibilityLabel="Your name"
        accessibilityHint="Changes what your teammates and the leads call you."
        style={[styles.nameField, { color: t.label }]}
      />
      {edit.error !== null ? (
        <Text style={[type.subhead, { color: t.danger }]} accessibilityRole="alert">
          {edit.error}
        </Text>
      ) : role === undefined ? null : (
        <Text style={[type.subhead, { color: t.secondary }]} numberOfLines={1}>
          {role}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.sm, borderRadius: shape.group, borderCurve: "continuous", overflow: "hidden" },
  me: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: space.lg, paddingVertical: 14 },
  meText: { flex: 1, gap: 2 },
  name: { fontSize: 20, lineHeight: 25, fontWeight: "600", letterSpacing: -0.2 },
  // The name as a field: its line's height without a line height, which iOS would set a field's text low by.
  nameField: { fontSize: 20, fontWeight: "600", letterSpacing: -0.2, height: 25, padding: 0 },
  pressed: { opacity: 0.6 },
});
