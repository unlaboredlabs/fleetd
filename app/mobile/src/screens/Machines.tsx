// Settings › Machines, for admins (machines.ts), as the desktop's Hub › Machines has it (D550): the machines and how
// each is; the providers the team connects with its own key, one list, each with what it can run, a tap opening its
// screen (Provider.tsx: connect, its limit, Test, Disconnect); then what runs where, a row per kind, and how long
// recordings are kept. Updates stay on Settings itself, with Restart Hub. A hub without sandbox_get lists no providers.
import { useNavigation, type NavigationProp } from "@react-navigation/native";
import { ActionSheetIOS, Alert, Platform, RefreshControl, ScrollView } from "react-native";
import type { MachineRolesOutput, SandboxState } from "../../../desktop/src/shared/contracts";
import { useHub, type SettingsParams } from "../hubContext";
import {
  agentsWhere,
  CAPABILITY_WORDS,
  canWords,
  daysChoices,
  KINDS,
  machinesRun,
  machineValue,
  NONE,
  providersFooter,
  providersOf,
  providerValue,
  specOf,
  YOURS,
  type Capability,
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
  const sb = sandboxes.value?.ok === true ? (sandboxes.value.output as SandboxState) : undefined;
  const mr = roles.value?.ok === true ? (roles.value.output as MachineRolesOutput) : undefined;
  const reload = () => {
    sandboxes.reload();
    roles.reload();
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
  const kindRow = (kind: Capability) => {
    const title = CAPABILITY_WORDS[kind];
    if (kind === "agents") return <ListRow key={kind} title={title} value={agentsWhere(sb?.providers ?? [])} chevron={false} />;
    const ours = mr === undefined || machinesRun(kind, mr.machines);
    return <ListRow key={kind} title={title} value={ours ? YOURS : NONE} chevron={false} />;
  };

  return (
    <ScrollView
      style={{ backgroundColor: t.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={t.secondary} />}
    >
      <ListSection header="Machines">
        {state.machines.length === 0 ? <ListRow title="No machines yet" chevron={false} /> : null}
        {state.machines.map((m) => {
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
      <ListSection header="What runs where">
        {KINDS.map(kindRow)}
        {retention === undefined ? null : <ListRow title="Keep Recordings For" value={`${retention.retentionDays} days`} onPress={() => setDays(retention)} />}
      </ListSection>
    </ScrollView>
  );
}
