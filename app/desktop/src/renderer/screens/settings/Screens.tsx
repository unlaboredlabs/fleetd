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
import { Button, Select, Switch, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { CommandLine } from "../onboarding/Prose";
import { RunOn } from "../setup/Guide";
import { navigate } from "../shell/navigation";
import { capChoices, hostsNote, sessionsLine } from "./machinesModel";
import { daysChoices, fixOf, idleLine, kindsOf, lockedWhy, nodeWait, stateLine, switchOn } from "./screensModel";
import s from "./settings.module.css";

const noInput = {};

type Echo = { readonly ok: boolean; readonly text: string } | null;

function EchoLine({ echo }: { echo: Echo }) {
  if (echo === null) return null;
  return echo.ok ? (
    <Text size="xs" tone="quiet">
      {echo.text}
    </Text>
  ) : (
    <p role="alert" className={s.alertLine}>
      <Text size="xs" tone="danger">
        {echo.text}
      </Text>
    </p>
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

/** A machine's screens: a switch per kind it may open, what each needs, how many at once, and when an idle one ends. */
export function MachineScreens({ machine: m }: { machine: MachineRolesEntry }) {
  const kind = useMachineSet("machine_screens_set", m.machineId);
  const cap = useMachineSet("machine_roles_set", m.machineId);
  const check = (host: SessionHost): HostCheck | undefined => (m.hosts ?? []).find((h) => h.host === host);
  const kinds = kindsOf(m);
  const wait = nodeWait(m);
  const note = hostsNote(m);
  return (
    <div className={s.machineControls} data-screens={m.machineId}>
      <div className={s.screenKinds}>
        {kinds.map(({ host, label }) => {
          const c = check(host);
          const locked = lockedWhy(m, c);
          return (
            <Switch
              key={host}
              label={label}
              description={stateLine(c)}
              checked={switchOn(c)}
              disabled={kind.disabled || locked !== null}
              onCheckedChange={(on) => kind.set({ host, on })}
              aria-label={`${label} screens on ${m.name}`}
            />
          );
        })}
      </div>
      {kinds.map(({ host, label }) => {
        const fix = fixOf(m, check(host));
        return fix === null ? null : <RunOn key={host} where={`${m.name}, for ${label}`} command={fix} />;
      })}
      {wait === "restarting" ? (
        <Text size="xs" tone="quiet">
          {`${m.name}'s node is restarting: these come back once it links again.`}
        </Text>
      ) : null}
      {wait === "old" ? (
        <>
          <div className={s.inline}>
            <Text size="xs" tone="quiet">
              {`Update ${m.name}'s fleetd to change these.`}
            </Text>
            <Button size="sm" variant="quiet" onClick={() => navigate({ id: "settings", tab: "hub.updates" })}>
              Open Updates
            </Button>
          </div>
          {m.nodeRestart === undefined ? null : (
            <>
              <Text size="xs" tone="quiet">
                {`Still the same after updating? Run this on ${m.name}:`}
              </Text>
              <CommandLine command={m.nodeRestart} />
            </>
          )}
        </>
      ) : null}
      {kind.echo}
      <div className={s.inline}>
        <Text size="xs" tabular>
          {sessionsLine(m)}
        </Text>
        <Select
          aria-label={`Most screens ${m.name} hosts at once`}
          className={s.machineCap}
          value={m.maxSessionsSet === undefined ? "auto" : String(m.maxSessionsSet)}
          options={capChoices(m)}
          disabled={cap.disabled}
          onValueChange={(v) => cap.set(v === "auto" ? { autoSessions: true } : { maxSessions: Number(v) })}
        />
      </div>
      {note === null ? null : (
        <Text size="xs" tone="quiet">
          {note}
        </Text>
      )}
      {cap.echo}
      <Text size="xs" tone="quiet">
        {idleLine(m)}
      </Text>
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
  if (!live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  if (read.error) return <Text tone="danger">{`Couldn't read it: ${errorText(read.error)}`}</Text>;
  if (read.data === undefined) return <Text tone="quiet">Loading…</Text>;
  if (retention === undefined) return <Text tone="quiet">Update the hub&apos;s fleetd to change this here.</Text>;
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
    <div className={s.stack} data-screens-retention>
      <div className={s.inline}>
        <Text size="sm">Keep screen recordings for</Text>
        <Select aria-label="Keep recordings for" className={s.machineCap} value={String(retention.retentionDays)} options={daysChoices(retention.retentionDays)} disabled={busy} onValueChange={(v) => set(Number(v))} />
      </div>
      <EchoLine echo={echo} />
    </div>
  );
}
