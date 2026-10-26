// Max agents in the app: the chat header's "agents 6 / 12" control (it opens the slider in place), the same slider
// per project in Settings → Agents, each machine's, and the fleet-wide cap above them. Reads the hub's slot state from the data
// layer's store; a slider applies when you let go (a cap_set call through the layer), with Undo, and the hub's next
// slot state confirms it.
import { Slider } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRef, SlotState } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, cx, PROFILE_LINE, Popover, PopoverContent, PopoverTrigger, Separator, Switch, Text, textClass } from "../../ui";
import {
  agentsLabel,
  appliedLine,
  changeLine,
  clampMax,
  extrasLine,
  extrasOver,
  fleetTop,
  fleetWarning,
  machineAgents,
  machineHolds,
  pauseLine,
  projectAgents,
  serialNote,
  sliderTop,
  sourceLine,
  type MachineAgents,
} from "./agentsModel";
import { errorText, useHubCall, useLive, useRefetch } from "./hub";
import { useFocusProjectSlider } from "./focusProject";
import { PageHead, scopeName, useProjects } from "./parts";
import { promptHref } from "./route";
import { useReveal } from "./search";
import s from "./settings.module.css";

const noInput = {};

/**
 * Whether this key may change the fleet and machine caps (Admin on every machine), as hub_info says. True until it
 * answers, and with a hub from before it said: the hub refuses the change, and the line under the slider says why.
 */
const useAdmin = (): boolean => useToolQuery("hub_info", noInput).data?.admin !== false;

/** Under a control a key without Admin can't use. */
const NOT_ADMIN = "This key can't change it: that needs an admin key.";

/** The hub's slot state for this connection; undefined until it is fresh (never the last connection's numbers). */
const useSlots = (): SlotState | undefined => useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));

/** "agents 6 / 12" in the project's chat header; a click opens the Max agents slider in place. */
export function AgentsCapControl({ projectRef }: { projectRef: ProjectRef }) {
  const slots = useSlots();
  const [open, setOpen] = useState(false);
  if (!slots) return null;
  const a = projectAgents(slots, projectRef);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" aria-label={`Max agents: ${a.running} running of ${a.limit}${a.queued > 0 ? `, ${a.queued} queued` : ""}`}>
          <span className={cx(textClass({ size: "xs", tabular: true }), s.agentsLabel)}>{agentsLabel(a)}</span>
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

/**
 * A change applied: from what, to what, and how many agents it paused. `follow`: it went back to the default;
 * `fromDefault`: it left the default, so Undo goes back to it rather than setting the number it was then.
 */
type Done = { from: number; to: number; paused: number; follow: boolean; fromDefault: boolean };
type Attempt = Omit<Done, "paused"> & { pause: boolean; undo: boolean };

/** A keyboard change applies once the keys rest, so arrowing 6 → 3 is one change (and one line in the chat). */
const KEYS_REST_MS = 600;

/**
 * A slider that applies when you let go. `hub` is the value in effect, and `onDefault` whether it is a default that
 * follows another cap; `write` sets one, or goes back to the default with `follow`, and answers how many agents it
 * paused. The value moved to stays on screen until the hub's slot state shows it, so the thumb doesn't jump back.
 */
function useApplySlider(hub: number, onDefault: boolean, write: (to: number, pause: boolean, follow: boolean) => Promise<number>) {
  const [draft, setDraft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [failed, setFailed] = useState<{ text: string; attempt: Attempt } | null>(null);
  if (draft !== null && !busy && draft === hub) setDraft(null);
  const value = draft ?? hub;

  const run = (attempt: Attempt) => {
    setBusy(true);
    setFailed(null);
    write(attempt.to, attempt.pause, attempt.follow).then(
      (paused) => {
        setBusy(false);
        setDone(attempt.undo ? null : { from: attempt.from, to: attempt.to, paused, follow: attempt.follow, fromDefault: attempt.fromDefault });
      },
      (e: unknown) => {
        setBusy(false);
        setDraft(null);
        setFailed({ text: errorText(e), attempt });
      },
    );
  };
  const commit = (to: number) => {
    if (to === hub) return setDraft(null);
    run({ to, from: hub, pause: false, undo: false, follow: false, fromDefault: onDefault });
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
      setDraft(d.from);
      run({ to: d.from, from: d.to, pause: false, undo: true, follow: d.fromDefault, fromDefault: false });
    },
    pause: (d: Done) => run({ ...d, pause: true, undo: false }),
    /** Back to the default, `to` as it stands now: the slider follows the hub's answer. */
    toDefault: (to: number) => {
      setDraft(to);
      setDone(null);
      run({ to, from: hub, pause: false, undo: false, follow: true, fromDefault: false });
    },
    retry: () => {
      if (failed === null) return;
      setDraft(failed.attempt.to);
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
  if (d && state.value === d.to) {
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

/** One project's Max agents: the slider, which applies when you let go, and what the change does. */
export function AgentsPanel(props: { projectRef: ProjectRef; slots: SlotState; title?: string; scale?: boolean }) {
  const live = useLive();
  const call = useHubCall();
  const a = projectAgents(props.slots, props.projectRef);
  const state = useApplySlider(a.max, !a.own, (maxAgents, pauseExtras, follow) =>
    call("cap_set", {
      project: { projectRef: props.projectRef, ...(follow ? { followDefault: true } : { maxAgents }), ...(pauseExtras ? { pauseExtras: true } : {}) },
    }).then((o) => o.paused?.length ?? 0),
  );
  const value = clampMax(state.value, a.top);
  const id = `agents-${props.projectRef.machineId}-${props.projectRef.projectId}`;
  const serial = serialNote(value);

  return (
    <div className={s.agentsPanel}>
      <div className={s.agentsHead}>
        <span id={`${id}-label`} className={textClass({ strong: true })}>
          {props.title ?? "Max agents"}
        </span>
        <Text tabular strong>{`${value}`}</Text>
      </div>
      <div className={s.agentsSource}>
        <Text size="xs" tone="quiet">
          {sourceLine(props.slots, a)}
        </Text>
        {a.own ? (
          <Button size="sm" variant="quiet" disabled={!live || state.busy} onClick={() => state.toDefault(a.cap)}>
            Use the default
          </Button>
        ) : null}
      </div>
      <CapSlider id={id} max={a.top} disabled={!live || a.top <= 1} state={state} />
      {props.scale ? (
        <div className={s.agentsScale}>
          <Text size="xs" tone="quiet" tabular>
            1
          </Text>
          <Text size="xs" tone="quiet" tabular>
            {props.slots.fleetCap === undefined ? `${a.top}` : `${a.top}, the whole fleet's cap`}
          </Text>
        </div>
      ) : null}
      <MachineHolds machineId={props.projectRef.machineId} note={machineHolds(a, value, props.projectRef.machineId)} to={value} busy={state.busy} />
      <ResultLine
        id={id}
        state={state}
        idle={changeLine(a, value)}
        done={(d) =>
          [appliedLine(d.follow ? "Max agents, the default" : "Max agents", d.from, d.to), extrasLine(extrasOver(a.running, d.to), d.paused)].filter(Boolean).join(" ")
        }
        actions={(d) => {
          const over = extrasOver(a.running, d.to);
          return d.to < d.from && d.paused === 0 && over > 0 ? (
            <Button disabled={state.busy} onClick={() => state.pause(d)}>
              {pauseLine(over)}
            </Button>
          ) : null;
        }}
      />
      {serial ? (
        <Text size="xs" tone="quiet">
          {serial}
        </Text>
      ) : null}
    </div>
  );
}

/** Under a project's slider past its machine's cap: the machine holds it there, and one click raises the machine. */
function MachineHolds(props: { machineId: string; note: string | null; to: number; busy: boolean }) {
  const live = useLive();
  const admin = useAdmin();
  const call = useHubCall();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  if (props.note === null) return null;
  const raise = () => {
    setBusy(true);
    setError(undefined);
    call("cap_set", { machine: { machineId: props.machineId, maxAgents: props.to } })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={s.result}>
      <Text size="xs" tone="warning">
        {props.note}
      </Text>
      <Button size="sm" disabled={!live || !admin || busy || props.busy} onClick={raise}>
        {`Raise ${props.machineId} to ${props.to}`}
      </Button>
      {admin ? null : (
        <Text size="xs" tone="quiet">
          {NOT_ADMIN}
        </Text>
      )}
      {error === undefined ? null : (
        <p role="alert" className={s.alertLine}>
          <Text size="xs" tone="danger">{`Not changed: ${error}`}</Text>
        </p>
      )}
    </div>
  );
}

/** Each machine's max agents: what it runs at once, where that comes from, and the slider that changes it. */
function MachineCaps({ slots }: { slots: SlotState }) {
  const admin = useAdmin();
  const ref = useReveal<HTMLElement>("agents.machines");
  const machines = machineAgents(slots);
  return (
    <section ref={ref} className={s.agentsList} aria-labelledby="agents-machines" tabIndex={-1}>
      <div className={s.agentsPanel}>
        <Text strong id="agents-machines">
          Machines
        </Text>
        <Text size="xs" tone="quiet">
          {`Every project's agents on a machine together, up to the whole fleet's cap. ${admin ? "Changing one needs an admin key." : NOT_ADMIN}`}
        </Text>
      </div>
      {machines.length === 0 ? (
        <Text tone="quiet">No machine has reported yet.</Text>
      ) : (
        machines.map((m) => (
          <section key={m.machineId} className={s.agentsRow} aria-label={m.machineId}>
            <MachinePanel machine={m} top={Math.max(1, sliderTop(slots), m.cap)} admin={admin} />
          </section>
        ))
      )}
    </section>
  );
}

function MachinePanel({ machine: m, top, admin }: { machine: MachineAgents; top: number; admin: boolean }) {
  const live = useLive();
  const call = useHubCall();
  const state = useApplySlider(m.cap, !m.set, (maxAgents, _pause, auto) =>
    call("cap_set", { machine: { machineId: m.machineId, ...(auto ? { auto: true } : { maxAgents }) } }).then(() => 0),
  );
  const id = `agents-machine-${m.machineId}`;
  return (
    <div className={s.agentsPanel}>
      <div className={s.agentsHead}>
        <span id={`${id}-label`} className={textClass({ strong: true })}>
          {m.machineId}
        </span>
        <Text tabular strong>{`${state.value}`}</Text>
      </div>
      <div className={s.agentsSource}>
        <Text size="xs" tone="quiet">
          {m.source}
        </Text>
        {m.set ? (
          <Button size="sm" variant="quiet" disabled={!live || !admin || state.busy} onClick={() => state.toDefault(m.auto)}>
            Use auto
          </Button>
        ) : null}
      </div>
      <CapSlider id={id} max={top} disabled={!live || !admin || top <= 1} state={state} />
      <ResultLine
        id={id}
        state={state}
        idle={`${m.running} ${m.running === 1 ? "agent" : "agents"} running now.`}
        done={(d) => appliedLine(d.follow ? `${m.machineId}, auto` : m.machineId, d.from, d.to)}
      />
    </div>
  );
}

/** Settings → Agents: the fleet-wide cap, each machine's, then each project's max. */
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
            <Separator />
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

/** The fleet-wide cap: every project's agents together, across every machine. */
function FleetCap({ slots }: { slots: SlotState }) {
  const admin = useAdmin();
  const call = useHubCall();
  const projects = useProjects();
  const live = useLive();
  const state = useApplySlider(slots.cap, false, (cap) => call("cap_set", { cap }).then(() => 0));
  const ref = useReveal<HTMLElement>("agents.fleet");
  const warning = fleetWarning(slots, state.value, (r) => scopeName({ kind: "project", ref: r }, projects));
  const id = "agents-fleet";
  return (
    <section ref={ref} className={s.agentsRow} aria-labelledby={`${id}-label`} tabIndex={-1}>
      <div className={s.agentsPanel}>
        <div className={s.agentsHead}>
          <span id={`${id}-label`} className={textClass({ strong: true })}>
            Whole fleet
          </span>
          <Text tabular strong>{`${state.value}`}</Text>
        </div>
        <Text size="xs" tone="quiet">
          {`All projects together, leads included. ${admin ? "Changing it needs an admin key." : NOT_ADMIN}`}
        </Text>
        <CapSlider id={id} max={fleetTop(slots.cap)} disabled={!live || !admin} state={state} />
        {warning ? (
          <Text size="xs" tone="warning">
            {warning}
          </Text>
        ) : null}
        <ResultLine
          id={id}
          state={state}
          idle={`${slots.used} ${slots.used === 1 ? "agent" : "agents"} running now${slots.queued > 0 ? `, ${slots.queued} queued` : ""}.`}
          done={(d) => appliedLine("Whole fleet", d.from, d.to)}
        />
      </div>
    </section>
  );
}
