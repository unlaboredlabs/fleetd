// Hub › Machines › Screens (W268): which kinds of screen each machine that hosts screens opens, a switch each, how long
// an idle one lasts there, and how long the hub keeps recordings. A switch is a machine_screens_set call: the machine's
// node writes its node.json, so turning Android or iOS on installs what it needs, and the line under the switch follows
// what the node says (installing, starting once its live screens end). Retention is browser_retention_set, for every
// project. Hub-wide, so only owners and admins see it; the hub's answer reads the machines again.
import { useState } from "react";
import type { HostCheck, MachineRolesEntry, SessionHost } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Select, Switch, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { daysChoices, gbChoices, idleChoices, idleOf, lockedWhy, SCREEN_KINDS, stateLine, switchOn } from "./screensModel";
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

export function Screens() {
  const live = useLive();
  const read = useToolQuery("machine_roles", noInput);
  const machines = read.data?.machines.filter((m) => m.roles.includes("sessions"));
  if (!live) return <Text tone="quiet">Connect to a hub to see and change this.</Text>;
  if (read.error) return <Text tone="danger">{`Couldn't read the machines: ${errorText(read.error)}`}</Text>;
  if (machines === undefined) return <Text tone="quiet">Loading…</Text>;
  return (
    <div className={s.machineList}>
      {machines.length === 0 ? <Text tone="quiet">No machine hosts screens: set one&apos;s role to Screens or Both above.</Text> : machines.map((m) => <ScreensRow key={m.machineId} machine={m} />)}
      {read.data?.retention === undefined ? null : <Retention days={read.data.retention.retentionDays} gb={read.data.retention.maxGbPerProject} />}
    </div>
  );
}

function ScreensRow({ machine: m }: { machine: MachineRolesEntry }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const id = `screens-${m.machineId}`;
  const set = (input: { host: SessionHost; on: boolean } | { idleMinutes: number }) => {
    setBusy(true);
    setEcho(null);
    call("machine_screens_set", { machineId: m.machineId, ...input })
      .then(
        (out) => setEcho(out.next === undefined ? null : { ok: true, text: out.next }),
        (e: unknown) => setEcho({ ok: false, text: `Not changed: ${errorText(e)}` }),
      )
      .finally(() => {
        setBusy(false);
        refetch(["machine_roles"]);
      });
  };
  const check = (host: SessionHost): HostCheck | undefined => (m.hosts ?? []).find((h) => h.host === host);
  const idle = idleOf(m);
  const old = m.online && m.screenSettings !== true;
  return (
    <section className={s.machineRow} aria-labelledby={`${id}-name`} data-screens={m.machineId}>
      <div className={s.agentsHead}>
        <Text strong id={`${id}-name`}>
          {m.name}
        </Text>
        <Text size="xs" tone="quiet">
          {m.online ? "online" : "offline"}
        </Text>
      </div>
      <div className={s.screenKinds}>
        {SCREEN_KINDS.map(({ host, label }) => {
          const c = check(host);
          const locked = lockedWhy(m, c);
          return (
            <Switch
              key={host}
              label={label}
              description={stateLine(c)}
              checked={switchOn(c)}
              disabled={!live || busy || locked !== null}
              onCheckedChange={(on) => set({ host, on })}
              aria-label={`${label} screens on ${m.name}`}
            />
          );
        })}
      </div>
      <div className={s.inline}>
        <Text size="xs">Idle screens end after</Text>
        <Select
          aria-label={`Idle timeout on ${m.name}`}
          className={s.machineCap}
          value={idle === undefined ? undefined : String(idle)}
          options={idleChoices(idle)}
          disabled={!live || busy || lockedWhy(m, check("browser")) !== null || idle === undefined}
          onValueChange={(v) => set({ idleMinutes: Number(v) })}
        />
      </div>
      {old ? (
        <Text size="xs" tone="quiet">
          Its fleetd is too old to change these from here: update it under Updates below.
        </Text>
      ) : null}
      <EchoLine echo={echo} />
    </section>
  );
}

/** How long the hub keeps every project's recordings, and how much of them. */
function Retention({ days, gb }: { days: number; gb: number }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo>(null);
  const set = (retentionDays: number, maxGbPerProject: number) => {
    setBusy(true);
    setEcho(null);
    call("browser_retention_set", { retentionDays, maxGbPerProject })
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
    <section className={s.machineRow} aria-label="Recordings" data-screens-retention>
      <Text strong>Recordings</Text>
      <div className={s.inline}>
        <Text size="xs">Keep each screen&apos;s recording for</Text>
        <Select aria-label="Keep recordings for" className={s.machineCap} value={String(days)} options={daysChoices(days)} disabled={!live || busy} onValueChange={(v) => set(Number(v), gb)} />
      </div>
      <div className={s.inline}>
        <Text size="xs">At most, per project</Text>
        <Select aria-label="Recordings per project, at most" className={s.machineCap} value={String(gb)} options={gbChoices(gb)} disabled={!live || busy} onValueChange={(v) => set(days, Number(v))} />
        <Text size="xs" tone="quiet">
          Its oldest go first.
        </Text>
      </div>
      <EchoLine echo={echo} />
    </section>
  );
}
