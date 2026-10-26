// A few choices side by side as pressed buttons (DESIGN.md, Controls): the PR list's filters, a machine's roles.
import type { ReactNode } from "react";
import s from "./Segmented.module.css";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: ReactNode;
}

/** One of a few views or values, as pressed buttons: each a tab stop, the pressed one plain to see. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={s.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={s.segment} aria-pressed={o.value === value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined ? <span className={s.segmentCount}>{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
