// A step's words (shared/steps.ts) as drawn: the human voice, and its machine text (a file's name, a site, a search,
// in backticks there) in the machine voice, as the design's two voices have it.
import s from "./stepText.module.css";

/** A step's words with its machine text unmarked (shared/steps.ts plainStep, kept here so the first chat needn't load
 * the labeller for it): for a tooltip and a screen reader. */
export const plainWords = (text: string): string => text.replace(/`/gu, "");

export function StepText({ text }: { text: string }) {
  const runs = text.split("`");
  if (runs.length < 3) return <>{text}</>;
  return (
    <>
      {runs.map((run, i) =>
        run === "" ? null : i % 2 === 1 ? (
          <code key={i} className={s.code}>
            {run}
          </code>
        ) : (
          run
        ),
      )}
    </>
  );
}
