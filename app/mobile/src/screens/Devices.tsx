// Settings › Devices: the person's own devices on this hub, newest first (devices.ts), where the "New sign-in"
// notification opens. Tapping another device asks, then signs it out (device_revoke): its key stops working at once.
// This phone is marked and has no action here: Disconnect in Settings signs it out.
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { listTime } from "../chatView";
import { myDevices, signOutWords } from "../devices";
import { useHub } from "../hubContext";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { confirmDestructive, errorWords, Problem, useRead } from "./manage/parts";
import { useNow } from "./time";

export function Devices() {
  const t = useTheme();
  const now = useNow();
  const { paired, session } = useHub();
  const read = useRead(() => session.call("people_list", {}), [session]);
  const r = read.value;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const rows = r.ok ? myDevices(r.output.devices, r.output.me, r.output.thisDevice, (at) => listTime(at, now)) : [];
  const signOut = (keyId: string, name: string) =>
    confirmDestructive({
      ...signOutWords(name, paired.hubName),
      button: "Sign Out",
      onConfirm: () =>
        void session.call("device_revoke", { keyId }).then((out) => {
          if (out.ok) haptics.success();
          else Alert.alert(`Couldn't sign out ${name}`, errorWords(out.error));
          read.reload();
        }),
    });
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {!r.ok ? (
        <Problem text={`Couldn't read your devices: ${errorWords(r.error)}`} />
      ) : (
        <ListSection footer="One you don't know? Tap it to sign it out.">
          {rows.map((d) =>
            d.here ? (
              <ListRow key={d.keyId} title={d.name} detail={d.detail} value="This phone" chevron={false} />
            ) : (
              <ListRow key={d.keyId} title={d.name} detail={d.detail} chevron={false} onPress={() => signOut(d.keyId, d.name)} />
            ),
          )}
        </ListSection>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
});
