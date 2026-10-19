// Machines (#/machines): every machine the hub knows, online or not, with when it was last seen, a recent sleep,
// what it runs and its usage, the slot board, and each machine's projects (open, or remove).

import { MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Dot, IdChip, Menu, MenuContent, MenuItem, MenuTrigger, Text, Truncate } from "../../ui";
import type { Machine, ProjectSummary } from "./contracts";
import { useFleet } from "./fleet";
import { machineOrder, machineParts, slotsText, type Tone } from "./machineText";
import { RemoveProjectDialog, type RemoveTarget } from "./RemoveProjectDialog";
import { tilde } from "./source";
import { openAddProject, openProject } from "./store";
import s from "./projects.module.css";

const TONE: Record<Tone, "quiet" | "warning" | "danger"> = { quiet: "quiet", warning: "warning", danger: "danger" };
const STATUS_DOT: Record<Machine["status"], string> = { online: "var(--success)", degraded: "var(--warning)", offline: "var(--faint)" };

/** "Last seen" and "slept" are minutes-grained: one re-render a minute, not a ticking clock. */
const useMinute = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

export function MachinesScreen() {
  const fleet = useFleet();
  const now = useMinute() + fleet.skewMs;
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);

  // Load and usage come in live frames: ask for the board's (what the board itself asks for).
  useEffect(() => {
    void window.fleetd.hub.live({ board: true });
  }, []);

  const machines = [...fleet.machines].sort(machineOrder);
  const state = !fleet.synced ? "machines.loading" : machines.length === 0 ? "machines.empty" : undefined;

  return (
    <div className={s.page} data-screen="machines">
      <div className={s.pageHead} {...(state ? { "data-screen": state } : {})}>
        <Text as="h1" size="xl" strong className={s.pageTitle ?? ""}>
          Machines
        </Text>
        {fleet.slots ? (
          <Text size="sm" tone="quiet" tabular>
            {slotsText(fleet.slots)}
          </Text>
        ) : null}
        <Button onClick={() => openAddProject()}>Add project…</Button>
      </div>
      {!fleet.synced ? (
        <Text tone="quiet">{fleet.live ? "Loading machines…" : "Waiting for the hub. Machines show once it's connected."}</Text>
      ) : machines.length === 0 ? (
        <div className={s.empty}>
          <Text strong>No machines yet.</Text>
          <Text tone="quiet">{"On the hub, run fleetd machine add with the machine's SSH host (or --local for the hub itself). It shows here once its node connects."}</Text>
        </div>
      ) : (
        <div className={s.cards}>
          {machines.map((m) => (
            <MachineCard
              key={m.machineId}
              machine={m}
              projects={fleet.projects.filter((p) => p.machineId === m.machineId)}
              now={now}
              live={fleet.machineLive.get(m.machineId)}
              onRemove={setRemoving}
            />
          ))}
        </div>
      )}
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function MachineCard(props: {
  machine: Machine;
  projects: ReadonlyArray<ProjectSummary>;
  now: number;
  live: Parameters<typeof machineParts>[1];
  onRemove: (p: RemoveTarget) => void;
}) {
  const { machine: m } = props;
  const parts = machineParts(m, props.live, props.now);
  return (
    <section className={s.card} aria-label={m.name}>
      <div className={s.cardHead}>
        <span className={s.cardName}>
          <Dot color={STATUS_DOT[m.status]} label={m.status} />
          <IdChip label={m.name} id={m.machineId} kind="machine" strong />
        </span>
        {m.status === "online" && parts.length === 0 ? <Text size="sm" tone="quiet">online</Text> : null}
        <span className={s.parts}>
          {parts.map((p) => (
            <Text key={p.text} size="sm" tone={TONE[p.tone]} tabular>
              {p.text}
            </Text>
          ))}
        </span>
        <Text size="xs" tone="faint">
          {`node ${m.nodeVersion}${m.tags.length > 0 ? ` · ${m.tags.join(", ")}` : ""}`}
        </Text>
      </div>
      {m.status === "degraded" && m.degradedReason ? (
        <Text size="sm" tone="warning">
          {m.degradedReason}
        </Text>
      ) : null}
      {props.projects.length > 0 ? (
        <div className={s.projects} role="list" aria-label={`Projects on ${m.name}`}>
          {props.projects.map((p) => (
            <ProjectRow key={p.projectId} project={p} onRemove={props.onRemove} />
          ))}
        </div>
      ) : (
        <Text size="sm" tone="quiet">
          No projects here yet.
        </Text>
      )}
    </section>
  );
}

function ProjectRow({ project: p, onRemove }: { project: ProjectSummary; onRemove: (p: RemoveTarget) => void }) {
  const running = p.threads.running + p.threads.waiting;
  return (
    <div className={s.project} role="listitem">
      <Truncate>{p.title}</Truncate>
      <Truncate size="sm" tone="quiet" mono>
        {tilde(p.workspaceRoot)}
      </Truncate>
      <Text size="sm" tone="quiet" tabular>
        {running > 0 ? `${running} running` : "idle"}
      </Text>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="quiet" iconOnly aria-label={`${p.title} actions`}>
            <MoreHorizontal />
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={() => openProject(p.machineId, p.projectId)}>Open</MenuItem>
          <MenuItem danger onSelect={() => onRemove({ machineId: p.machineId, projectId: p.projectId, title: p.title, path: p.workspaceRoot })}>
            Remove project…
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
