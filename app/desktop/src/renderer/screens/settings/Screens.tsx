// A machine's screens, on its page in Hub › Machines (admin/MachinePage.tsx, W268): which kinds of screen it opens, a
// switch each, and how many it hosts at once; and, on Hub › Machines, how long the hub keeps recordings. A switch is a
// machine_screens_set call: the machine's node writes its node.json, so turning Android on installs what it needs, and
// the line under the switch follows what the node says (installing, starting once its live screens end). A kind that
// can't run for something missing shows the command that fixes it, to run on that machine. The at-once limit is
// machine_roles_set. An idle screen ends after the node's timeout (30 minutes unless node.json says otherwise; the
// agents' Mac's own screen, 5), said in a line. Retention is browser_retention_set, for every project: the app sets
// only the days, and the hub keeps its size limit as a safety net. Hub-wide, so only owners and admins see it.
import { useState, type ReactNode } from "react";
import type { HostCheck, MachineRolesEntry, SessionHost, ToolInput } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Button, Select, Text, Toggle } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { CommandLine } from "../onboarding/Prose";
import { RunOn } from "../setup/Guide";
import { navigate } from "../shell/navigation";
import { GroupNote, SettingsRow } from "./parts";
import { capChoices, hostsNote, sessionsLine } from "./machinesModel";
import { daysChoices, fixOf, idleLine, kindsOf, lockedWhy, nodeWait, stateLine, switchOn } from "./screensModel";
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

type MachineTool = "machine_roles_set" | "machine_screens_set";
type Change<T extends MachineTool> = ToolInput<T> extends infer I ? (I extends unknown ? Omit<I, "machineId"> : never) : never;

/**
 * One machine's change, as its role and its screens make them: the call, the hub's line about it (or why not) under
 * the controls, and the machines read again once it answers.
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
 * A machine's screens, rows of its section: a switch per kind it may open with what each needs, how many at once, and
 * when an idle one ends.
 */
export function MachineScreens({ machine: m }: { machine: MachineRolesEntry }) {
  const kind = useMachineSet("machine_screens_set", m.machineId);
  const cap = useMachineSet("machine_roles_set", m.machineId);
  const check = (host: SessionHost): HostCheck | undefined => (m.hosts ?? []).find((h) => h.host === host);
  const kinds = kindsOf(m);
  const wait = nodeWait(m);
  const note = hostsNote(m);
  return (
    <div data-screens={m.machineId}>
      {kinds.map(({ host, label }) => {
        const c = check(host);
        const locked = lockedWhy(m, c);
        const fix = fixOf(m, c);
        return (
          <SettingsRow
            key={host}
            title={label}
            // Offline is the one reason a switch can't move that its line doesn't already say (the rest are below).
            line={m.online ? stateLine(c) : `${stateLine(c)}. ${m.name} is offline: it changes once it's back.`}
            control={<Toggle checked={switchOn(c)} disabled={kind.disabled || locked !== null} onCheckedChange={(on) => kind.set({ host, on })} aria-label={`${label} screens on ${m.name}`} />}
          >
            {fix === null ? null : <RunOn where={`${m.name}, for ${label}`} command={fix} />}
          </SettingsRow>
        );
      })}
      {wait === "restarting" ? <GroupNote>{`${m.name}'s node is restarting: these come back once it links again.`}</GroupNote> : null}
      {wait === "old" ? (
        <SettingsRow
          title={`Update ${m.name}'s fleetd to change these.`}
          control={
            <Button size="sm" variant="quiet" onClick={() => navigate({ id: "settings", tab: "hub.updates" })}>
              Open Updates
            </Button>
          }
        >
          {m.nodeRestart === undefined ? null : (
            <>
              <Text size="sm" tone="quiet">
                {`Still the same after updating? Run this on ${m.name}:`}
              </Text>
              <CommandLine command={m.nodeRestart} />
            </>
          )}
        </SettingsRow>
      ) : null}
      {kind.echo}
      <SettingsRow
        title="At once"
        line={sessionsLine(m)}
        control={
          <Select
            aria-label={`Most screens ${m.name} hosts at once`}
            className={s.machineCap}
            value={m.maxSessionsSet === undefined ? "auto" : String(m.maxSessionsSet)}
            options={capChoices(m)}
            disabled={cap.disabled}
            onValueChange={(v) => cap.set(v === "auto" ? { autoSessions: true } : { maxSessions: Number(v) })}
          />
        }
      >
        {note === null ? null : (
          <Text size="sm" tone="quiet">
            {note}
          </Text>
        )}
      </SettingsRow>
      {cap.echo}
      <GroupNote>{idleLine(m)}</GroupNote>
    </div>
  );
}

/** How long the hub keeps every project's recordings. */
export function Recordings() {
  const live = useLive();
  const read = useToolQuery("machine_roles", noInput);
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const retention = read.data?.retention;
  if (!live) return <GroupNote>Connect to a hub to see and change this.</GroupNote>;
  if (read.error) return <GroupNote tone="danger">{`Couldn't read it: ${errorText(read.error)}`}</GroupNote>;
  if (read.data === undefined) return <GroupNote>Loading…</GroupNote>;
  if (retention === undefined) return <GroupNote>Update the hub&apos;s fleetd to change this here.</GroupNote>;
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
        title="Keep screen recordings for"
        data={{ "data-screens-retention": "" }}
        control={<Select aria-label="Keep recordings for" className={s.machineCap} value={String(retention.retentionDays)} options={daysChoices(retention.retentionDays)} disabled={busy} onValueChange={(v) => set(Number(v))} />}
      />
      <EchoLine echo={echo} />
    </>
  );
}
