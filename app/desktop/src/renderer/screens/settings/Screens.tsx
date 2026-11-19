// A machine's screens, on its page in Hub › Machines (admin/MachinePage.tsx, W268): how many it hosts at once, and,
// only when a kind it could run needs someone, what stands in the way with the command that fixes it, to run on that
// machine. There is no switch per kind (D574): a Linux machine hosts every Linux kind it can run, the agents' Mac its
// own screen, and the hub places a kind a machine can't run elsewhere. The at-once limit is machine_roles_set. An idle
// screen ends after the node's timeout (30 minutes; the agents' Mac's own screen, 5), said in a line. On Hub ›
// Machines, how long the hub keeps recordings: browser_retention_set, for every bot: the app sets only the days, and
// the hub keeps its size limit as a safety net. Hub-wide, so only owners and admins see it.
import { useState, type ReactNode } from "react";
import type { MachineRolesEntry, ToolInput } from "../../../shared/contracts";
import { useHub, useToolQuery } from "../../src/data/react";
import { useServes } from "../admin/role";
import { Select, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { RunOn } from "../setup/Guide";
import { GroupNote, SettingsRow } from "./parts";
import { capChoices, hostsNote, sessionsWhy } from "./machinesModel";
import { daysChoices, idleLine, needsLines } from "./screensModel";
import s from "./settings.module.css";

const noInput = {};

type Echo = { readonly ok: boolean; readonly text: string } | null;

/** What a change did next, or why it didn't, as a note in its group. */
function EchoLine({ echo }: { echo: Echo }) {
  if (echo === null) return null;
  return (
    <GroupNote tone={echo.ok ? "quiet" : "danger"}>
      <span role={echo.ok ? "status" : "alert"}>{echo.text}</span>
    </GroupNote>
  );
}

type MachineTool = "machine_roles_set";
type Change<T extends MachineTool> = Omit<ToolInput<T>, "machineId">;

/**
 * One machine's change, as its role and its screen cap make them: the call, the hub's line about it (or why not)
 * under the controls, and the machines read again once it answers.
 */
export function useMachineSet<T extends MachineTool>(tool: T, machineId: string): { set: (change: Change<T>) => void; disabled: boolean; echo: ReactNode } {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const set = (change: Change<T>) => {
    setBusy(true);
    setEcho(null);
    call(tool, { machineId, ...change })
      .then(
        (out) => setEcho(out.next === undefined ? null : { ok: true, text: out.next }),
        (e: unknown) => setEcho({ ok: false, text: `Not changed: ${errorText(e)}` }),
      )
      .finally(() => {
        setBusy(false);
        refetch(["machine_roles"]);
      });
  };
  return { set, disabled: !live || busy, echo: <EchoLine echo={echo} /> };
}

/**
 * A machine's screens, rows of its section: a line for each kind that needs someone, with its fix, then how many at
 * once and when an idle one ends.
 */
export function MachineScreens({ machine: m }: { machine: MachineRolesEntry }) {
  const cap = useMachineSet("machine_roles_set", m.machineId);
  const note = hostsNote(m);
  return (
    <div data-screens={m.machineId}>
      {needsLines(m).map(({ host, label, line, fix }) => (
        <SettingsRow key={host} title={label} line={line} lineTone="quiet" data={{ "data-screens-needs": host }}>
          {fix === null ? null : <RunOn where={`${m.name}, for ${label}`} command={fix} />}
        </SettingsRow>
      ))}
      <SettingsRow
        title="At once"
        hint={`The most screens it hosts at once (${sessionsWhy(m)}). ${idleLine(m)}`}
        control={
          <>
            <Text tone="quiet" tabular>{`${m.sessionsLive} open`}</Text>
            <Select
              aria-label={`Most screens ${m.name} hosts at once`}
              className={s.machineCap}
              value={m.maxSessionsSet === undefined ? "auto" : String(m.maxSessionsSet)}
              options={capChoices(m)}
              disabled={cap.disabled}
              onValueChange={(v) => cap.set(v === "auto" ? { autoSessions: true } : { maxSessions: Number(v) })}
            />
          </>
        }
      >
        {note === null ? null : (
          <Text size="sm" tone="quiet">
            {note}
          </Text>
        )}
      </SettingsRow>
      {cap.echo}
    </div>
  );
}

/** How long the hub keeps every bot's recordings. */
export function Recordings() {
  const live = useLive();
  const read = useToolQuery("machine_roles", noInput);
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  // Only a hub updated from here is told to update: fleetd cloud updates itself (it leaves hub_update out).
  const servesUpdate = useServes("hub_update");
  const cloud = useHub().cloud === true;
  const updatable = servesUpdate && !cloud;
  const retention = read.data?.retention;
  if (!live) return <GroupNote>Connect to a hub to see and change this.</GroupNote>;
  if (read.error) return <GroupNote tone="danger">{`Couldn't read it: ${errorText(read.error)}`}</GroupNote>;
  if (read.data === undefined) return <GroupNote>Loading…</GroupNote>;
  // A hub from before retention was in machine_roles.
  if (retention === undefined) return updatable ? <GroupNote>Update the hub&apos;s fleetd to change this here.</GroupNote> : null;
  const set = (retentionDays: number) => {
    setBusy(true);
    setEcho(null);
    // The size limit stays as the hub has it: a safety net, not a choice here.
    call("browser_retention_set", { retentionDays, maxGbPerProject: retention.maxGbPerProject })
      .then(
        (out) => setEcho(out.next === undefined ? null : { ok: true, text: out.next }),
        (e: unknown) => setEcho({ ok: false, text: `Not changed: ${errorText(e)}` }),
      )
      .finally(() => {
        setBusy(false);
        refetch(["machine_roles", "browser_sessions"]);
      });
  };
  return (
    <>
      <SettingsRow
        reveal="hub.recordings"
        mark="none"
        title="Keep screen recordings for"
        data={{ "data-screens-retention": "" }}
        control={<Select aria-label="Keep recordings for" className={s.machineCap} value={String(retention.retentionDays)} options={daysChoices(retention.retentionDays)} disabled={busy} onValueChange={(v) => set(Number(v))} />}
      />
      <EchoLine echo={echo} />
    </>
  );
}
