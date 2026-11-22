// Max agents in the app: a project's slider in Settings → Projects › Agents (the panel's Agents tab links to it, "4
// working · max 20"), with the rest of what its agents get, and each machine's cap, which is hub-wide and lives on the
// machine's page in Settings › Hub › Machines (MachineCap). The whole fleet's cap is the CLI's alone (`fleetd project
// cap --fleet-cap`); unset, it is every machine's added up, so the app sets none. Reads the hub's slot state from the data layer's store; a slider applies when you let go (a cap_set call
// through the layer), with Undo, and the hub's next slot state confirms it.
import { Slider } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectRef, SlotState } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import {
  appliedLine,
  changeLine,
  clampMax,
  extrasLine,
  extrasOver,
  holdOf,
  providedHold,
  holdsLink,
  machineAgents,
  machineHolds,
  pauseLine,
  projectAgents,
  sliderTop,
  sourceLine,
  type MachineAgents,
} from "./agentsModel";
import { errorText, useHubCall, useLive } from "./hub";
import { useFocusProjectSlider } from "./focusProject";
import { parseScope, projectRefOf } from "./editor";
import { AllowedProfiles } from "./Profiles";
import { GroupNote, NoProject, PageHead, SettingsRow, SettingsSection } from "./parts";
import { replaceRoute, type SettingsRoute } from "./route";
import { ProjectSkills } from "./Skills";
import { useAdministers } from "../admin/role";
import { toHash } from "../shell/routes";
import { RUNNER_ID } from "../../../shared/providers";
import { revealNext } from "./search";
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
function ResultLine(props: { id: string; state: SliderState; idle: string | null; done: (d: Done) => string; actions?: (d: Done) => ReactNode }) {
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
  // Nothing to say at rest: the line's place stays for assistive tech, out of the layout.
  if (props.idle === null) return <span role="status" id={`${props.id}-line`} className={s.srOnly} />;
  return (
    <div role="status" id={`${props.id}-line`}>
      <Text size="xs" tone="quiet">
        {props.idle}
      </Text>
    </div>
  );
}

const NO_INPUT = {};

/** One project's Max agents: the slider, which applies when you let go, and what the change does. */
export function AgentsPanel(props: { projectRef: ProjectRef; slots: SlotState; title?: string }) {
  const live = useLive();
  const call = useHubCall();
  // What holds it past its max: its machine's cap and the hosted limits it goes on to, or the provider its Runs on
  // picked, whose limit alone holds its agents (the hub's slot board places them so).
  const pick = useToolQuery("project_settings_get", props.projectRef, { enabled: live }).data?.settings.computer;
  const sandboxes = useToolQuery("sandbox_get", NO_INPUT, { enabled: live });
  // A cloud team on fleetd's computers has no sandbox_get (the hub answers not found): its plan holds its agents.
  const provided = useHub().cloud === true && sandboxes.error instanceof CallError && sandboxes.error.error.code === "not_found";
  const hold = provided ? providedHold(props.slots) : holdOf(pick, sandboxes.data);
  const a = projectAgents(props.slots, props.projectRef, hold);
  const state = useApplySlider(a.max, !a.own, (maxAgents, pauseExtras, follow) =>
    call("cap_set", {
      project: { projectRef: props.projectRef, ...(follow ? { followDefault: true } : { maxAgents }), ...(pauseExtras ? { pauseExtras: true } : {}) },
    }).then((o) => o.paused?.length ?? 0),
  );
  const value = clampMax(state.value, a.top);
  const id = `agents-${props.projectRef.machineId}-${props.projectRef.projectId}`;


  return (
    <SettingsRow
      title={props.title ?? "Max agents"}
      titleId={`${id}-label`}
      hint="The most agents this bot runs at once. At 1, the lead works through its tasks in order."
      line={sourceLine(props.slots, a, props.projectRef.machineId, hold)}
      control={
        <>
          {a.own ? (
            <Button size="sm" variant="quiet" disabled={!live || state.busy} onClick={() => state.toDefault(a.cap)}>
              Use the default
            </Button>
          ) : null}
          <Text tabular>{`${value}`}</Text>
        </>
      }
    >
      <CapSlider id={id} max={a.top} disabled={!live || a.top <= 1} state={state} />
      <MachineHolds note={machineHolds(a, value, props.projectRef.machineId, hold)} link={holdsLink(a, props.projectRef.machineId, hold)} machineId={props.projectRef.machineId} />
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

    </SettingsRow>
  );
}

/**
 * Under a project's slider past its machine's cap: the machine holds it there. Machine caps are hub-wide, so an owner or
 * admin gets the way to them in Hub › Machines; everyone else, only the line.
 */
function MachineHolds(props: { note: string | null; link: { text: string; provider: boolean; billing?: true }; machineId: string }) {
  const administers = useAdministers();
  if (props.note === null) return null;
  return (
    <div className={s.result}>
      <Text size="xs" tone="warning">
        {props.note}
      </Text>
      {administers ? (
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            // fleetd's computers: the team's plan, on Billing.
            if (props.link.billing === true) {
              window.location.hash = toHash({ id: "settings", tab: "hub.billing" });
              return;
            }
            // A provider's limit: the hosted sandboxes' link lands on its row by itself (admin/HubPages.tsx).
            if (!props.link.provider) revealNext("hub.caps");
            window.location.hash = toHash({ id: "settings", tab: "hub.machines", machine: props.link.provider ? RUNNER_ID : props.machineId });
          }}
        >
          {props.link.text}
        </Button>
      ) : null}
    </div>
  );
}

/** A machine's agents, on its page: how many it runs at once, where that comes from, and the slider that changes it. */
export function MachineCap({ machineId }: { machineId: string }) {
  const slots = useSlots();
  const live = useLive();
  if (!live || !slots) return <GroupNote>{live ? "Loading…" : "Connect to a hub to see and change this."}</GroupNote>;
  const m = machineAgents(slots).find((x) => x.machineId === machineId);
  if (m === undefined) return <GroupNote>It hasn&apos;t reported yet.</GroupNote>;
  return <MachinePanel machine={m} top={Math.max(1, sliderTop(slots), m.cap)} />;
}

function MachinePanel({ machine: m, top }: { machine: MachineAgents; top: number }) {
  const live = useLive();
  const call = useHubCall();
  const state = useApplySlider(m.cap, !m.set, (maxAgents, _pause, auto) =>
    call("cap_set", { machine: { machineId: m.machineId, ...(auto ? { auto: true } : { maxAgents }) } }).then(() => 0),
  );
  const id = `agents-machine-${m.machineId}`;
  return (
    <SettingsRow
      title="At once"
      titleId={`${id}-label`}
      hint={m.source}
      control={
        <>
          {m.set ? (
            <Button size="sm" variant="quiet" disabled={!live || state.busy} onClick={() => state.toDefault(m.auto)}>
              Use auto
            </Button>
          ) : null}
          <Text tone="quiet" tabular>{`${m.running} running`}</Text>
          <Text tabular>{`${state.value}`}</Text>
        </>
      }
    >
      <CapSlider id={id} max={top} disabled={!live || top <= 1} state={state} />
      <ResultLine id={id} state={state} idle={null} done={(d) => appliedLine(d.follow ? `${m.machineId}, auto` : m.machineId, d.from, d.to)} />
    </SettingsRow>
  );
}

/**
 * Settings → Projects › Agents: one project's max agents, the task profiles it allows and its skills (its MCP servers are on its Project page).
 */
export function AgentsSettings({ route }: { route: SettingsRoute }) {
  const slots = useSlots();
  const live = useLive();
  const scope = route.for ? parseScope(route.for) : null;
  const ref = scope ? projectRefOf(scope) : undefined;
  useFocusProjectSlider(live && slots !== undefined && ref !== undefined);
  useEffect(() => {
    replaceRoute({ tab: "agents", for: route.for });
  }, [route.for]);
  return (
    <div className={s.scroll} data-screen="settings.agents">
      <div className={s.column}>
        <PageHead title="Agents" />
        {!live ? (
          <SettingsSection>
            <GroupNote>Connect to a hub to see and change this.</GroupNote>
          </SettingsSection>
        ) : ref === undefined || scope === null ? (
          <NoProject />
        ) : (
          <>
            <SettingsSection reveal="agents.project">
              {slots ? <AgentsPanel projectRef={ref} slots={slots} /> : <GroupNote>Loading…</GroupNote>}
            </SettingsSection>
            <AllowedProfiles projectRef={ref} />
            <SettingsSection>
              <ProjectSkills scope={scope} />
            </SettingsSection>
          </>
        )}
      </div>
    </div>
  );
}
