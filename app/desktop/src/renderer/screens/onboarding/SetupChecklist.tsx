import { Circle, CircleCheck } from "lucide-react";
import { useData } from "../../src/data/react";
import { selectConnection, selectProjectList } from "../../src/data/selectors";
import type { DataState } from "../../src/data/store";
import { Text } from "../../ui";
import { setupSteps, type SetupProgress } from "./setup";
import s from "./onboarding.module.css";

const saidHi = (d: DataState): boolean => Object.values(d.chatStates).some((c) => c.lastSeq > 0);
const hasProject = (d: DataState): boolean => (selectProjectList(d)?.length ?? 0) > 0;
const connected = (d: DataState): boolean => selectConnection(d).view === "live";

/**
 * The first-run checklist, ticked from the data layer (the connection, the project list, each chat's last message),
 * so it needs no reads of its own. Once every step is done it shows nothing, so a screen can always render it.
 */
export function SetupChecklist() {
  const progress: SetupProgress = {
    connected: useData(connected),
    project: useData(hasProject),
    saidHi: useData(saidHi),
  };
  const steps = setupSteps(progress);
  if (steps.every((step) => step.state === "done")) return null;
  return (
    <ol className={s.checklist} aria-label="Getting started">
      {steps.map((step) => (
        <li key={step.id} className={s.step} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
          {step.state === "done" ? (
            <CircleCheck role="img" aria-label="Done:" className={s.stepIcon} />
          ) : (
            <Circle aria-hidden className={s.stepIcon} />
          )}
          <Text tone={step.state === "todo" ? "quiet" : "default"} strong={step.state === "current"}>
            {step.label}
          </Text>
        </li>
      ))}
    </ol>
  );
}
