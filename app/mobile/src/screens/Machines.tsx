// Settings › Machines, for admins (machines.ts), as the desktop's Hub › Machines has it (D550): the machines and how
// each is; the providers the team connects with its own key, one list, each with what it can run, a tap opening its
// screen (Provider.tsx: connect, its limit, Test, Disconnect); then what runs where: Linux machine (where agents and
// their browser, Linux desktop and Android run; a choice once there is more than one place), Mac machine, and how long
// recordings are kept. Network holds Tailscale, the team's tailnet for its hosted sandboxes: a tap connects it (the hub
// answers with Tailscale's sign-in page, which opens), opens the sign-in again while it waits, or disconnects it.
// Updates stay on Settings itself, with Restart Hub. A hub without sandbox_get lists no providers, and one without
// tailnet_get no Network. On a fleetd cloud team (sandbox_get's `provided`, or Billing's word from a cloud that doesn't
// answer the pick yet) the provider is fleetd's computers: no provider row, Linux machine picks between the team's own
// machines and fleetd's computers, Mac machine says Macs are the team's own, and a section of its own lists each bot
// running there, awake or asleep with the size its agents get, how many run at once and this period's computer time,
// which opens Billing.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { useEffect } from "react";
import { ActionSheetIOS, Alert, Linking, Platform, RefreshControl, ScrollView } from "react-native";
import type { MachineRolesOutput, ProjectSummary, SandboxState, TailnetState } from "../../../desktop/src/shared/contracts";
import { billingOn, heldLine, readTeamBilling, sizeWord, usedWord } from "../billing";
import { useHub, type SettingsParams } from "../hubContext";
import {
  atOnceWord,
  canWords,
  computerStateWord,
  daysChoices,
  FLEETD,
  LINUX,
  linuxChoices,
  linuxValue,
  MAC,
  MAC_OWN_ONLY,
  machinesRun,
  machineValue,
  teamMachines,
  NONE,
  providersFooter,
  providedChoices,
  providedValue,
  providersOf,
  providerValue,
  runnerOf,
  RUNNER_ID,
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
  const { session, state, paired } = useHub();
  const navigation = useNavigation<NavigationProp<SettingsParams>>();
  const sandboxes = useRead(() => session.call("sandbox_get", {}), [session]);
  const roles = useRead(() => session.call("machine_roles", {}), [session]);
  const tailnet = useRead(() => session.call("tailnet_get", {}), [session]);
  const billing = useRead(() => (paired.cloud === true ? readTeamBilling(paired) : Promise.resolve(undefined)), [paired]);
  const sb = sandboxes.value?.ok === true ? (sandboxes.value.output as SandboxState) : undefined;
  const mr = roles.value?.ok === true ? (roles.value.output as MachineRolesOutput) : undefined;
  const ts = tailnet.value?.ok === true ? (tailnet.value.output as TailnetState) : undefined;
  const reload = () => {
    sandboxes.reload();
    roles.reload();
    tailnet.reload();
    billing.reload();
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
  // fleetd's computers: the cloud's pick, or (a cloud that doesn't answer it yet) Billing's word that they are on.
  const bill = billing.value?.ok === true ? billing.value.value : undefined;
  const provided = sb?.provided === true;
  const fleetd = provided || (paired.cloud === true && billingOn(bill));
  const providers = provided ? [] : providersOf(sb);
  const runner = runnerOf(state.machines);
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
  const choices = provided ? providedChoices(sb.providers[0]?.provider ?? "boat", ours) : linuxChoices(sb?.providers ?? [], ours, current);
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
    ) : fleetd ? (
      <ListRow title={LINUX} value={provided ? FLEETD : providedValue(ours)} chevron={false} />
    ) : (
      <ListRow title={LINUX} value={choices[0]?.label ?? linuxValue(sb?.providers ?? [], ours)} chevron={false} />
    );
  const bots = Object.values(state.projects ?? {})
    .filter((p) => p.machineId === RUNNER_ID && p.archivedAt === undefined)
    .sort((a, b) => a.title.localeCompare(b.title));
  const atOnce = provided ? atOnceWord(sb.providers) : undefined;
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
            const v = providerValue(p, runner);
            return (
              <ListRow
                key={p.id}
                title={specOf(p.id).name}
                detail={canWords(specOf(p.id))}
                value={v.text}
                {...(v.problem ? { valueColor: t.danger } : v.warn === true ? { valueColor: t.warning } : {})}
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
        <ListRow title={MAC} value={mac ? YOURS : NONE} {...(fleetd ? { detail: MAC_OWN_ONLY } : {})} chevron={false} />
        {retention === undefined ? null : <ListRow title="Keep Recordings For" value={`${retention.retentionDays} days`} onPress={() => setDays(retention)} />}
      </ListSection>
      {!fleetd || bill === undefined ? null : (
        <ListSection header={FLEETD}>
          {bots.map((p) => (
            <BotComputer key={p.projectId} project={p} asleep={state.chatStates[`${p.machineId}/${p.projectId}`]?.leadAsleep === true} />
          ))}
          {atOnce === undefined ? null : (
            <ListRow
              title="At Once"
              {...(atOnce === null ? { value: "None", detail: heldLine(bill), valueColor: t.danger, onPress: () => navigation.navigate("Billing") } : { value: atOnce.replace(/ at once$/u, ""), chevron: false })}
            />
          )}
          <ListRow title="Computer Time" value={usedWord(bill)} onPress={() => navigation.navigate("Billing")} />
        </ListSection>
      )}
    </ScrollView>
  );
}

/** A bot on fleetd's computers: its lead's computer awake or asleep, and the size its agents get (its Computer's pick). */
function BotComputer({ project, asleep }: { project: ProjectSummary; asleep: boolean }) {
  const { session } = useHub();
  const read = useRead(() => session.call("project_settings_get", { machineId: project.machineId, projectId: project.projectId }), [session, project.machineId, project.projectId]);
  const pick = read.value?.ok === true ? (read.value.output as { settings: { computer?: { cpu: number; memGb: number } } }).settings.computer : undefined;
  return <ListRow title={project.title} detail={pick === undefined ? "Automatic" : sizeWord(pick)} value={computerStateWord(asleep)} chevron={false} />;
}
