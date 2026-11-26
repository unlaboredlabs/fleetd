// The plain-words labeller (shared/steps.ts) for what the first chat draws, loaded once the chat has painted rather
// than with the first load (scripts/web-check.ts's budget): about 9 KB gzip that only says what the lead and its
// agents do now. Until it comes, a moment after the first paint, the working row says "Working" or "Thinking" and the
// agents' lines say "working": what the hub said, in fewer words. useStepWords draws again once it is here.
import { useSyncExternalStore } from "react";
import type { Activity } from "../../shared/contracts";
import type * as StepsModule from "../../shared/steps";
import { afterFirstPaint } from "../ui";

type Steps = typeof StepsModule;

let steps: Steps | undefined;
const waiting = new Set<() => void>();

/** Loads the labeller (once). */
export const loadStepWords = (): Promise<Steps> =>
  import("../../shared/steps").then((m) => {
    if (steps === undefined) {
      steps = m;
      for (const f of waiting) f();
    }
    return m;
  });

void afterFirstPaint().then(loadStepWords);

/** What it does now in plain words ("Editing index.html"), once the labeller is here; undefined until then, and while
 * it only thinks or writes. */
export const activityWords = (a: Activity): string | undefined => steps?.activityLabel(a);

/** The labeller once it is here, else undefined: a component that says steps draws again once it is. */
export const useStepWords = (): Steps | undefined =>
  useSyncExternalStore(
    (f) => {
      waiting.add(f);
      return () => waiting.delete(f);
    },
    () => steps,
  );
