// A list's folds: the groups at a list's end that hold what is over or elsewhere (merged pull requests, done to-dos,
// screens that ended, the other projects' agents), one quiet line each with how many, which opens them in place. Where
// a second row of tabs or a filter used to choose between "open" and "the rest", the list now has both, the rest
// folded. What you unfolded stays so while the app runs, per project.
import { ChevronRight } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { cx } from "../../ui";
import s from "./folds.module.css";

const open = new Map<string, boolean>();

/** Forgets every fold (tests start folded). */
export const forgetFolds = (): void => open.clear();

/** Whether the fold `key` is open, and its toggle; `initial` until you choose. */
export function useFold(key: string, initial = false): readonly [boolean, () => void, (next: boolean) => void] {
  const [, bump] = useState(0);
  const now = open.get(key) ?? initial;
  const set = useCallback(
    (next: boolean) => {
      open.set(key, next);
      bump((n) => n + 1);
    },
    [key],
  );
  const toggle = useCallback(() => set(!(open.get(key) ?? initial)), [key, initial, set]);
  return [now, toggle, set];
}

/** A group's quiet label with how many, and whatever sits at its end (an add button). */
export function GroupLabel({ label, count, tone, end, id }: { label: string; count?: number | undefined; tone?: "warning" | undefined; end?: ReactNode; id?: string }) {
  return (
    <div className={s.group} id={id} data-group-label="">
      <span className={cx(s.label, tone === "warning" && s.warning)} role="heading" aria-level={3}>
        {label}
      </span>
      {count !== undefined && count > 0 ? <span className={s.count}>{count}</span> : null}
      {end === undefined ? null : <span className={s.end}>{end}</span>}
    </div>
  );
}

/** A fold's line: a group's label that opens and closes what is under it. */
export function FoldLine({ label, count, open: isOpen, onToggle, end }: { label: string; count?: number | undefined; open: boolean; onToggle: () => void; end?: ReactNode }) {
  return (
    <div className={s.group} data-group-label="">
      <button type="button" className={s.fold} aria-expanded={isOpen} onClick={onToggle}>
        <ChevronRight aria-hidden className={cx(s.chevron, isOpen && s.chevronOpen)} />
        <span className={s.label}>{label}</span>
        {count !== undefined && count > 0 ? <span className={s.count}>{count}</span> : null}
      </button>
      {end === undefined ? null : <span className={s.end}>{end}</span>}
    </div>
  );
}

/** One quiet line where a list's own rows would be, when it has none and something follows ("Nothing open."). */
export function ListNote({ children }: { children: ReactNode }) {
  return (
    <p className={s.note} data-list-note="">
      {children}
    </p>
  );
}

/** A tab with nothing in it: one short line in the middle of it, and at most the one thing to do about it. */
export function PanelEmpty({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className={s.empty} data-panel-empty="">
      <h2 className={s.emptyTitle}>{title}</h2>
      {actions === undefined ? null : <div className={s.emptyActions}>{actions}</div>}
    </div>
  );
}
