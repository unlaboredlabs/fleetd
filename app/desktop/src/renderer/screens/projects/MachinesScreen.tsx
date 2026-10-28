// Machines (#/machines): every machine the hub knows, online or not, one row each: its state, what it runs and what
// wants a look (a recent sleep, usage near its limit, a failing check). Opening a row shows the rest: load, memory,
// its node's version and tags, its projects (open, their settings, or remove) and the way to its roles. Then the
// slot board in the title and the setup checks.

import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData } from "../../src/data/react";
import { selectMachines, selectProjects } from "../../src/data/selectors";
import { Button, FrameTitle, IdChip, Menu, MenuContent, MenuItem, MenuTrigger, Text, Truncate, cx } from "../../ui";
import type { Machine, MachineLive, ProjectSummary } from "./contracts";
import { machineGlance, machineOrder, slotsText, type Tone } from "./machineText";
import { RemoveProjectDialog, type RemoveTarget } from "./RemoveProjectDialog";
import { SetupChecks, useChecks, wantsLook } from "./SetupChecks";
import { HubText } from "./HubText";
import { toHash } from "../shell/routes";
import { useAdministers } from "../admin/role";
import { tilde } from "./source";
import { openAddProject, openProject } from "./store";
import s from "./projects.module.css";

const TONE: Record<Tone, "quiet" | "warning" | "danger"> = { quiet: "quiet", warning: "warning", danger: "danger" };

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
  const views = useData(selectMachines);
  const projects = useData(selectProjects);
  // Like the machines: nothing from a connection that is gone, so no old slot count beside "Waiting for the hub".
  const slots = useData((d) => (d.fresh ? (d.live.slots ?? d.slots) : undefined));
  const live = useData((d) => d.hub.phase === "live");
  const now = useMinute() + (useData((d) => d.live.skewMs) ?? 0);
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const checks = useChecks().data?.checks;
  const admin = useAdministers();
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Undefined until the layer has a fresh snapshot: a skeleton, never cached data shown as live.
  const machines = useMemo(() => (views === undefined ? undefined : [...views].sort((a, b) => machineOrder(a.machine, b.machine))), [views]);
  const state = machines === undefined ? "machines.loading" : machines.length === 0 ? "machines.empty" : undefined;

  return (
    // The frame doesn't scroll its screens; this one scrolls itself once the checks make it taller than the window.
    <div className={s.scroller} data-screen="machines">
      <div className={s.page} {...(state ? { "data-screen": state } : {})}>
      <FrameTitle title="Machines" detail={slots ? slotsText(slots) : undefined}>
        <Button onClick={() => openAddProject()}>Add project…</Button>
      </FrameTitle>
      {machines === undefined ? (
        <Text tone="quiet">
          {live ? "Loading machines…" : "Waiting for the hub. Machines show once it's connected."}
        </Text>
      ) : machines.length === 0 ? (
        <div className={s.empty}>
          <Text strong>No machines yet.</Text>
          <Text tone="quiet">{"On the hub, run fleetd machine add with the machine's SSH host (or --local for the hub itself). It shows here once its node connects."}</Text>
        </div>
      ) : (
        <div className={s.machineList}>
          {machines.map(({ machine, live: load }) => (
            <MachineRow
              key={machine.machineId}
              machine={machine}
              projects={(projects ?? []).filter((p) => p.machineId === machine.machineId)}
              failing={(checks ?? []).filter((c) => c.machineId === machine.machineId && wantsLook(c)).length}
              now={now}
              live={load}
              open={open.has(machine.machineId)}
              onToggle={() => toggle(machine.machineId)}
              onRemove={setRemoving}
              admin={admin}
            />
          ))}
        </div>
      )}
      {machines !== undefined ? <SetupChecks now={now} /> : null}
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
      </div>
    </div>
  );
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function MachineRow(props: {
  machine: Machine;
  projects: ReadonlyArray<ProjectSummary>;
  /** Its setup checks that failed or warned. */
  failing: number;
  now: number;
  live: MachineLive | undefined;
  open: boolean;
  onToggle: () => void;
  onRemove: (p: RemoveTarget) => void;
  /** An owner or admin: the way to the machine's roles in Settings › Hub › Machines. */
  admin: boolean;
}) {
  const { machine: m, open } = props;
  const glance = machineGlance(m, props.live, props.now);
  const runs = [glance.running, props.projects.length > 0 ? count(props.projects.length, "project", "projects") : "no projects"].filter(Boolean).join(" · ");
  const detailId = `machine-${m.machineId}`;
  return (
    <section className={s.machine} aria-label={m.name} data-open={open || undefined}>
      {/* The chevron is the control; a click anywhere else on the line opens it too. */}
      <div className={s.machineHead} onClick={props.onToggle}>
        <button
          type="button"
          className={s.toggle}
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${m.name} details`}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
        >
          <ChevronRight aria-hidden className={cx(s.chevron, open && s.chevronOpen)} />
        </button>
        <IdChip label={m.name} id={m.machineId} kind="machine" inRow strong={m.status !== "offline"} tone={m.status === "offline" ? "quiet" : "default"} />
        <span className={s.glance}>
          <Text size="sm" tone={TONE[glance.state.tone]} tabular>
            {glance.state.text}
          </Text>
          <Text size="sm" tone="quiet" tabular>
            {runs}
          </Text>
        </span>
        <span className={s.notes}>
          {glance.notes.map((p) => (
            <Text key={p.text} size="sm" tone={TONE[p.tone]} tabular>
              {p.text}
            </Text>
          ))}
          {props.failing > 0 ? (
            <Text size="sm" tone="warning">
              {props.failing === 1 ? "1 check wants a look" : `${props.failing} checks want a look`}
            </Text>
          ) : null}
        </span>
      </div>
      {m.status === "degraded" && m.degradedReason ? (
        <Text size="sm" tone="warning" className={s.reason}>
          <HubText>{m.degradedReason}</HubText>
        </Text>
      ) : null}
      {open ? (
        <div className={s.detail} id={detailId}>
          <span className={s.facts}>
            {glance.facts.map((p) => (
              <Text key={p.text} size="xs" tone="quiet" tabular>
                {p.text}
              </Text>
            ))}
          </span>
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
          {/* Machine roles are hub-wide: the way to them is for owners and admins only. */}
          {props.admin ? (
            <button
              type="button"
              className={s.link}
              onClick={() => {
                window.location.hash = toHash({ id: "settings", tab: "hub.machines" });
              }}
            >
              <Text size="sm" tone="inherit">
                Roles and screens…
              </Text>
            </button>
          ) : null}
        </div>
      ) : null}
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
          <MenuItem
            onSelect={() => {
              window.location.hash = toHash({ id: "settings", tab: "projects", for: `${p.machineId}/${p.projectId}` });
            }}
          >
            Settings…
          </MenuItem>
          <MenuItem danger onSelect={() => onRemove({ machineId: p.machineId, projectId: p.projectId, title: p.title, path: p.workspaceRoot })}>
            Remove project…
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
