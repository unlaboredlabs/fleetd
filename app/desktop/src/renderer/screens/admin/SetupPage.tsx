// Settings › Hub › Setup: the hub's setup steps (setup_list), the same ones `fleetd init` and the first run walk, as
// only what is left: a row per step not done, with when it is needed, which opens the step's guide (its paste values,
// where its result is saved, its Test) in place of the list, the way back in the window's top row. Steps that are done
// fold into one quiet line, which shows them again to change a value or test one. With every step done the page is
// that line alone. The open step is this page's own: the route names only the page.
import { useCallback, useMemo, useState } from "react";
import type { SetupStepId } from "../../../shared/contracts";
import { Button, Text } from "../../ui";
import { PageFrame, PageHead, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { StepGuide, useSetupSteps } from "../setup/SetupScreen";
import { needWords, requiredLeft, type SetupStep } from "../setup/steps";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

export function SetupPage() {
  const steps = useSetupSteps();
  const [open, setOpen] = useState<SetupStepId | null>(null);
  const [folded, setFolded] = useState(true);
  const back = useCallback(() => setOpen(null), []);
  if (steps === null || "problem" in steps) {
    const text = steps === null ? "Loading…" : steps.old ? "This hub is too old for guided setup. Update fleetd on the hub first." : steps.problem;
    return (
      <div className={s.scroll} data-screen={steps === null ? "settings.hub.setup.loading" : "settings.hub.setup.error"}>
        <div className={s.column}>
          <PageHead title="Setup">
            <Text tone={steps === null || steps.old ? "quiet" : "danger"}>{text}</Text>
          </PageHead>
        </div>
      </div>
    );
  }
  const shown = steps.steps.find((st) => st.id === open);
  if (shown !== undefined) return <StepPage step={shown} onBack={back} />;
  const left = steps.steps.filter((st) => st.status !== "done");
  const done = steps.steps.filter((st) => st.status === "done");
  const required = requiredLeft(steps.steps);
  const rows = (of: ReadonlyArray<SetupStep>) => of.map((st) => <StepRow key={st.id} step={st} onOpen={() => setOpen(st.id)} />);
  return (
    <div className={s.scroll} data-screen="settings.hub.setup">
      <div className={s.column}>
        <PageHead title="Setup">{required === 0 ? null : `${required} required before agents can run.`}</PageHead>
        {left.length === 0 ? null : (
          <SettingsSection>
            <SettingsList label="Steps left">{rows(left)}</SettingsList>
          </SettingsSection>
        )}
        {done.length === 0 ? null : (
          <SettingsSection
            data={{ "data-done": String(done.length) }}
            intro={
              <span className={a.doneLine}>
                {left.length === 0 ? "Everything is set up." : `${done.length} done.`}
                <Button variant="link" size="sm" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
                  {folded ? "Show steps" : "Hide steps"}
                </Button>
              </span>
            }
          >
            {folded ? null : <SettingsList label="Steps done">{rows(done)}</SettingsList>}
          </SettingsSection>
        )}
      </div>
    </div>
  );
}

/** A step as one row: its name, and when it is needed or that it wants a look; the row opens its guide. */
function StepRow({ step, onOpen }: { step: SetupStep; onOpen: () => void }) {
  return (
    <SettingsListRow
      name={step.title}
      label={step.title}
      meta={step.status === "todo" ? needWords(step.need) : undefined}
      state={step.status === "look" ? { word: "Needs a look", tone: step.failing === true ? "danger" : "warning" } : undefined}
      open={{ onClick: onOpen }}
      data={{ "data-step": step.id, "data-status": step.status }}
    />
  );
}

/** One step's guide, in place of the list: its name and the way back in the window's top row. */
function StepPage({ step, onBack }: { step: SetupStep; onBack: () => void }) {
  const frame = useMemo(
    () => ({
      title: step.title,
      lead: (
        <Button variant="ghost" size="sm" onClick={onBack}>
          ‹ Setup
        </Button>
      ),
    }),
    [step.title, onBack],
  );
  return (
    <PageFrame.Provider value={frame}>
      <div className={s.scroll} data-screen="settings.hub.setup.step">
        <div className={s.column}>
          <PageHead title={step.title} />
          <SettingsSection bare>
            <StepGuide step={step} />
          </SettingsSection>
        </div>
      </div>
    </PageFrame.Provider>
  );
}
