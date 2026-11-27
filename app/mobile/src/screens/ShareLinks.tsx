// Settings › Share links: the workspace's open share links (dev servers agents or people shared, for its signed-in
// members only), each opened signed in with a tap, renewed or stopped from its menu, and for an owner or admin the
// switch that turns the feature on or off for the workspace (share_links_settings_set). Renew is a person's, so on
// fleetd's computers it also keeps the link's computer running to the link's new end; such a link's row says so.
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch } from "react-native";
import { keptRunning } from "../machines";
import { useHub } from "../hubContext";
import { openPreview, untilWords } from "../preview";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { machineName } from "./manage/model";
import { errorWords, Problem, useRead } from "./manage/parts";

/** How long Renew Link keeps a link open from now, as the desktop's Renew does. */
const RENEW_MINUTES = 120;

export function ShareLinks() {
  const t = useTheme();
  const { session, state } = useHub();
  const read = useRead(() => session.call("share_links_list", {}), [session]);
  const r = read.value;
  if (r === undefined) return <ActivityIndicator style={styles.loading} color={t.secondary} />;
  const admin = state.admin === true;
  const setOn = (enabled: boolean) =>
    void session.call("share_links_settings_set", { enabled }).then((out) => {
      if (out.ok) haptics.success();
      else Alert.alert(enabled ? "Share links didn't turn on" : "Share links didn't turn off", errorWords(out.error));
      read.reload();
    });
  const renew = (name: string) =>
    void session.call("share_link_renew", { name, minutes: RENEW_MINUTES }).then((out) => {
      if (out.ok) haptics.success();
      else Alert.alert("The link wasn't renewed", errorWords(out.error));
      read.reload();
    });
  const stop = (name: string) =>
    void session.call("share_link_revoke", { name }).then((out) => {
      if (out.ok) haptics.success();
      else Alert.alert("The link wasn't stopped", errorWords(out.error));
      read.reload();
    });
  const menu = (name: string, title: string) => {
    const pick = (i: number) => (i === 0 ? void openPreview(session, name) : i === 1 ? renew(name) : i === 2 ? stop(name) : undefined);
    if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions({ title, options: ["Open Preview", "Renew Link", "Stop Link", "Cancel"], destructiveButtonIndex: 2, cancelButtonIndex: 3 }, pick);
    else
      Alert.alert(title, undefined, [
        { text: "Open Preview", onPress: () => pick(0) },
        { text: "Renew Link", onPress: () => pick(1) },
        { text: "Stop Link", style: "destructive", onPress: () => pick(2) },
        { text: "Cancel", style: "cancel" },
      ]);
  };
  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={read.reload} tintColor={t.secondary} />}
    >
      {!r.ok ? (
        <Problem text={`Couldn't read the share links: ${errorWords(r.error)}`} />
      ) : (
        <>
          {admin ? (
            <ListSection footer="Agents and people turn a dev server's port into a link that only this workspace's signed-in members open. Each ends after a few hours.">
              <ListRow title="Share Links" accessory={<Switch value={r.output.enabled} onValueChange={setOn} accessibilityLabel="Share links" />} />
            </ListSection>
          ) : null}
          <ListSection header="Open links" footer={r.output.links.length === 0 ? "None open. Agents make them as they start dev servers." : "Tap one to open, renew or stop it."}>
            {r.output.links.map((l) => {
              const title = l.label ?? `Port ${String(l.port)}`;
              const kept = keptRunning(l.machineId);
              // A link on the workspace's hosted sandboxes is only ever on fleetd's computers, so it names them, as the desktop does.
              const where = `Port ${String(l.port)} on ${machineName(state.machines, l.machineId, true)} · ${untilWords(l.expiresAt)}`;
              return <ListRow key={l.name} title={title} detail={kept === undefined ? where : `${where}\n${kept}`} icon="browser" onPress={() => menu(l.name, title)} chevron={false} />;
            })}
          </ListSection>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 64 },
});
