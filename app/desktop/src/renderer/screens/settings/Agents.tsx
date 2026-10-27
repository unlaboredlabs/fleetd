// Max agents in the app: the slider per project in Settings → Agents (the panel's Agents tab links to it, "4 working
// · max 20"), and each machine's and the fleet-wide cap, which are hub-wide and live on Administration's hub settings
// (HubCaps). Reads the hub's slot state from the data layer's store; a slider applies when you let go (a cap_set call
// through the layer), with Undo, and the hub's next slot state confirms it.
import { Slider } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRef, SlotState } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, Separator, Switch, Text, textClass } from "../../ui";
import {
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
import { ProfilesSetting } from "./ProfilesSetting";
import { promptHref } from "./route";
import { useAdministers } from "../admin/role";
import { toHash } from "../shell/routes";
import { useReveal } from "./search";
import s from "./settings.module.css";

/** The hub's slot state for this connection; undefined until it is fresh (never the last connection's numbers). */
const useSlots = (): SlotState | undefined => useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));

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
export function AgentsPanel(props: { projectRef: ProjectRef; slots: SlotState; title?: string }) {
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
      <MachineHolds note={machineHolds(a, value, props.projectRef.machineId)} />
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

/**
 * Under a project's slider past its machine's cap: the machine holds it there. Machine caps are hub-wide, so an owner or
 * admin gets the way to them on Administration; everyone else, only the line.
 */
function MachineHolds(props: { note: string | null }) {
  const administers = useAdministers();
  if (props.note === null) return null;
  return (
    <div className={s.result}>
      <Text size="xs" tone="warning">
        {props.note}
      </Text>
      {administers ? (
        <Button size="sm" variant="quiet" onClick={() => (window.location.hash = toHash({ id: "admin", section: "hub" }))}>
          Machine caps in Administration
        </Button>
      ) : null}
    </div>
  );
}

/** Each machine's max agents: what it runs at once, where that comes from, and the slider that changes it. */
function MachineCaps({ slots }: { slots: SlotState }) {
  const machines = machineAgents(slots);
  return (
    <section className={s.agentsList} aria-labelledby="agents-machines">
      <div className={s.agentsPanel}>
        <Text strong id="agents-machines">
          Machines
        </Text>
        <Text size="xs" tone="quiet">
          Every project's agents on a machine together, up to the whole fleet's cap.
        </Text>
      </div>
      {machines.length === 0 ? (
        <Text tone="quiet">No machine has reported yet.</Text>
      ) : (
        machines.map((m) => (
          <section key={m.machineId} className={s.agentsRow} aria-label={m.machineId}>
            <MachinePanel machine={m} top={Math.max(1, sliderTop(slots), m.cap)} />
          </section>
        ))
      )}
    </section>
  );
}

function MachinePanel({ machine: m, top }: { machine: MachineAgents; top: number }) {
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
          <Button size="sm" variant="quiet" disabled={!live || state.busy} onClick={() => state.toDefault(m.auto)}>
            Use auto
          </Button>
        ) : null}
      </div>
      <CapSlider id={id} max={top} disabled={!live || top <= 1} state={state} />
      <ResultLine
        id={id}
        state={state}
        idle={`${m.running} ${m.running === 1 ? "agent" : "agents"} running now.`}
        done={(d) => appliedLine(d.follow ? `${m.machineId}, auto` : m.machineId, d.from, d.to)}
      />
    </div>
  );
}

/**
 * Administration's caps: the whole fleet's, then each machine's. Both are hub-wide, so they live there and not in
 * Settings.
 */
export function HubCaps() {
  const slots = useSlots();
  const live = useLive();
  if (!live || !slots) return <Text tone="quiet">{live ? "Loading…" : "Connect to a hub to see and change this."}</Text>;
  return (
    <>
      <FleetCap slots={slots} />
      <Separator />
      <MachineCaps slots={slots} />
    </>
  );
}

/** Settings → Agents: each project's max, and whether its tasks may run on medium. */
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

/**
 * The two task profiles every agent runs on, and the model and effort behind each for the whole fleet: hub-wide, so on
 * Administration's hub settings. A project's override stays in its own settings.
 */
export function TaskProfiles() {
  return (
    <section className={s.agentsPanel} aria-labelledby="agents-profiles">
      <Text strong id="agents-profiles">
        Task profiles
      </Text>
      <Text size="xs" tone="quiet">
        The lead picks one for each task. The lead itself and every review run high. Set the model and effort behind
        each for every project here; a project can override it in its settings.
      </Text>
      <ProfilesSetting />
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
  const call = useHubCall();
  const projects = useProjects();
  const live = useLive();
  const state = useApplySlider(slots.cap, false, (cap) => call("cap_set", { cap }).then(() => 0));
  const warning = fleetWarning(slots, state.value, (r) => scopeName({ kind: "project", ref: r }, projects));
  const id = "agents-fleet";
  return (
    <section className={s.agentsRow} aria-labelledby={`${id}-label`}>
      <div className={s.agentsPanel}>
        <div className={s.agentsHead}>
          <span id={`${id}-label`} className={textClass({ strong: true })}>
            Whole fleet
          </span>
          <Text tabular strong>{`${state.value}`}</Text>
        </div>
        <Text size="xs" tone="quiet">
          All projects together, leads included.
        </Text>
        <CapSlider id={id} max={fleetTop(slots.cap)} disabled={!live} state={state} />
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
