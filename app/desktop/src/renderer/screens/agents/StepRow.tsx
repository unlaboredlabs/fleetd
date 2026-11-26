// One step in plain words (shared/steps.ts), as every step log draws it: an agent's page, a finished agent's, the
// lead's recent steps under the working row. What it did, in the human voice ("Edited index.html"); "failed" after it,
// in the danger colour, only when it failed. A step with more to it (the whole command, the path, a failed command's
// last output) opens in place on a click or Enter, in the machine voice; a second one folds it. A thought reads as
// quiet prose, whole.
import { useId, useState } from "react";
import type { StepLabel } from "../../../shared/steps";
import { cx } from "../../ui";
import { StepText } from "./StepText";
import s from "./steps.module.css";

export function StepRow({ label, output, time }: { label: StepLabel; output?: string | undefined; time?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  // The last lines a failed command printed: why it failed, in its own words.
  const tail = label.failed === undefined ? undefined : lastLines(output);
  const more = label.raw !== undefined || tail !== undefined;
  const words = (
    <>
      <span className={cx(s.text, label.prose === true && s.prose)}>
        <StepText text={label.text} />
      </span>
      {label.failed === undefined ? null : <span className={s.failed}>{label.failed}</span>}
      {time === undefined ? null : <span className={s.time}>{time}</span>}
    </>
  );
  return (
    <div className={s.step} data-step={label.failed !== undefined ? "failed" : label.running === true ? "running" : undefined}>
      {more ? (
        <button type="button" className={s.line} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
          {words}
        </button>
      ) : (
        <div className={s.line}>{words}</div>
      )}
      {open && more ? (
        <div id={id} className={s.more}>
          {label.raw === undefined ? null : <code className={s.raw}>{label.raw}</code>}
          {tail === undefined ? null : <code className={s.output}>{tail}</code>}
        </div>
      ) : null}
    </div>
  );
}

/** A command's last few lines, trimmed: what it said as it stopped. */
const lastLines = (output: string | undefined): string | undefined => {
  const lines = (output ?? "").trimEnd().split("\n");
  const kept = lines.slice(-6).join("\n").trim();
  return kept === "" ? undefined : kept;
};
