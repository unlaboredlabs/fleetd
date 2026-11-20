// Settings › Machines, for admins (machines.ts), as the desktop's Hub › Machines has it (D550): the machines and how
// each is; the providers the team connects with its own key, one list, each with what it can run, a tap opening its
// screen (Provider.tsx: connect, its limit, Test, Disconnect); then what runs where: Linux machine (where agents and
// their browser, Linux desktop and Android run; a choice once there is more than one place), Mac machine, and how long
// recordings are kept. Network holds Tailscale, the team's tailnet for its hosted sandboxes: a tap connects it (the hub
// answers with Tailscale's sign-in page, which opens), opens the sign-in again while it waits, or disconnects it.
// Updates stay on Settings itself, with Restart Hub. A hub without sandbox_get lists no providers, and one without
// tailnet_get no Network.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect } from "react";
import { ActionSheetIOS, Alert, Linking, Platform, RefreshControl, ScrollView } from "react-native";
import type { MachineRolesOutput, SandboxState, TailnetState } from "../../../desktop/src/shared/contracts";
import { useHub, type SettingsParams } from "../hubContext";
import {
  canWords,
  daysChoices,
  LINUX,
  linuxChoices,
  linuxValue,
  MAC,
  machinesRun,
  machineValue,
  teamMachines,
  NONE,
  providersFooter,
  providersOf,
  providerValue,
  specOf,
  tailnetValue,
  tailnetWaiting,
  CONNECT_WAIT_MS,
  YOURS,
} from "../machines";
import { space, useTheme } from "../theme";
import { haptics } from "../ui/haptics";
import { ListRow, ListSection } from "../ui/List";
import { errorWords, Problem, useRead } from "./manage/parts";

/** A choice from a short list, as an action sheet on iOS and an alert elsewhere. */
export const pick = (title: string, labels: string[], onPick: (i: number) => void): void => {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions({ title, options: [...labels, "Cancel"], cancelButtonIndex: labels.length }, (i) => {
      if (i < labels.length) onPick(i);
    });
    return;
  }
  Alert.alert(title, undefined, [...labels.slice(0, 8).map((text, i) => ({ text, onPress: () => onPick(i) })), { text: "Cancel", style: "cancel" as const }]);
};

export function Machines() {
  const t = useTheme();
  const { session, state } = useHub();
  const navigation = useNavigation<NavigationProp<SettingsParams>>();
  const sandboxes = useRead(() => session.call("sandbox_get", {}), [session]);
  const roles = useRead(() => session.call("machine_roles", {}), [session]);
  const tailnet = useRead(() => session.call("tailnet_get", {}), [session]);
  const sb = sandboxes.value?.ok === true ? (sandboxes.value.output as SandboxState) : undefined;
  const mr = roles.value?.ok === true ? (roles.value.output as MachineRolesOutput) : undefined;
  const ts = tailnet.value?.ok === true ? (tailnet.value.output as TailnetState) : undefined;
  const reload = () => {
    sandboxes.reload();
    roles.reload();
    tailnet.reload();
  };
  // The person signs in on Tailscale's page: its state is read again until it isn't waiting on them.
  const waitingOn = tailnetWaiting(ts);
  const rereadTailnet = tailnet.reload;
  useEffect(() => {
    if (!waitingOn) return;
    const timer = setInterval(rereadTailnet, 2_000);
    return () => clearInterval(timer);
  }, [waitingOn, rereadTailnet]);

  const disconnectTailnet = (s: TailnetState) =>
    Alert.alert(
      s.status === "connected" ? "Disconnect Tailscale?" : "Stop connecting Tailscale?",
      "The hub logs its device out of your tailnet and deletes its state. Hosted sandboxes lose the tailnet at once.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void session.call("tailnet_disconnect", {}).then((out) => {
              if (out.ok) haptics.success();
              else Alert.alert("Not disconnected", errorWords(out.error));
              tailnet.reload();
            }),
        },
      ],
    );
  const onTailnet = (s: TailnetState) => {
    if (s.status === "connected") return pick("Tailscale", ["Disconnect"], () => disconnectTailnet(s));
    if (s.status === "login" && s.loginUrl !== undefined) {
      const url = s.loginUrl;
      return pick("Tailscale", ["Open Sign-In", "Cancel Connecting"], (i) => (i === 0 ? void Linking.openURL(url) : disconnectTailnet(s)));
    }
    if (s.status === "approve") return pick("Tailscale", ["Open Tailscale", "Cancel Connecting"], (i) => (i === 0 ? void Linking.openURL("https://login.tailscale.com/admin/machines") : disconnectTailnet(s)));
    if (s.status === "starting" || (s.status === "off" && s.problem !== undefined)) return;
    // As long as the hub can take: a first Connect downloads Tailscale, starts it and waits for its sign-in page.
    void session.call("tailnet_connect", {}, CONNECT_WAIT_MS).then((out) => {
      tailnet.reload();
      if (!out.ok) return Alert.alert("Not connected", errorWords(out.error));
      const url = (out.output as TailnetState).loginUrl;
      if (url !== undefined) void Linking.openURL(url);
    });
    // Meanwhile the row reads the hub's state, which says it is starting, and goes on reading it until it isn't.
    setTimeout(rereadTailnet, 1_000);
  };
  const providers = providersOf(sb);
  const failed = [sandboxes.value].flatMap((v) => (v !== undefined && !v.ok && v.error.code !== "not_found" ? [errorWords(v.error)] : []));

  const setDays = (retention: NonNullable<MachineRolesOutput["retention"]>) => {
    const days = daysChoices(retention.retentionDays);
    pick("Keep screen recordings for", days.map((d) => `${d} days`), (i) => {
      const n = days[i];
      if (n === undefined) return;
      // The size limit stays as the hub has it: a safety net, not a choice here.
      void session.call("browser_retention_set", { retentionDays: n, maxGbPerProject: retention.maxGbPerProject }).then((out) => {
        if (out.ok) haptics.success();
        else Alert.alert("Not changed", errorWords(out.error));
        roles.reload();
      });
    });
  };

  const retention = mr?.retention;
  // The hub's runner for hosted sandboxes is no machine of the team's.
  const team = teamMachines(state.machines);
  const ours = mr === undefined || machinesRun("agents", mr.machines.filter((m) => state.machines.find((x) => x.machineId === m.machineId)?.runner !== true));
  const current = sb?.linux ?? "ours_first";
  const choices = linuxChoices(sb?.providers ?? [], ours, current);
  const setLinux = () => {
    pick(LINUX, choices.map((c) => c.label), (i) => {
      const next = choices[i];
      if (next === undefined || next.value === current) return;
      void session.call("sandbox_where_set", { linux: next.value }).then((out) => {
        if (out.ok) haptics.success();
        else Alert.alert("Not changed", errorWords(out.error));
        sandboxes.reload();
      });
    });
  };
  const linuxRow =
    sb !== undefined && choices.length > 1 ? (
      <ListRow title={LINUX} value={choices.find((c) => c.value === current)?.label ?? current} onPress={setLinux} />
    ) : (
      <ListRow title={LINUX} value={choices[0]?.label ?? linuxValue(sb?.providers ?? [], ours)} chevron={false} />
    );
  const mac = mr === undefined || machinesRun("mac", mr.machines);

  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={t.secondary} />}
    >
      <ListSection header="Machines">
        {team.length === 0 ? <ListRow title="No machines yet" chevron={false} /> : null}
        {team.map((m) => {
          const v = machineValue(m);
          return <ListRow key={m.machineId} title={m.name} value={v.text} {...(v.warn ? { valueDot: t.warning } : {})} chevron={false} />;
        })}
      </ListSection>
      {providers.length === 0 && failed.length === 0 ? null : (
        <ListSection header="Providers" footer={providersFooter(sb)}>
          {providers.map((p) => {
            const v = providerValue(p);
            return (
              <ListRow
                key={p.id}
                title={specOf(p.id).name}
                detail={canWords(specOf(p.id))}
                value={v.text}
                {...(v.problem ? { valueColor: t.danger } : {})}
                onPress={() => navigation.navigate("Provider", { id: p.id })}
              />
            );
          })}
        </ListSection>
      )}
      {failed.map((line) => (
        <Problem key={line} text={`Couldn't read the providers: ${line}`} />
      ))}
      {ts === undefined ? null : (
        <ListSection header="Network">
          {(() => {
            const v = tailnetValue(ts);
            return (
              <ListRow
                title="Tailscale"
                value={v.text}
                {...(v.detail === undefined ? {} : { detail: v.detail })}
                {...(v.problem ? { valueColor: t.danger } : {})}
                {...(ts.status === "connected" ? { valueDot: t.success } : {})}
                {...(ts.status === "starting" || (ts.status === "off" && ts.problem !== undefined) ? { chevron: false } : { onPress: () => onTailnet(ts) })}
              />
            );
          })()}
        </ListSection>
      )}
      <ListSection header="What runs where">
        {linuxRow}
        <ListRow title={MAC} value={mac ? YOURS : NONE} chevron={false} />
        {retention === undefined ? null : <ListRow title="Keep Recordings For" value={`${retention.retentionDays} days`} onPress={() => setDays(retention)} />}
      </ListSection>
    </ScrollView>
  );
}
