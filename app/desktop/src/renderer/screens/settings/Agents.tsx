// Max agents in the app: the chat header's "agents 6 / 12" control (it opens the slider in place), the same slider
// per project in Settings → Agents, each machine's cap (auto, or a number someone set), and the fleet-wide cap above
// them. Reads the hub's slot state from the data layer's store; a slider applies when you let go (a cap_set call
// through the layer), with Undo, Auto goes back to the default, and the hub's next slot state confirms it.
import { Slider } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MachineId, ProjectRef, SlotState } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, PROFILE_LINE, Popover, PopoverContent, PopoverTrigger, Separator, Switch, Text, textClass } from "../../ui";
import {
  aboveAutoLine,
  agentsLabel,
  appliedLine,
  changeLine,
  clampMax,
  diskLine,
  extrasLine,
  extrasOver,
  fleetAgents,
  fleetLine,
  fleetWarning,
  machineAgents,
  machineHint,
  machineLine,
  type MachineAgents,
  pauseLine,
  projectAgents,
  projectAutoLine,
  serialNote,
  sliderTop,
  type Target,
} from "./agentsModel";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { useFocusProjectSlider } from "./focusProject";
import { PageHead, scopeName, useProjects } from "./parts";
import { promptHref } from "./route";
import { useReveal } from "./search";
import s from "./settings.module.css";

/** The hub's slot state for this connection; undefined until it is fresh (never the last connection's numbers). */
const useSlots = (): SlotState | undefined => useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));

/** A machine's name, or its id before the hub has listed it. */
const useMachineName = () => {
  const machines = useData((st) => st.machines);
  return (id: MachineId): string => machines[id]?.name ?? id;
};

/** "agents 6 / 12" in the project's chat header; a click opens the Max agents slider in place. */
export function AgentsCapControl({ projectRef }: { projectRef: ProjectRef }) {
  const slots = useSlots();
  const [open, setOpen] = useState(false);
  if (!slots) return null;
  const a = projectAgents(slots, projectRef);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Max agents: ${a.running} running of ${a.max}${a.queued > 0 ? `, ${a.queued} queued` : ""}`}>
          <span className={textClass({ size: "xs", tabular: true })}>{agentsLabel(a)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className={s.agentsPopover}>
          <AgentsPanel projectRef={projectRef} slots={slots} title="Max agents for this project" scale />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A change applied: from what, to what (`auto`: back to the default), and how many agents it paused. */
type Done = { from: Target; to: Target; paused: number };
type Attempt = { to: Target; from: Target; pause: boolean; undo: boolean };

/** A keyboard change applies once the keys rest, so arrowing 6 → 3 is one change (and one line in the chat). */
const KEYS_REST_MS = 600;

/**
 * A slider that applies when you let go. `hub` is the value in effect, and `auto` whether it is the default rather
 * than a number someone set; `write` sets one (or `auto`) and answers how many agents it paused. The value moved to
 * stays on screen until the hub's slot state shows it, so the thumb doesn't jump back.
 */
function useApplySlider(hub: number, auto: boolean, write: (to: Target, pause: boolean) => Promise<number>) {
  const [draft, setDraft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [failed, setFailed] = useState<{ text: string; attempt: Attempt } | null>(null);
  if (draft !== null && !busy && draft === hub) setDraft(null);
  const value = draft ?? hub;

  const run = (attempt: Attempt) => {
    setBusy(true);
    setFailed(null);
    write(attempt.to, attempt.pause).then(
      (paused) => {
        setBusy(false);
        setDone(attempt.undo ? null : { from: attempt.from, to: attempt.to, paused });
      },
      (e: unknown) => {
        setBusy(false);
        setDraft(null);
        setFailed({ text: errorText(e), attempt });
      },
    );
  };
  const current: Target = auto ? "auto" : hub;
  const commit = (to: number) => {
    if (to === hub) return setDraft(null);
    run({ to, from: current, pause: false, undo: false });
  };

  // A keyboard change waiting for the keys to rest; it still applies if the popover closes first.
  const pending = useRef<{ timer: number; apply: () => void } | null>(null);
  const keyed = useRef(false);
  useEffect(
    () => () => {
      const p = pending.current;
      if (p === null) return;
      window.clearTimeout(p.timer);
      p.apply();
    },
    [],
  );

  const sliderProps = {
    value: [value],
    onValueChange: ([v]: number[]) => {
      if (v === undefined) return;
      setDraft(v);
      setDone(null);
      setFailed(null);
    },
    onValueCommit: ([v]: number[]) => {
      if (v === undefined) return;
      if (pending.current !== null) window.clearTimeout(pending.current.timer);
      if (!keyed.current) {
        pending.current = null;
        return commit(v);
      }
      const apply = () => {
        pending.current = null;
        commit(v);
      };
      pending.current = { timer: window.setTimeout(apply, KEYS_REST_MS), apply };
    },
    onKeyDown: () => {
      keyed.current = true;
    },
    onPointerDown: () => {
      keyed.current = false;
    },
  };

  return {
    value,
    busy,
    done,
    failed,
    sliderProps,
    undo: (d: Done) => {
      setDraft(d.from === "auto" ? null : d.from);
      run({ to: d.from, from: d.to, pause: false, undo: true });
    },
    /** Back to the default: the machine's auto cap, or no fleet cap. */
    reset: () => {
      setDraft(null);
      setDone(null);
      run({ to: "auto", from: current, pause: false, undo: false });
    },
    pause: (d: Done) => run({ to: d.to, from: d.from, pause: true, undo: false }),
    retry: () => {
      if (failed === null) return;
      const { to } = failed.attempt;
      setDraft(to === "auto" ? null : to);
      run(failed.attempt);
    },
  };
}

type SliderState = ReturnType<typeof useApplySlider>;

function CapSlider(props: { id: string; min?: number; max: number; disabled: boolean; state: SliderState }) {
  return (
    <Slider.Root className={s.slider} min={props.min ?? 1} max={props.max} step={1} disabled={props.disabled} {...props.state.sliderProps}>
      <Slider.Track className={s.sliderTrack}>
        <Slider.Range className={s.sliderRange} />
      </Slider.Track>
      <Slider.Thumb className={s.sliderThumb} aria-labelledby={`${props.id}-label`} aria-describedby={`${props.id}-line`} />
    </Slider.Root>
  );
}

/** Under a slider: what letting go will do, what was done (with Undo), or why it wasn't. */
function ResultLine(props: { id: string; state: SliderState; idle: string; done: (d: Done) => string; actions?: (d: Done) => ReactNode }) {
  const { state } = props;
  if (state.failed) {
    return (
      <div className={s.result} role="alert" id={`${props.id}-line`}>
        <Text size="xs" tone="danger">{`Not changed. ${state.failed.text}`}</Text>
        <div className={s.actions}>
          <Button disabled={state.busy} onClick={state.retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const d = state.done;
  if (d && (d.to === "auto" || state.value === d.to)) {
    return (
      <div className={s.result} role="status" id={`${props.id}-line`}>
        <Text size="xs" tone="quiet">
          {props.done(d)}
        </Text>
        <div className={s.actions}>
          {props.actions?.(d)}
          <Button disabled={state.busy} onClick={() => state.undo(d)}>
            Undo
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div role="status" id={`${props.id}-line`}>
      <Text size="xs" tone="quiet">
        {props.idle}
      </Text>
    </div>
  );
}

/** One project's Max agents: the slider, which applies when you let go, what the change does, and Auto. */
export function AgentsPanel(props: { projectRef: ProjectRef; slots: SlotState; title?: string; scale?: boolean }) {
  const live = useLive();
  const call = useHubCall();
  const machine = useMachineName()(props.projectRef.machineId);
  const a = projectAgents(props.slots, props.projectRef);
  const state = useApplySlider(a.max, !a.own, (maxAgents, pauseExtras) =>
    call("cap_set", { project: { projectRef: props.projectRef, maxAgents, ...(pauseExtras ? { pauseExtras: true } : {}) } }).then((o) => o.paused?.length ?? 0),
  );
  const value = clampMax(state.value, a.top);
  const id = `agents-${props.projectRef.machineId}-${props.projectRef.projectId}`;
  const serial = serialNote(value);
  // Going back to auto lands on the machine's cap.
  const at = (t: Target) => (t === "auto" ? a.top : t);

  return (
    <div className={s.agentsPanel}>
      <div className={s.agentsHead}>
        <span id={`${id}-label`} className={textClass({ strong: true })}>
          {props.title ?? "Max agents"}
        </span>
        <Text tabular strong>{`${value}`}</Text>
      </div>
      <CapSlider id={id} max={Math.max(1, a.top)} disabled={!live || a.top <= 1} state={state} />
      {props.scale ? (
        <div className={s.agentsScale}>
          <Text size="xs" tone="quiet" tabular>
            1
          </Text>
          <Text size="xs" tone="quiet" tabular>{`${a.top}, ${machine}'s cap`}</Text>
        </div>
      ) : null}
      {!a.own && value === a.max && a.max === a.top ? (
        <Text size="xs" tone="quiet">
          {projectAutoLine(a, machine)}
        </Text>
      ) : null}
      <ResultLine
        id={id}
        state={state}
        idle={changeLine(a, value)}
        done={(d) => [appliedLine("Max agents", d.from, d.to), extrasLine(extrasOver(a.running, at(d.to)), d.paused)].filter(Boolean).join(" ")}
        actions={(d) => {
          const over = extrasOver(a.running, at(d.to));
          return at(d.to) < at(d.from) && d.paused === 0 && over > 0 ? (
            <Button disabled={state.busy} onClick={() => state.pause(d)}>
              {pauseLine(over)}
            </Button>
          ) : null;
        }}
      />
      <AutoButton shown={a.own} state={state} label={`Set ${props.title ?? "this project"}'s max agents back to auto`}>
        Auto
      </AutoButton>
      {serial ? (
        <Text size="xs" tone="quiet">
          {serial}
        </Text>
      ) : null}
    </div>
  );
}

/** Back to the default (a machine's auto cap; no fleet cap), while a number someone set is in effect. */
function AutoButton(props: { shown: boolean; state: SliderState; label: string; children: ReactNode }) {
  const live = useLive();
  if (!props.shown || props.state.failed) return null;
  return (
    <span>
      <Button size="sm" variant="quiet" aria-label={props.label} disabled={!live || props.state.busy} onClick={props.state.reset}>
        {props.children}
      </Button>
    </span>
  );
}

/** Settings → Agents: the fleet-wide cap, each machine's cap, then each project's max. */
export function AgentsSettings() {
  const slots = useSlots();
  const projects = useProjects();
  const live = useLive();
  useFocusProjectSlider(live && slots !== undefined && projects !== undefined);
  const perProject = useReveal<HTMLElement>("agents.project");
  return (
    <div className={s.scroll} data-screen="settings.agents">
      <div className={s.column}>
        <PageHead title="Agents">
          How many agents run at once. Past the limit, the next one waits its turn; merge reviews go first.
        </PageHead>
        {!live || !slots ? (
          <Text tone="quiet">{live ? "Loading…" : "Connect to a hub to see and change this."}</Text>
        ) : (
          <>
            <FleetCap slots={slots} />
            <Separator />
            <MachineCaps slots={slots} />
            <TaskProfiles />
            <Separator />
            <section ref={perProject} className={s.agentsList} aria-labelledby="agents-per-project" tabIndex={-1}>
              <Text strong id="agents-per-project">
                Max agents per project
              </Text>
              {projects === undefined ? (
                <Text tone="quiet">Loading…</Text>
              ) : projects.length === 0 ? (
                <Text tone="quiet">No projects yet. Each project you add gets its own max here.</Text>
              ) : (
                projects.map((p) => {
                  const ref = { machineId: p.machineId, projectId: p.projectId };
                  return (
                    <section key={`${p.machineId}/${p.projectId}`} className={s.agentsRow} aria-label={p.title}>
                      <AgentsPanel projectRef={ref} slots={slots} title={scopeName({ kind: "project", ref }, projects)} />
                      <MediumSwitch projectRef={ref} />
                    </section>
                  );
                })
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** The two task profiles every agent runs on, as fixed as the prompts: shown, never typed in. */
function TaskProfiles() {
  const ref = useReveal<HTMLElement>("agents.profiles");
  return (
    <section ref={ref} className={s.agentsPanel} aria-labelledby="agents-profiles" tabIndex={-1}>
      <Text strong id="agents-profiles">
        Task profiles
      </Text>
      <Text size="xs" tone="quiet">
        The lead picks one for each task. The lead itself and every review run high.
      </Text>
      <ul className={s.profiles}>
        <li>
          <Text size="sm">{PROFILE_LINE.high}</Text>
        </li>
        <li>
          <Text size="sm">{PROFILE_LINE.medium}</Text>
        </li>
      </ul>
      <span>
        <Button variant="quiet" size="sm" onClick={() => (window.location.hash = promptHref("lead.profiles"))}>
          Edit the Task profiles prompt
        </Button>
      </span>
    </section>
  );
}

/** A project's "medium allowed" switch (project_set): off, every one of its tasks runs high. */
function MediumSwitch({ projectRef }: { projectRef: ProjectRef }) {
  const live = useLive();
  const call = useHubCall();
  const refetch = useRefetch();
  const project = useToolQuery("project_get", { machineId: projectRef.machineId, projectId: projectRef.projectId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (project.data === undefined) return null;
  // A hub from before the switch has it on.
  const allowed = project.data.mediumAllowed ?? true;
  const set = (on: boolean) => {
    setBusy(true);
    setError(undefined);
    call("project_set", { machineId: projectRef.machineId, projectId: projectRef.projectId, mediumAllowed: on })
      .then(() => refetch(["project_get"]))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={s.stack}>
      <Switch
        label="Medium allowed"
        description={allowed ? "Mechanical tasks may run on medium." : "Every task runs on high."}
        checked={allowed}
        disabled={!live || busy}
        onCheckedChange={set}
      />
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`Not changed: ${error}`}</Text>
        </p>
      )}
    </div>
  );
}

/** Each machine's cap: auto, from what it fits, or a number someone set. Absent from a hub before machine caps. */
function MachineCaps({ slots }: { slots: SlotState }) {
  const name = useMachineName();
  const ref = useReveal<HTMLElement>("agents.machine");
  if (slots.perMachine === undefined) return null;
  const machines = machineAgents(slots, name);
  return (
    <>
      <section ref={ref} className={s.agentsList} aria-labelledby="agents-per-machine" tabIndex={-1}>
        <div className={s.stack}>
          <Text strong id="agents-per-machine">
            Max agents per machine
          </Text>
          <Text size="xs" tone="quiet">
            Auto: what each machine's memory and CPUs fit. A number replaces it, and free disk still holds new agents back.
          </Text>
        </div>
        {machines.length === 0 ? (
          <Text tone="quiet">No machines yet. Each machine that connects gets its own cap here.</Text>
        ) : (
          machines.map((m) => <MachineCap key={m.machineId} machine={m} name={name(m.machineId)} />)
        )}
      </section>
      <Separator />
    </>
  );
}

/** One machine's cap: the slider, what sets the cap, its disk room, and Auto while a number is set. */
function MachineCap({ machine: m, name }: { machine: MachineAgents; name: string }) {
  const live = useLive();
  const call = useHubCall();
  const state = useApplySlider(m.cap, !m.set, (maxAgents) => call("cap_set", { machine: { machineId: m.machineId, maxAgents } }).then(() => 0));
  const id = `machine-${m.machineId}`;
  const value = state.value;
  const above = aboveAutoLine(m, value);
  const disk = diskLine(m);
  const hint = machineHint(m);
  return (
    <section className={s.agentsRow} aria-label={name}>
      <div className={s.agentsPanel}>
        <div className={s.agentsHead}>
          <span id={`${id}-label`} className={textClass({ strong: true })}>
            {name}
          </span>
          <Text tabular strong>{`${value}`}</Text>
        </div>
        <Text size="xs" tone="quiet">
          {machineLine(m)}
        </Text>
        {hint ? (
          <Text size="xs" tone="quiet">
            {hint}
          </Text>
        ) : null}
        <CapSlider id={id} max={sliderTop(m.cap, m.auto)} disabled={!live} state={state} />
        {above ? (
          <Text size="xs" tone="warning">
            {above}
          </Text>
        ) : null}
        {disk ? (
          <Text size="xs" tone="warning">
            {disk}
          </Text>
        ) : null}
        <ResultLine
          id={id}
          state={state}
          idle={changeLine({ running: m.running, queued: 0, max: m.cap }, value)}
          done={(d) => appliedLine(`Max agents on ${name}`, d.from, d.to)}
        />
        <AutoButton shown={m.set} state={state} label={`Set ${name}'s max agents back to auto, ${m.auto}`}>
          {`Auto (${m.auto})`}
        </AutoButton>
      </div>
    </section>
  );
}

/** The fleet-wide cap: every project's agents together, across every machine. Unset: no limit beyond the machines. */
function FleetCap({ slots }: { slots: SlotState }) {
  const call = useHubCall();
  const projects = useProjects();
  const live = useLive();
  const f = fleetAgents(slots);
  const state = useApplySlider(f.cap ?? f.fits, f.cap === null, (to) => call("cap_set", { cap: to }).then(() => 0));
  const ref = useReveal<HTMLElement>("agents.fleet");
  const moved = state.value !== (f.cap ?? f.fits);
  const warning = f.cap !== null || moved ? fleetWarning(slots, state.value, (r) => scopeName({ kind: "project", ref: r }, projects)) : null;
  const id = "agents-fleet";
  return (
    <section ref={ref} className={s.agentsRow} aria-labelledby={`${id}-label`} tabIndex={-1}>
      <div className={s.agentsPanel}>
        <div className={s.agentsHead}>
          <span id={`${id}-label`} className={textClass({ strong: true })}>
            Whole fleet
          </span>
          <Text tabular strong>{f.cap === null && !moved ? "No limit" : `${state.value}`}</Text>
        </div>
        <Text size="xs" tone="quiet">
          All projects together, leads included. Changing it needs an admin key.
        </Text>
        <Text size="xs" tone="quiet">
          {fleetLine(f)}
        </Text>
        <CapSlider id={id} max={sliderTop(f.cap ?? 0, f.fits)} disabled={!live} state={state} />
        {warning ? (
          <Text size="xs" tone="warning">
            {warning}
          </Text>
        ) : null}
        <ResultLine
          id={id}
          state={state}
          idle={`${f.used} ${f.used === 1 ? "agent" : "agents"} running now${f.queued > 0 ? `, ${f.queued} queued` : ""}.`}
          done={(d) => appliedLine("Whole fleet", d.from, d.to, "no limit")}
        />
        <AutoButton shown={f.cap !== null} state={state} label="Remove the fleet cap: no limit beyond the machines">
          No limit
        </AutoButton>
      </div>
    </section>
  );
}
