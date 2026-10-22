// Max agents in the app: the chat header's "agents 6 / 12" control (it opens the slider in place), the same slider
// per project in Settings → Agents, and the fleet-wide cap above them. Reads the hub's slot state from the data
// layer's store; a slider applies when you let go (a cap_set call through the layer), with Undo, and the hub's next
// slot state confirms it.
import { Slider } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRef, SlotState } from "../../../shared/contracts";
import { useData } from "../../src/data/react";
import { Button, Popover, PopoverContent, PopoverTrigger, Separator, Text, textClass } from "../../ui";
import {
  agentsLabel,
  appliedLine,
  changeLine,
  clampMax,
  extrasLine,
  extrasOver,
  fleetTop,
  fleetWarning,
  pauseLine,
  projectAgents,
  serialNote,
} from "./agentsModel";
import { errorText, useHubCall, useLive } from "./hub";
import { PageHead, scopeName, useProjects } from "./parts";
import { useReveal } from "./search";
import s from "./settings.module.css";

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
        <Button size="sm" variant="ghost" aria-label={`Max agents: ${a.running} running of ${a.max}${a.queued > 0 ? `, ${a.queued} waiting` : ""}`}>
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

/** A change applied: from what, to what, and how many agents it paused. */
type Done = { from: number; to: number; paused: number };
type Attempt = { to: number; from: number; pause: boolean; undo: boolean };

/** A keyboard change applies once the keys rest, so arrowing 6 → 3 is one change (and one line in the chat). */
const KEYS_REST_MS = 600;

/**
 * A slider that applies when you let go. `hub` is the value in effect; `write` sets one and answers how many agents
 * it paused. The value moved to stays on screen until the hub's slot state shows it, so the thumb doesn't jump back.
 */
function useApplySlider(hub: number, write: (to: number, pause: boolean) => Promise<number>) {
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
  const commit = (to: number) => {
    if (to === hub) return setDraft(null);
    run({ to, from: hub, pause: false, undo: false });
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
      run({ to: d.from, from: d.to, pause: false, undo: true });
    },
    pause: (d: Done) => run({ to: d.to, from: d.from, pause: true, undo: false }),
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
  const state = useApplySlider(a.max, (maxAgents, pauseExtras) =>
    call("cap_set", { project: { projectRef: props.projectRef, maxAgents, ...(pauseExtras ? { pauseExtras: true } : {}) } }).then((o) => o.paused?.length ?? 0),
  );
  const value = clampMax(state.value, a.cap);
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
      <CapSlider id={id} max={Math.max(1, a.cap)} disabled={!live || a.cap <= 1} state={state} />
      {props.scale ? (
        <div className={s.agentsScale}>
          <Text size="xs" tone="quiet" tabular>
            1
          </Text>
          <Text size="xs" tone="quiet" tabular>{`${a.cap}, the fleet's limit`}</Text>
        </div>
      ) : null}
      <ResultLine
        id={id}
        state={state}
        idle={changeLine(a, value)}
        done={(d) => [appliedLine("Max agents", d.from, d.to), extrasLine(extrasOver(a.running, d.to), d.paused)].filter(Boolean).join(" ")}
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

/** Settings → Agents: the fleet-wide cap, then each project's max. */
export function AgentsSettings() {
  const slots = useSlots();
  const projects = useProjects();
  const live = useLive();
  const perProject = useReveal<HTMLElement>("agents.project");
  return (
    <div className={s.scroll} data-screen="settings.agents">
      <div className={s.column}>
        <PageHead title="Agents">
          How many agents may run at once. Past the limit, an agent waits and starts the moment one finishes. Reviews that gate a merge
          go first, so a low limit never holds up a merge.
        </PageHead>
        {!live || !slots ? (
          <Text tone="quiet">{live ? "Loading…" : "Connect to a hub to see and change this."}</Text>
        ) : (
          <>
            <FleetCap slots={slots} />
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

/** The fleet-wide cap: every project's agents together, across every machine. */
function FleetCap({ slots }: { slots: SlotState }) {
  const call = useHubCall();
  const projects = useProjects();
  const live = useLive();
  const state = useApplySlider(slots.cap, (cap) => call("cap_set", { cap }).then(() => 0));
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
          Every project's agents and leads together, on every machine. Changing it needs an admin key.
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
          idle={`${slots.used} running now${slots.queued > 0 ? `, ${slots.queued} waiting` : ""}.`}
          done={(d) => appliedLine("Whole fleet", d.from, d.to)}
        />
      </div>
    </section>
  );
}
