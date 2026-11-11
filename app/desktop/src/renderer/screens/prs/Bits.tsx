// Small pieces the PR list and the PR share: a checks mark (an icon with a short word) and a quiet hint. Kept here until
// another screen needs them. (The segmented filter moved to ui/primitives/Segmented once Settings → Machines needed it.)
import { CircleCheck, CircleDashed, CircleX } from "lucide-react";
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
