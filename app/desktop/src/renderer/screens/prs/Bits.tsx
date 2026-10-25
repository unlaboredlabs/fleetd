// Small pieces the PR list and the PR share: a checks mark (an icon with a short word), a quiet hint, and a
// segmented filter. Kept here until another screen needs them.
import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import { Text, cx } from "../../ui";
import type { Hint } from "./listModel";
import type { Tone } from "./words";
import s from "./prs.module.css";

const CHECK_ICON: Partial<Record<Tone, typeof CircleCheck>> = { failed: CircleX, working: CircleDashed, done: CircleCheck };

/** A check's state as an icon in its colour: passed, failed, running (or didn't run). */
export function CheckIcon({ tone, label }: { tone: Tone; label: string }) {
  const Icon = CHECK_ICON[tone] ?? CircleDashed;
  return (
    <span className={cx(s.checkIcon, tone === "failed" && s.checksFailed, tone === "done" && s.checksDone)}>
      <Icon role="img" aria-label={label} />
    </span>
  );
}

/** A checks word behind its icon, which says they are checks; the icon alone carries the colour, unless they failed. */
export function ChecksMark({ hint, label, size = "xs" }: { hint: Hint; label?: string | undefined; size?: "xs" | "sm" }) {
  return (
    <span className={s.checksMark} title={label}>
      <CheckIcon tone={hint.tone} label="Checks" />
      <Text size={size} tone={hint.tone === "failed" ? "danger" : size === "xs" ? "quiet" : "default"} tabular>
        {hint.text}
      </Text>
    </span>
  );
}

/** A review word, a fixer's place in line: quiet text, danger when it failed. */
export function HintText({ hint }: { hint: Hint }) {
  return (
    <Text size="xs" tone={hint.tone === "failed" ? "danger" : "quiet"}>
      {hint.text}
    </Text>
  );
}

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: ReactNode;
}

/** One of a few views of a list, as pressed buttons: each a tab stop, the pressed one plain to see. */
export function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: readonly SegmentOption<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className={s.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={s.segment} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          <Text size="sm" tone="inherit">
            {o.label}
          </Text>
          {o.count !== undefined ? (
            <Text size="xs" tone="inherit" tabular>
              {o.count}
            </Text>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** What a pane has instead of rows (none in a filter, an error): a line, a quieter one under it, and what to do. */
export function PaneEmpty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.paneEmpty}>
      <Text as="h2" size="md" strong>
        {title}
      </Text>
      {children !== undefined ? (
        <Text as="p" size="sm" tone="quiet">
          {children}
        </Text>
      ) : null}
      {action !== undefined ? <div className={s.paneEmptyAction}>{action}</div> : null}
    </div>
  );
}
