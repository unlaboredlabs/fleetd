// #/setup: the hub admin's setup, a design prototype (docs/design/setup.md). The welcome, the steps with one open
// beside them, and the end. Each step's status comes from doctor_list; Test re-runs the checks and says what the
// step's check says now. Nothing is saved yet: the hub's setup_save comes with the build.

import { Check } from "lucide-react";
import { useState } from "react";
import { callKey } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Field, Input, Text, Textarea, cx } from "../../ui";
import { GuideParts, Part } from "./Guide";
import { useHubState } from "../onboarding/hooks";
import { needWords, requiredLeft, setupSteps, type SetupStep, type StepId, type StepStatus } from "./steps";
import s from "./setup.module.css";

export type SetupView = "welcome" | "done" | StepId | null;

const allChecks = {};

const go = (view: SetupView) => {
  window.location.hash = view === null ? "#/setup" : `#/setup/${view}`;
};

const useSteps = (): { steps: ReadonlyArray<SetupStep>; hub: string } => {
  const state = useHubState();
  const hub = state.phase === "unpaired" ? "http://127.0.0.1:4790" : state.hub;
  const query = useToolQuery("doctor_list", allChecks);
  return { steps: setupSteps(hub, query.data?.checks ?? []), hub };
};

export function SetupScreen({ view }: { view: string | null }) {
  const { steps, hub } = useSteps();
  if (view === "welcome") return <Welcome steps={steps} />;
  if (view === "done") return <Done steps={steps} />;
  const open = steps.find((step) => step.id === view) ?? steps.find((step) => step.status !== "done") ?? steps[0];
  if (open === undefined) return null;
  return (
    <div className={s.screen} data-screen="setup">
      <div className={s.wide}>
        <header className={s.head}>
          <Text as="h1" size="lg" strong>
            Set up your hub
          </Text>
          <Text as="p" size="sm" tone="quiet">
            {progressLine(steps)}
          </Text>
        </header>
        <div className={s.split}>
          <StepRail steps={steps} open={open.id} />
          <StepPane key={open.id} step={open} steps={steps} hub={hub} />
        </div>
      </div>
    </div>
  );
}

const progressLine = (steps: ReadonlyArray<SetupStep>): string => {
  const left = requiredLeft(steps);
  const done = steps.filter((st) => st.status === "done").length;
  const head = `${done} of ${steps.length} done`;
  return left === 0 ? `${head}. fleetd is ready to use; the rest can wait until you need it.` : `${head}. ${left} required before agents can run.`;
};

const STATUS_WORD: Readonly<Record<StepStatus, string>> = { done: "Done", todo: "", look: "Needs a look", skipped: "Later" };

function StatusWord({ status }: { status: StepStatus }) {
  if (status === "todo") return null;
  const tone = status === "done" ? "success" : status === "look" ? "warning" : "faint";
  return (
    <Text size="xs" tone={tone} className={s.status}>
      {STATUS_WORD[status]}
    </Text>
  );
}

function StepRail({ steps, open }: { steps: ReadonlyArray<SetupStep>; open: StepId }) {
  const groups = [...new Set(steps.map((st) => st.group))];
  return (
    <nav className={s.rail} aria-label="Setup steps">
      {groups.map((group) => (
        <section key={group} className={s.railGroup}>
          <Text as="h2" size="xs" tone="faint" className={s.railHead}>
            {group}
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
                    onClick={() => go(st.id)}
                  >
                    <span className={s.railTitle}>{st.title}</span>
                    {st.status === "todo" ? (
                      <Text size="xs" tone="faint" className={s.status}>
                        {needWords(st.need)}
                      </Text>
                    ) : (
                      <StatusWord status={st.status} />
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

function StepPane({ step, steps, hub }: { step: SetupStep; steps: ReadonlyArray<SetupStep>; hub: string }) {
  const data = useDataLayer();
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const index = steps.indexOf(step);
  const next = steps.slice(index + 1).find((st) => st.status !== "done");
  const test = async () => {
    setTesting(true);
    const out = await data.call("doctor_list", { rerun: true }, { timeoutMs: 120_000 });
    setTesting(false);
    if (!out.ok) {
      setTested({ ok: false, text: out.error.message });
      return;
    }
    data.queryClient.setQueryData(callKey("doctor_list", allChecks), out.output);
    const now = setupSteps(hub, out.output.checks).find((st) => st.id === step.id);
    setTested({ ok: now?.status === "done", text: now?.said ?? "No check answered for this step yet." });
  };
  return (
    <article className={s.pane} aria-labelledby="setup-step-title">
      <Text as="p" size="xs" tone="quiet">
        Step {index + 1} of {steps.length} · {needWords(step.need)}
      </Text>
      <Text as="h2" size="lg" strong id="setup-step-title">
        {step.title}
      </Text>
      <Text as="p" tone="quiet">
        {step.why}
      </Text>
      {step.way === undefined ? null : (
        <Text as="p" size="sm" tone={step.status === "done" ? "success" : "quiet"}>
          {step.status === "done" ? `Done with ${step.way}.` : `Using ${step.way}.`}
        </Text>
      )}
      {step.status === "look" && step.said !== undefined ? (
        <Text as="p" size="sm" tone="warning">
          {step.said}
        </Text>
      ) : null}

      <GuideParts parts={step.parts} />

      {step.fields.length === 0 ? null : (
        <Part n={step.parts.length + 1} title="Paste what you get back">
          <div className={s.fields}>
            {step.fields.map((f) => (
              <Field
                key={f.name}
                label={f.optional === true ? `${f.label} (optional)` : f.label}
                description={f.note ?? (f.secret === true ? "Sealed on this device; the hub keeps only its fingerprint." : undefined)}
              >
                {f.multiline === true ? (
                  <Textarea mono minRows={3} placeholder={f.placeholder} spellCheck={false} autoComplete="off" />
                ) : (
                  <Input type={f.secret === true ? "password" : "text"} placeholder={f.placeholder} spellCheck={false} autoComplete="off" />
                )}
              </Field>
            ))}
          </div>
          {step.fieldsNote === undefined ? null : (
            <Text as="p" size="sm" tone="quiet">
              {step.fieldsNote}
            </Text>
          )}
        </Part>
      )}

      {step.test === undefined ? null : (
        <div className={s.test}>
          <Button onClick={() => void test()} disabled={testing}>
            {testing ? "Testing…" : "Test"}
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
        {step.need.kind === "required" ? (
          <span />
        ) : (
          <Button variant="ghost" onClick={() => go(next?.id ?? "done")}>
            Skip for now
          </Button>
        )}
        <Button variant="primary" onClick={() => go(next?.id ?? "done")}>
          {next === undefined ? "Finish" : "Continue"}
        </Button>
      </footer>
    </article>
  );
}

/** The first run on a new hub: what setup is, what it asks for, and that only three steps must be done now. */
function Welcome({ steps }: { steps: ReadonlyArray<SetupStep> }) {
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
          checks your work. Your progress is saved; stop at any point and come back.
        </Text>
        <StepSummary title="Needed before agents can run" steps={required} />
        <StepSummary title="When you need them" steps={later} brief />
        <div className={s.welcomeFoot}>
          <Button variant="primary" size="md" onClick={() => go(null)}>
            Start setup
          </Button>
          <Text size="sm" tone="quiet">
            A few minutes for what is required. Google takes longest, and can wait.
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
            {brief && st.status === "todo" ? (
              <Text size="xs" tone="faint" className={s.status}>
                {needWords(st.need)}
              </Text>
            ) : (
              <StatusWord status={st.status} />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The end: what is ready, and what waits in Administration › Setup for when it is needed. */
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
            ? "Add a project and say hi to its lead. What you left for later waits in Administration › Setup, and fleetd asks for it the first time it is needed."
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
            <Button variant="primary" size="md" onClick={() => go(waiting.find((st) => st.need.kind === "required")?.id ?? null)}>
              Back to setup
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
