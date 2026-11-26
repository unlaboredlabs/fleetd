// fleetd's own question before iOS's notifications prompt: once a paired workspace is live, a sheet says what
// notifications bring and asks; only Turn On Notifications brings iOS's prompt, and a yes registers the device with
// the workspace. Not Now is kept, so the sheet never comes back by itself: Settings' Notifications row asks later.
// Never shown while notifications were already answered, either way.
import * as Notifications from "expo-notifications";
import { File, Paths } from "expo-file-system";
import { useEffect, useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DEVICE } from "../device";
import { useHubSelect, useSession } from "../hubContext";
import { askNotifications } from "../notifications";
import { space, type, useTheme } from "../theme";
import { Being } from "../ui/Being";
import { Button } from "../ui/Button";
import { SheetRoom } from "../ui/StripRoom";

const answered = (): File => new File(Paths.document, "notify-asked.json");

const keptAnswer = (): boolean => {
  try {
    return answered().exists;
  } catch {
    return false;
  }
};

const keepAnswer = (): void => {
  void Promise.resolve()
    .then(() => answered().write(JSON.stringify({ at: Date.now() })))
    .catch(() => undefined);
};

export function NotifyAsk() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useHubSelect((st) => st.hub.phase === "live") === true;
  useEffect(() => {
    if (!live || keptAnswer() || process.env.EXPO_PUBLIC_FLEETD_SCREENS === "1") return;
    let on = true;
    // A moment after the chats show, never over the sign-in or pairing that just ended.
    const timer = setTimeout(() => {
      void Notifications.getPermissionsAsync()
        .then((p) => {
          if (on && p.status === "undetermined") setShown(true);
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      on = false;
      clearTimeout(timer);
    };
  }, [live]);
  const close = () => {
    keepAnswer();
    setShown(false);
  };
  const turnOn = () => {
    setBusy(true);
    void askNotifications()
      .then((allowed) => {
        if (allowed) session.registerPush();
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
        close();
      });
  };
  return (
    <Modal visible={shown} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SheetRoom style={[styles.sheet, { backgroundColor: t.bg, paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.middle}>
          <Being state="needs" size={88} color="blue" />
          <Text style={[type.title1, styles.center, { color: t.label }]} accessibilityRole="header">
            Know when a bot needs you
          </Text>
          <Text style={[type.body, styles.center, { color: t.secondary }]}>
            {`fleetd tells you when a bot asks you something, wants an approval or finishes its work. Each notification is sealed on the way, so only this ${DEVICE} reads it.`}
          </Text>
        </View>
        <View style={styles.buttons}>
          <Button label="Turn On Notifications" size="large" busy={busy} onPress={turnOn} />
          <Button label="Not Now" kind="plain" size="large" disabled={busy} onPress={close} />
        </View>
      </SheetRoom>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: space.xl },
  middle: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, maxWidth: 420, alignSelf: "center" },
  center: { textAlign: "center" },
  buttons: { gap: space.sm, width: "100%", maxWidth: 420, alignSelf: "center" },
});
