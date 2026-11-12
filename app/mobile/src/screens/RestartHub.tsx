// Settings' Restart Hub row, for admins (hubRestart.ts), above the hub's update: it asks first, saying what a restart
// does, then says Restarting… until the hub is back, how many leads start again on the current lead profile, or why it
// didn't restart.
import { useEffect, useState } from "react";
import { ActionSheetIOS, Alert, Platform } from "react-native";
import { serves } from "../desktop";
import { useHub } from "../hubContext";
import { afterAnswer, afterLink, restartRow, RESTART_FOOTER, RESTART_NOTE, RESTART_TITLE, RESTART_WAIT_MS, type RestartStep } from "../hubRestart";
import { useAnnounce } from "../ui/announce";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";

export function RestartHub() {
  const { state, session } = useHub();
  const [asked, setStep] = useState<RestartStep>({ at: "idle" });
  // A render when a hub that took the restart has stayed up too long.
  const [, setLate] = useState(0);
  const restarting = asked.at === "restarting";
  useEffect(() => {
    if (!restarting) return;
    const timer = setTimeout(() => setLate((n) => n + 1), RESTART_WAIT_MS);
    return () => clearTimeout(timer);
  }, [restarting]);
  // Small and cheap: read on every render, against the clock.
  const step = afterLink(asked, state.hub, state.restart, Date.now());
  if (step !== asked) setStep(step);
  const row = restartRow(state.admin, state.hub, step, serves(state, "hub_restart"));
  useAnnounce(row?.value ?? row?.detail);
  if (row === null) return null;

  const go = () => {
    haptics.firm();
    const at = Date.now();
    setStep({ at: "asking", asked: at });
    void session.call("hub_restart", {}).then((out) => setStep(afterAnswer(at, out)));
  };
  const confirm = () => {
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ title: RESTART_TITLE, message: RESTART_NOTE, options: ["Restart", "Cancel"], cancelButtonIndex: 1 }, (i) => {
        if (i === 0) go();
      });
    } else {
      Alert.alert(RESTART_TITLE, RESTART_NOTE, [
        { text: "Cancel", style: "cancel" },
        { text: "Restart", onPress: go },
      ]);
    }
  };
  return (
    <ListSection footer={RESTART_FOOTER}>
      <ListRow title="Restart Hub" detail={row.detail} value={row.value} {...(row.canAsk ? { onPress: confirm, chevron: false } : {})} />
    </ListSection>
  );
}
