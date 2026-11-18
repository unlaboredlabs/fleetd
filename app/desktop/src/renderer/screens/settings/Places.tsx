// Hub › Machines' providers and what runs where, each a group in the one model of the page. Providers: every provider
// the team connects with its own key, one list (Providers.tsx), each with what it can run. What runs where: a row per
// kind (agents, then each kind of screen), each the same pattern: your machines, your machines first then a provider,
// or a provider only, offering only providers connected that can run the kind (providersModel). Agents' row is the
// order the hub keeps (the machines, then each connected provider with room, once the machines' own limit is reached),
// which each provider's limit sets; the phones' rows are Revyl's routes; a kind no connected provider runs is its
// machines, a plain value, or None yet with how to add one in its hover. Then how long recordings are kept.
import type { ReactNode } from "react";
import type { SlotState } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Text } from "../../ui";
import { fleetCapLine } from "./agentsModel";
import { useLive } from "./hub";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
import { useProviderRows } from "./Providers";
import { agentsWhere, CAPABILITY_WORDS, KINDS, machinesRun, NONE, noneHow, specOf, YOURS, type Capability } from "../../../shared/providers";
import { RouteRow } from "./Revyl";
import { routeChosen } from "./revylModel";
import { notPlacingLine, SECTION_HINT } from "./sandboxModel";
import { Recordings } from "./Screens";

const noInput = {};

/** The hub's slot state for this connection; undefined until it is fresh. */
const useSlots = (): SlotState | undefined => useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));

/** Providers: every one, in the order agents go to the connected ones; nothing on a hub with none (fleetd cloud). */
export function ProvidersGroup() {
  const live = useLive();
  const read = useToolQuery("sandbox_get", noInput, { enabled: live });
  const rows = useProviderRows(KINDS);
  if (rows === null) return null;
  return (
    <SettingsSection title="Providers" reveal="hub.sandboxes" hint={SECTION_HINT} data={{ "data-sandboxes": "" }}>
      {read.data === undefined || read.data.placing ? null : <GroupNote>{notPlacingLine(read.data)}</GroupNote>}
      {rows}
    </SettingsSection>
  );
}

const WHERE_HINT =
  "Agents run on your machines first; once those are full, on the connected providers in order, up to each one's limit. " +
  "Each kind of screen runs where its row says.";

/** What runs where: a row per kind, then recordings. */
export function WhatRunsWhere() {
  const live = useLive();
  const machines = useToolQuery("machine_roles", noInput).data?.machines;
  const sandboxes = useToolQuery("sandbox_get", noInput, { enabled: live }).data;
  const revyl = useToolQuery("revyl_get", noInput, { enabled: live }).data;
  const slots = useSlots();
  const team = useData((d) => d.machines);
  const held = slots === undefined ? null : fleetCapLine(slots);
  const row = (kind: Capability): ReactNode => {
    const label = CAPABILITY_WORDS[kind];
    if (kind === "agents") {
      // The hub's runner for hosted sandboxes is no machine of the team's.
      const computers = machines === undefined || machinesRun(kind, machines.filter((m) => team[m.machineId]?.runner !== true));
      const where = agentsWhere(sandboxes?.providers ?? [], computers);
      const hint = where === NONE ? noneHow[kind] : undefined;
      return <Plain key={kind} kind={kind} label={label} value={where} hint={hint} line={held === null ? null : <span data-fleet-cap="">{held}</span>} />;
    }
    // A phone kind Revyl runs: its route, while Revyl is connected or the route still names it.
    if (revyl !== undefined && (kind === "ios" || kind === "android") && specOf("revyl").can.includes(kind) && routeChosen(revyl.connected, revyl.routes[kind])) {
      return <RouteRow key={kind} kind={kind} label={label} state={revyl} />;
    }
    const ours = machines === undefined || machinesRun(kind, machines);
    return <Plain key={kind} kind={kind} label={label} value={ours ? YOURS : NONE} hint={ours ? undefined : noneHow[kind]} />;
  };
  return (
    <SettingsSection title="What runs where" reveal="hub.where" hint={WHERE_HINT} data={{ "data-where": "" }}>
      {KINDS.map(row)}
      <Recordings />
    </SettingsSection>
  );
}

/** A kind with nothing to choose: where it runs, as a value. */
function Plain(props: { kind: Capability; label: string; value: string; hint?: string | undefined; line?: ReactNode }) {
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
