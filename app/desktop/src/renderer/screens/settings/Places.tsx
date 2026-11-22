// Hub › Machines' providers and what runs where, each a group in the one model of the page. Providers: every provider
// the team connects with its own key, one list (Providers.tsx), each with what it can run. What runs where: two rows.
// Linux machine is where agents run and their Linux screens with them (an agent's browser, Linux desktop and Android
// run where it runs): your machines, your machines first then the connected providers, or one provider only,
// which the hub keeps (sandbox_where_set) and places by. On a fleetd cloud team the provider is fleetd's computers
// (sandbox_get's `provided`): Your machines, Your machines first then fleetd's computers, or fleetd's computers only,
// and fleetd's computers alone while the team has no machine of its own that runs agents; a cloud that doesn't answer
// the pick yet still says they run there, from Billing. Mac machine is where Mac screens and iOS simulators run: the
// agents' Mac, a plain value, and on a cloud team the team's own only, as its line says. A row with nothing to choose
// is a plain value, or None yet with how to add one in its hover. Then how long recordings are kept.
import { useCallback, useState, type ReactNode } from "react";
import type { SlotState } from "../../../shared/contracts";
import { useData, useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { Select, Text } from "../../ui";
import { fleetCapLine } from "./agentsModel";
import { errorText, useHubCall, useLive } from "./hub";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
import { useProviderRows } from "./Providers";
import { KINDS, LINUX, LINUX_NONE, linuxChoices, linuxValue, MAC, MAC_NONE, machinesRun, NONE, YOURS } from "../../../shared/providers";
import { FLEETD, MAC_OWN_ONLY, providedChoices, providedValue } from "../../../shared/provided";
import { useBillingShown } from "../admin/billingQuery";
import { SECTION_HINT } from "./sandboxModel";
import { Recordings } from "./Screens";
import { AntigravityRow } from "../admin/MachinePage";
import s from "./settings.module.css";

const noInput = {};

/** The hub's slot state for this connection; undefined until it is fresh. */
const useSlots = (): SlotState | undefined => useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));

/**
 * Providers: every one, in the order agents go to the connected ones; nothing on a hub with none (fleetd cloud). Each
 * row says its own state (Sandboxes.tsx), a hosted provider's missing Claude account too.
 */
export function ProvidersGroup() {
  const live = useLive();
  const read = useToolQuery("sandbox_get", noInput, { enabled: live });
  const rows = useProviderRows(KINDS);
  if (rows === null) return null;
  return (
    <SettingsSection title="Providers" reveal="hub.sandboxes" hint={SECTION_HINT} data={{ "data-sandboxes": "" }}>
      {/* A provider fleetd removed that this hub had connected: one plain line, for a while after the update. */}
      {read.data?.removed?.map((line) => <GroupNote key={line}>{line}</GroupNote>)}
      {rows}
    </SettingsSection>
  );
}

const WHERE_HINT =
  "Linux machine runs agents, and their browser, Linux desktop and Android where each agent runs. " +
  "Mac machine runs Mac screens and iOS simulators.";

/** What runs where: Linux machine, Mac machine, then recordings. */
export function WhatRunsWhere() {
  const live = useLive();
  const machines = useToolQuery("machine_roles", noInput).data?.machines;
  const sandboxes = useToolQuery("sandbox_get", noInput, { enabled: live }).data;
  const slots = useSlots();
  const team = useData((d) => d.machines);
  const held = slots === undefined ? null : fleetCapLine(slots);
  const capLine = held === null ? null : <span data-fleet-cap="">{held}</span>;
  // The hub's runner for hosted sandboxes is no machine of the team's.
  const ours = machines === undefined || machinesRun("agents", machines.filter((m) => team[m.machineId]?.runner !== true));
  const providers = sandboxes?.providers ?? [];
  const current = sandboxes?.linux ?? "ours_first";
  // fleetd's computers: the cloud's pick, or (a cloud that doesn't answer it yet) Billing's word that they are on.
  const cloud = useHub().cloud === true;
  const provided = sandboxes?.provided === true;
  const billed = useBillingShown(cloud && live && !provided);
  const fleetd = provided || (cloud && billed);
  const choices = provided ? providedChoices(providers[0]?.provider ?? "boat", ours) : linuxChoices(providers, ours, current);
  const linux =
    sandboxes !== undefined && choices.length > 1 ? (
      <LinuxRow key="linux" current={current} choices={choices} line={capLine} />
    ) : fleetd ? (
      <Plain key="linux" kind="linux" label={LINUX} value={provided ? FLEETD : providedValue(ours)} line={capLine} />
    ) : (
      <Plain key="linux" kind="linux" label={LINUX} value={choices[0]?.label ?? linuxValue(providers, ours)} hint={choices.length === 0 && !ours ? LINUX_NONE : undefined} line={capLine} />
    );
  const mac = machines === undefined || machinesRun("mac", machines);
  // Agents on fleetd's computers sign Antigravity in on the hub's runner, which has no page of its own: once it says
  // it can.
  const runner = machines?.find((m) => team[m.machineId]?.runner === true && m.antigravityLogin === true);
  return (
    <SettingsSection title="What runs where" reveal="hub.where" hint={WHERE_HINT} data={{ "data-where": "" }}>
      {linux}
      {runner === undefined ? null : <AntigravityRow machineId={runner.machineId} />}
      <Plain kind="mac" label={MAC} value={mac ? YOURS : NONE} hint={mac ? undefined : MAC_NONE} line={fleetd ? MAC_OWN_ONLY : undefined} />
      <Recordings />
    </SettingsSection>
  );
}

/** Reads sandbox_get again and waits for it, so a change's answer is on screen as its busy state ends. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "sandbox_get" }), [layer]);
}

/** The Linux machine as a pick: sandbox_where_set, which the hub places agents by. */
function LinuxRow(props: { current: string; choices: { value: string; label: string }[]; line: ReactNode }) {
  const call = useHubCall();
  const reread = useReread();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (linux: string) => {
    setBusy(true);
    setProblem(null);
    void call("sandbox_where_set", { linux })
      .then(
        () => undefined,
        (e: unknown) => setProblem(`Not changed: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(false));
  };
  return (
    <SettingsRow
      title={LINUX}
      line={problem !== null ? <span role="alert">{problem}</span> : props.line}
      lineTone={problem === null ? "quiet" : "danger"}
      data={{ "data-where-kind": "linux" }}
      control={
        <Select aria-label="Where agents and their Linux screens run" className={s.linuxChoice} value={props.current} options={props.choices} disabled={busy} onValueChange={set} />
      }
    />
  );
}

/** A row with nothing to choose: where it runs, as a value. */
function Plain(props: { kind: string; label: string; value: string; hint?: string | undefined; line?: ReactNode }) {
  return (
    <SettingsRow
      title={props.label}
      hint={props.hint}
      line={props.line}
      control={
        <Text tone="quiet" data-where-value="">
          {props.value}
        </Text>
      }
      data={{ "data-where-kind": props.kind }}
    />
  );
}
