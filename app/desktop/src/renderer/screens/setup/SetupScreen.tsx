// The hub admin's setup: the steps the hub serves (setup_list), the same ones `fleetd init`
// walks. #/setup is the first run: the welcome, the steps with one open beside them, and the end. Settings › Hub ›
// Setup shows the same steps (SetupSteps) on its page. Each step's status is the hub's, read from its checks; Test runs
// that step's checks now (setup_test), Skip for now keeps it for later (setup_skip), and a step's result is saved
// where it lives already (Settings › Hub accounts › Claude, › GitHub, …), which its place opens. Only owners and admins
// see any of it.

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { SetupListOutput, SetupStepId } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError, callKey } from "../../src/data/queries";
import { useDataLayer, useHub, useToolQuery } from "../../src/data/react";
import { Button, Text, cx } from "../../ui";
import { useHubRole } from "../admin/role";
import { errorText, useRefetch } from "../settings/hub";
import { revealNext } from "../settings/search";
import { navigate } from "../shell/navigation";
import { GuideParts, Part } from "./Guide";
import { groupWords, isRequiredLeft, needWords, placesOf, requiredLeft, statusWords, type SetupStep } from "./steps";
import s from "./setup.module.css";

const noInput = {};

const go = (view: string | null) => {
  window.location.hash = view === null ? "#/setup" : `#/setup/${view}`;
};

type Steps = { readonly steps: ReadonlyArray<SetupStep> } | { readonly problem: string; readonly old: boolean } | null;

/**
 * Asks the hub for its steps again each time a setup view opens: what was saved elsewhere meanwhile (Settings › Hub ›
 * Claude, `fleetd init`) shows at once, rather than at the doctor's next run.
 */
export function useFreshSetup(enabled = true) {
  const refetch = useRefetch();
  useEffect(() => {
    if (enabled) refetch(["setup_list"]);
  }, [enabled, refetch]);
}

/** The hub's steps; null while they load. */
export function useSetupSteps(): Steps {
  useFreshSetup();
  const query = useToolQuery("setup_list", noInput);
  if (query.data !== undefined) return { steps: query.data.steps };
  if (query.error === null) return null;
  return { problem: errorText(query.error), old: query.error instanceof CallError && lacksTool(query.error.error) };
}

/** Keeps a step the hub just answered with (Test, Skip) in the list, so every view of it agrees at once. */
function useKeep(): (step: SetupStep) => void {
  const data = useDataLayer();
  return (step) =>
    data.queryClient.setQueryData<SetupListOutput>(callKey("setup_list", noInput), (list) => {
      if (list === undefined) return list;
      const steps = list.steps.map((st) => (st.id === step.id ? step : st));
      return { ...list, steps, requiredLeft: requiredLeft(steps) };
    });
}

export function SetupScreen({ view }: { view: string | null }) {
  const role = useHubRole();
  const steps = useSetupSteps();
  if (!role.administers) {
    const text = role.pending ? "Loading…" : "Setting up the hub is for its owners and admins.";
    return <Note screen="setup.denied" text={text} />;
  }
  if (steps === null) return <Note screen="setup.loading" text="Loading…" />;
  if ("problem" in steps) return <Note screen="setup.error" text={steps.old ? "This hub is too old for guided setup. Update fleetd on the hub first." : steps.problem} />;
  if (view === "welcome") return <Welcome steps={steps.steps} />;
  if (view === "done") return <Done steps={steps.steps} />;
  return (
    <div className={s.screen} data-screen="setup">
      <div className={s.wide}>
        <header className={s.head}>
          <Text as="h1" size="lg" strong>
            Set up your hub
          </Text>
          <Text as="p" size="sm" tone="quiet">
            {progressLine(steps.steps)}
          </Text>
        </header>
        <SetupSteps steps={steps.steps} open={view} onOpen={go} onEnd={() => go("done")} />
      </div>
    </div>
  );
}

function Note({ screen, text }: { screen: string; text: string }) {
  return (
    <div className={s.screen} data-screen={screen}>
      <div className={s.narrow}>
        <Text tone="quiet">{text}</Text>
      </div>
    </div>
  );
}

export const progressLine = (steps: ReadonlyArray<SetupStep>): string => {
  const left = requiredLeft(steps);
  const done = steps.filter((st) => st.status === "done").length;
  const head = `${done} of ${steps.length} done`;
  return left === 0 ? `${head}. fleetd is ready to use; the rest can wait until you need it.` : `${head}. ${left} required before agents can run.`;
};

function StatusWord({ step }: { step: SetupStep }) {
  const words = statusWords(step.status);
  if (words === undefined) return null;
  const tone = step.status === "done" ? "success" : step.status === "look" ? (step.failing === true ? "danger" : "warning") : "faint";
  return (
    <Text size="xs" tone={tone} className={s.status}>
      {words}
    </Text>
  );
}

/**
 * The steps down the left, grouped, and the open one beside them: `open` names it, else the first not done. `onEnd`
 * is Continue past the last step.
 */
export function SetupSteps({
  steps,
  open,
  onOpen,
  onEnd,
}: {
  steps: ReadonlyArray<SetupStep>;
  open: string | null;
  onOpen: (id: SetupStepId) => void;
  onEnd?: () => void;
}) {
  // With none named, the first not done when the steps came: it stays open when its Test passes.
  const [first] = useState(() => steps.find((st) => st.status !== "done")?.id);
  const shown = steps.find((st) => st.id === open) ?? steps.find((st) => st.id === first) ?? steps[0];
  if (shown === undefined) return null;
  return (
    <div className={s.split}>
      <StepRail steps={steps} open={shown.id} onOpen={onOpen} />
      <StepPane key={shown.id} step={shown} steps={steps} onOpen={onOpen} onEnd={onEnd} />
    </div>
  );
}

function StepRail({ steps, open, onOpen }: { steps: ReadonlyArray<SetupStep>; open: SetupStepId; onOpen: (id: SetupStepId) => void }) {
  const groups = [...new Set(steps.map((st) => st.group))];
  return (
    <nav className={s.rail} aria-label="Setup steps">
      {groups.map((group) => (
        <section key={group} className={s.railGroup}>
          <Text as="h2" size="xs" tone="faint" className={s.railHead}>
            {groupWords(group)}
          </Text>
          <ol className={s.railList}>
            {steps
              .filter((st) => st.group === group)
              .map((st) => (
                <li key={st.id}>
                  <button
                    type="button"
                    className={cx(s.railRow, st.id === open && s.railOpen, st.status === "done" && s.railDone)}
                    aria-current={st.id === open ? "step" : undefined}
                    data-step={st.id}
                    onClick={() => onOpen(st.id)}
                  >
                    <span className={s.railTitle}>{st.title}</span>
                    {st.status === "todo" ? (
                      <Text size="xs" tone="faint" className={s.status}>
                        {needWords(st.need)}
                      </Text>
                    ) : (
                      <StatusWord step={st} />
                    )}
                  </button>
                </li>
              ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}

function StepPane({
  step,
  steps,
  onOpen,
  onEnd,
}: {
  step: SetupStep;
  steps: ReadonlyArray<SetupStep>;
  onOpen: (id: SetupStepId) => void;
  onEnd: (() => void) | undefined;
}) {
  const data = useDataLayer();
  const hub = useHub();
  const keep = useKeep();
  const [busy, setBusy] = useState<"test" | "skip" | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const index = steps.indexOf(step);
  const next = steps.slice(index + 1).find((st) => st.status !== "done");
  const onward = () => (next !== undefined ? onOpen(next.id) : onEnd?.());
  const test = async () => {
    setBusy("test");
    const out = await data.call("setup_test", { step: step.id }, { timeoutMs: 120_000 });
    setBusy(null);
    if (!out.ok) {
      setTested({ ok: false, text: out.error.message });
      return;
    }
    keep(out.output.step);
    setTested({ ok: out.output.step.status === "done", text: out.output.step.said ?? "Nothing answered for this step yet." });
  };
  const skip = async (skipped: boolean) => {
    setBusy("skip");
    const out = await data.call("setup_skip", { step: step.id, skipped });
    setBusy(null);
    if (!out.ok) {
      setTested({ ok: false, text: out.error.message });
      return;
    }
    keep(out.output.step);
    if (skipped) onward();
  };
  const places = placesOf(step);
  const left = isRequiredLeft(step);
  return (
    <article className={s.pane} aria-labelledby="setup-step-title" data-step={step.id}>
      <Text as="p" size="xs" tone="quiet">
        Step {index + 1} of {steps.length} · {needWords(step.need)}
      </Text>
      <Text as="h2" size="lg" strong id="setup-step-title">
        {step.title}
      </Text>
      <Text as="p" tone="quiet">
        {step.why}
      </Text>
      <Said step={step} />

      <GuideParts parts={step.parts} />

      {places.length === 0 && step.fieldsNote === undefined ? null : (
        <Part n={step.parts.length + 1} title="Save it in fleetd">
          {step.fieldsNote === undefined ? null : (
            <Text as="p" size="sm" tone="quiet">
              {step.fieldsNote}
            </Text>
          )}
          {places.length === 0 ? null : (
            <div className={s.links}>
              {places.map((place) => (
                <Button
                  key={place.label}
                  onClick={() => {
                    revealNext(place.reveal ?? null);
                    navigate({ ...place.screen, at: hub.id });
                  }}
                >
                  {place.label}
                </Button>
              ))}
            </div>
          )}
        </Part>
      )}

      {step.test === undefined ? null : (
        <div className={s.test}>
          <Button onClick={() => void test()} disabled={busy !== null}>
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          <Text size="sm" tone="quiet">
            {step.test}
          </Text>
          {tested === null ? null : (
            <Text as="p" size="sm" tone={tested.ok ? "success" : "danger"} className={s.tested}>
              {tested.ok ? <Check size={14} aria-hidden /> : null} {tested.text}
            </Text>
          )}
        </div>
      )}

      <footer className={s.foot}>
        {step.need.kind === "required" || step.status === "done" ? (
          <span />
        ) : step.status === "skipped" ? (
          <Button variant="ghost" onClick={() => void skip(false)} disabled={busy !== null}>
            Back on the list
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void skip(true)} disabled={busy !== null}>
            Skip for now
          </Button>
        )}
        {next === undefined && onEnd === undefined ? null : (
          <Button variant="primary" onClick={onward} disabled={busy !== null}>
            {next === undefined ? "Finish" : left ? "Continue anyway" : "Continue"}
          </Button>
        )}
      </footer>
    </article>
  );
}

/** What the step's checks say: the way in use when done, and why it wants a look. */
function Said({ step }: { step: SetupStep }) {
  if (step.status === "done") {
    return (
      <Text as="p" size="sm" tone="success">
        {step.way === undefined ? step.said : `Done with ${step.way}. ${step.said ?? ""}`}
      </Text>
    );
  }
  if (step.status !== "look" || step.said === undefined) return null;
  return (
    <Text as="p" size="sm" tone={step.failing === true ? "danger" : "warning"}>
      {step.said}
    </Text>
  );
}

/** The first run on a new hub: what setup is, what it asks for, and that only the required steps must be done now. */
export function Welcome({ steps }: { steps: ReadonlyArray<SetupStep> }) {
  const required = steps.filter((st) => st.need.kind === "required");
  const later = steps.filter((st) => st.need.kind !== "required");
  return (
    <div className={s.screen} data-screen="setup.welcome">
      <div className={s.narrow}>
        <Text as="h1" size="xl" strong>
          Your hub is running
        </Text>
        <Text as="p" tone="quiet">
          A few accounts and keys turn it into a factory. Each step says why, gives you the exact values to paste, and
          checks your work. Your progress is saved; stop at any point and come back, here, in Settings › Hub › Setup or
          with fleetd init.
        </Text>
        <StepSummary title="Needed before agents can run" steps={required} />
        <StepSummary title="When you need them" steps={later} brief />
        <div className={s.welcomeFoot}>
          <Button variant="primary" size="md" onClick={() => go(null)}>
            Start setup
          </Button>
          <Text size="sm" tone="quiet">
            A few minutes for what is required.
          </Text>
        </div>
      </div>
    </div>
  );
}

/** `brief`: a line a step, with when it is needed in place of why. */
function StepSummary({ title, steps, brief = false }: { title: string; steps: ReadonlyArray<SetupStep>; brief?: boolean }) {
  return (
    <section className={s.summary}>
      <Text as="h2" size="xs" tone="faint" className={s.railHead}>
        {title}
      </Text>
      <ul className={s.summaryList}>
        {steps.map((st) => (
          <li key={st.id} className={s.summaryRow}>
            <Text size="sm" strong={st.status !== "done"} tone={st.status === "done" ? "quiet" : "default"}>
              {st.title}
            </Text>
            {brief ? null : (
              <Text size="xs" tone="quiet" className={s.summaryWhy}>
                {st.why}
              </Text>
            )}
            {st.status === "todo" ? (
              <Text size="xs" tone="faint" className={s.status}>
                {needWords(st.need)}
              </Text>
            ) : (
              <StatusWord step={st} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The end: what is ready, and what waits in Settings › Hub › Setup for when it is needed. */
function Done({ steps }: { steps: ReadonlyArray<SetupStep> }) {
  const ready = steps.filter((st) => st.status === "done");
  const waiting = steps.filter((st) => st.status !== "done");
  const left = requiredLeft(steps);
  return (
    <div className={s.screen} data-screen="setup.done">
      <div className={s.narrow}>
        <Text as="h1" size="xl" strong>
          {left === 0 ? "fleetd is ready" : "Almost there"}
        </Text>
        <Text as="p" tone="quiet">
          {left === 0
            ? "Add a project and say hi to its lead. What you left for later waits in Settings › Hub › Setup, and fleetd asks for it the first time it is needed."
            : `${left} required ${left === 1 ? "step is" : "steps are"} left before agents can run.`}
        </Text>
        <StepSummary title="Ready" steps={ready} brief />
        {waiting.length === 0 ? null : <StepSummary title={left === 0 ? "Later" : "Left"} steps={waiting} brief />}
        <div className={s.welcomeFoot}>
          {left === 0 ? (
            <Button variant="primary" size="md" onClick={() => (window.location.hash = "#/projects/add")}>
              Add a project
            </Button>
          ) : (
            <Button variant="primary" size="md" onClick={() => go(steps.find(isRequiredLeft)?.id ?? null)}>
              Back to setup
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
