// Max agents in the app: the chat header's "agents 6 / 12" control (it opens the slider in place), the same slider
// per project in Settings → Agents, and the fleet-wide cap above them. Reads the hub's slot state from the data
// layer's store; writes are cap_set calls through the layer, and the hub's next slot state confirms them.
import { Slider } from "radix-ui";
import { useState } from "react";
import type { ProjectRef, SlotState } from "../../../shared/contracts";
import { useData } from "../../src/data/react";
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Separator, Text, textClass } from "../../ui";
import { agentsLabel, changeLine, clampMax, projectAgents, serialNote, type ProjectAgents } from "./agents";
import { errorText, useHubCall, useLive } from "./hub";
import { scopeName, useProjects } from "./parts";
import s from "./settings.module.css";

type Echo = { ok: boolean; text: string };

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
        <Button size="sm" variant="ghost" aria-label={`Max agents: ${a.running} running of ${a.max}`}>
          <span className={textClass({ size: "xs", tabular: true })}>{agentsLabel(a)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <div className={s.agentsPopover}>
          <AgentsPanel projectRef={projectRef} slots={slots} onSaved={() => setOpen(false)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One project's Max agents: the slider, what the change will do, and Save. */
export function AgentsPanel(props: { projectRef: ProjectRef; slots: SlotState; title?: string; onSaved?: () => void }) {
  const live = useLive();
  const call = useHubCall();
  const a: ProjectAgents = projectAgents(props.slots, props.projectRef);
  // The draft follows the hub until it is moved; after a save it holds the saved value until the hub's slot state
  // shows it, so the slider doesn't jump back for a moment.
  const [draft, setDraft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const value = clampMax(draft ?? a.max, a.cap);
  if (draft !== null && !busy && echo?.ok === true && draft === a.max) setDraft(null);
  const changed = value !== a.max;
  const id = `agents-${props.projectRef.machineId}-${props.projectRef.projectId}`;
  const serial = changed ? serialNote(value) : null;

  const save = () => {
    setBusy(true);
    setEcho(null);
    // The fleet cap is the default: a max equal to it saves as no limit of the project's own.
    call("cap_set", { share: { projectRef: props.projectRef, share: value >= a.cap ? 0 : value } }).then(
      () => {
        setBusy(false);
        setEcho({ ok: true, text: `Saved: at most ${value} at once.` });
        props.onSaved?.();
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };

  return (
    <div className={s.agentsPanel}>
      <div className={s.agentsHead}>
        <label htmlFor={id} className={textClass({ strong: true })}>
          {props.title ?? "Max agents"}
        </label>
        <Text tabular strong>{`${value}`}</Text>
      </div>
      <Slider.Root
        id={id}
        className={s.slider}
        min={1}
        max={Math.max(1, a.cap)}
        step={1}
        value={[value]}
        disabled={!live || busy || a.cap <= 1}
        onValueChange={([v]) => {
          if (v !== undefined) setDraft(v);
          setEcho(null);
        }}
        aria-label={props.title ?? "Max agents"}
      >
        <Slider.Track className={s.sliderTrack}>
          <Slider.Range className={s.sliderRange} />
        </Slider.Track>
        <Slider.Thumb className={s.sliderThumb} aria-label="Max agents" />
      </Slider.Root>
      <div className={s.agentsScale}>
        <Text size="xs" tone="quiet" tabular>
          1
        </Text>
        <Text size="xs" tone="quiet" tabular>{`${a.cap}, the fleet's limit`}</Text>
      </div>
      <Text size="xs" tone="quiet">
        {changeLine(a, value)}
      </Text>
      {serial ? (
        <Text size="xs" tone="quiet">
          {serial}
        </Text>
      ) : null}
      <div className={s.actions}>
        <Button variant="primary" disabled={!live || !changed || busy} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {changed ? (
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
        ) : null}
      </div>
      {echo ? (
        <div role="status">
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/** Settings → Agents: the fleet-wide cap, then each project's max. */
export function AgentsSettings() {
  const slots = useSlots();
  const projects = useProjects();
  const live = useLive();
  return (
    <div className={s.scroll} data-screen="settings.agents">
      <div className={s.column}>
        <Text tone="quiet">
          How many agents may run at once. fleetd holds to it: an agent past the limit waits, and starts the moment one
          finishes. Reviews that gate a merge go first, so a low limit never stalls the merge train.
        </Text>
        {!live || !slots ? (
          <Text tone="quiet">{live ? "Loading…" : "Connect to a hub to see and change this."}</Text>
        ) : (
          <>
            <FleetCap slots={slots} />
            <Separator />
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
          </>
        )}
      </div>
    </div>
  );
}

/** The fleet-wide cap: every project's agents together, across every machine. */
function FleetCap({ slots }: { slots: SlotState }) {
  const call = useHubCall();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<Echo | null>(null);
  const text = draft ?? String(slots.cap);
  const n = Number(text);
  const valid = Number.isInteger(n) && n >= 1 && n <= 1000;
  const changed = valid && n !== slots.cap;
  const save = () => {
    setBusy(true);
    setEcho(null);
    call("cap_set", { cap: n }).then(
      (o) => {
        setBusy(false);
        setDraft(null);
        setEcho({ ok: true, text: `Saved: at most ${o.slots.cap} agents at once across the fleet.` });
      },
      (e: unknown) => {
        setBusy(false);
        setEcho({ ok: false, text: errorText(e) });
      },
    );
  };
  return (
    <div className={s.setting}>
      <div className={s.settingLabel}>
        <Text strong>Whole fleet</Text>
        <Text size="xs" tone="quiet">
          {`Every project's agents together, on every machine. ${slots.used} running now${slots.queued > 0 ? `, ${slots.queued} waiting` : ""}.`}
        </Text>
      </div>
      <div className={s.stack}>
        <div className={s.inline}>
          <div className={s.capField}>
            <Input
              aria-label="Most agents at once across the fleet"
              inputMode="numeric"
              value={text}
              aria-invalid={!valid}
              onChange={(e) => {
                setDraft(e.target.value);
                setEcho(null);
              }}
            />
          </div>
          <Button variant="primary" disabled={!changed || busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
        {!valid ? (
          <Text size="xs" tone="danger">
            A whole number from 1 to 1000.
          </Text>
        ) : null}
        {echo ? (
          <div role="status">
            <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
              {echo.text}
            </Text>
          </div>
        ) : null}
      </div>
    </div>
  );
}
