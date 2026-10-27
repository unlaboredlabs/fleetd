// Administration's machine roles: what each machine is for (agents, sessions or both), how many browser and device
// sessions it hosts at once, and what it can host, each in plain words as its node reported it. Hub-wide, so it lives on
// Administration, not in Settings. Reads machine_roles; a change is a machine_roles_set call (an admin's), and the hub's
// answer replaces the row.
import { useState } from "react";
import type { MachineRolesEntry } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Segmented, Select, Text } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { capChoices, choiceOf, hostName, hostsInOrder, hostsNote, ROLE_CHOICES, ROLE_HELP, rolesOf, sessionsLine, type RolesChoice } from "./machinesModel";
import s from "./settings.module.css";

const noInput = {};

export function MachineRoles() {
  const live = useLive();
  const read = useToolQuery("machine_roles", noInput);
  const machines = read.data?.machines;
  return (
    <section className={s.machineList} aria-labelledby="machine-roles">
      <div className={s.settingLabel}>
        <Text strong id="machine-roles">
          Machine roles
        </Text>
        <Text size="xs" tone="quiet">
          What each machine is for. A browser or device session an agent starts runs on its own machine when it can host it, else on another that can, through the hub.
        </Text>
      </div>
      {!live ? (
        <Text tone="quiet">Connect to a hub to see and change this.</Text>
      ) : read.error ? (
        <Text tone="danger">{`Couldn't read the machines: ${errorText(read.error)}`}</Text>
      ) : machines === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : machines.length === 0 ? (
        <Text tone="quiet">No machine has joined yet.</Text>
      ) : (
        machines.map((m) => <MachineRow key={m.machineId} machine={m} />)
      )}
    </section>
  );
}

function MachineRow({ machine: m }: { machine: MachineRolesEntry }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const choice = choiceOf(m.roles);
  const id = `machine-${m.machineId}`;

  const set = (input: { roles?: RolesChoice; cap?: string }) => {
    setBusy(true);
    setEcho(null);
    const cap = input.cap === undefined ? {} : input.cap === "auto" ? { autoSessions: true } : { maxSessions: Number(input.cap) };
    call("machine_roles_set", { machineId: m.machineId, ...(input.roles === undefined ? {} : { roles: rolesOf(input.roles) }), ...cap })
      .then(
        (out) => setEcho(out.next === undefined ? null : { ok: true, text: out.next }),
        (e: unknown) => setEcho({ ok: false, text: `Not changed: ${errorText(e)}` }),
      )
      .finally(() => {
        setBusy(false);
        refetch(["machine_roles"]);
      });
  };

  const disabled = !live || busy;
  const note = hostsNote(m);
  return (
    <section className={s.machineRow} aria-labelledby={`${id}-name`}>
      <div className={s.agentsHead}>
        <Text strong id={`${id}-name`}>
          {m.name}
        </Text>
        <Text size="xs" tone="quiet">
          {m.online ? "online" : "offline"}
        </Text>
      </div>
      <div className={s.machineControls}>
        <Segmented label={`What ${m.name} is for`} options={ROLE_CHOICES} value={choice} disabled={disabled} onChange={(roles) => roles !== choice && set({ roles })} />
        <Text size="xs" tone="quiet">
          {ROLE_HELP[choice]}
        </Text>
      </div>
      {m.roles.includes("sessions") ? (
        <div className={s.machineControls}>
          <div className={s.inline}>
            <Text size="xs" tabular>
              {sessionsLine(m)}
            </Text>
            <Select
              aria-label={`Most screens ${m.name} hosts at once`}
              className={s.machineCap}
              value={m.maxSessionsSet === undefined ? "auto" : String(m.maxSessionsSet)}
              options={capChoices(m)}
              disabled={disabled}
              onValueChange={(cap) => set({ cap })}
            />
          </div>
          <ul className={s.machineHosts} aria-label={`What ${m.name} can host`}>
            {hostsInOrder(m.hosts ?? []).map((h) => (
              <li key={h.host}>
                <Text size="xs" strong={h.ready} tone={h.ready ? "default" : "quiet"}>
                  {hostName(h.host)}
                </Text>
                <Text size="xs" tone={h.ready ? "default" : "quiet"}>
                  {h.ready ? "can host" : "can't host"}
                </Text>
                <Text size="xs" tone="quiet">
                  {h.detail}
                </Text>
              </li>
            ))}
          </ul>
          {note === null ? null : (
            <Text size="xs" tone="quiet">
              {note}
            </Text>
          )}
        </div>
      ) : null}
      {echo === null ? null : echo.ok ? (
        <Text size="xs" tone="quiet">
          {echo.text}
        </Text>
      ) : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">
            {echo.text}
          </Text>
        </p>
      )}
    </section>
  );
}
