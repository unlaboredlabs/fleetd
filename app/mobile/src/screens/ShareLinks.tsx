// Settings › Share links: the workspace's open share links (dev servers agents or people shared, for its signed-in
// members only), each opened signed in with a tap or stopped from its menu, and for an owner or admin the switch that
// turns the feature on or off for the workspace (share_links_settings_set).
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch } from "react-native";
import { useHub } from "../hubContext";
import { openPreview, untilWords } from "../preview";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { errorWords, Problem, useRead } from "./manage/parts";

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
  const stop = (name: string) =>
    void session.call("share_link_revoke", { name }).then((out) => {
      if (out.ok) haptics.success();
      else Alert.alert("The link wasn't stopped", errorWords(out.error));
      read.reload();
    });
  const menu = (name: string, title: string) => {
    const pick = (i: number) => (i === 0 ? void openPreview(session, name) : i === 1 ? stop(name) : undefined);
    if (Platform.OS === "ios") ActionSheetIOS.showActionSheetWithOptions({ title, options: ["Open Preview", "Stop Link", "Cancel"], destructiveButtonIndex: 1, cancelButtonIndex: 2 }, pick);
    else Alert.alert(title, undefined, [{ text: "Open Preview", onPress: () => pick(0) }, { text: "Stop Link", style: "destructive", onPress: () => pick(1) }, { text: "Cancel", style: "cancel" }]);
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
          <ListSection header="Open links" footer={r.output.links.length === 0 ? "None open. Agents make them as they start dev servers." : "Tap one to open or stop it."}>
            {r.output.links.map((l) => {
              const title = l.label ?? `Port ${String(l.port)}`;
              return <ListRow key={l.name} title={title} detail={`Port ${String(l.port)} on ${l.machineId} · ${untilWords(l.expiresAt)}`} icon="browser" onPress={() => menu(l.name, title)} chevron={false} />;
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
