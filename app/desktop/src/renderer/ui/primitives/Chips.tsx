import type { CSSProperties } from "react";
import { cx } from "../lib/cx";
import { Truncate } from "../text/Truncate";
import s from "./Misc.module.css";

/**
 * The status vocabulary (live/chips.rs): amber means "needs you", danger only on failure words, and everything
 * that is just working stays quiet.
 */
export type StatusTone = "needs-you" | "failed" | "working" | "quiet" | "idle" | "done";

const DOT: Record<StatusTone, string> = {
  "needs-you": "var(--warning)",
  failed: "var(--danger)",
  working: "var(--text)",
  quiet: "var(--quiet)",
  idle: "var(--faint)",
  done: "var(--success)",
};

/** A 6 px state dot. */
export function Dot({ color, label }: { color: string; label?: string }) {
  return (
    <span
      className={s.dot}
      style={{ color }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    />
  );
}

/** A dot plus a short status word. Needs-you is set in full-weight text; failure words are danger. */
export function StatusChip({ tone, children }: { tone: StatusTone; children: string }) {
  return (
    <span
      className={cx(s.chip, tone === "needs-you" && s.strong)}
      style={tone === "failed" ? { color: "var(--danger)" } : undefined}
    >
      <Dot color={DOT[tone]} />
      <Truncate expand="none" size="xs" tone="inherit" strong={tone === "needs-you"}>
        {children}
      </Truncate>
    </span>
  );
}

export type AgentRole = "lead" | "implementer" | "reader" | "reviewer" | "verifier" | "qa";

/** One tint per role: workers (implementers, readers), reviewers, verifiers (and QA), the lead. */
export function roleTint(role: AgentRole): string {
  switch (role) {
    case "implementer":
    case "reader":
      return "var(--role-implementer)";
    case "reviewer":
      return "var(--role-reviewer)";
    case "verifier":
    case "qa":
      return "var(--role-verifier)";
    case "lead":
      return "var(--role-lead)";
  }
}

/** The role word in its tint; give it a fixed width in a lane so the activity column lines up. */
export function RoleTag({ role, width, children }: { role: AgentRole; width?: number; children?: string }) {
  const style: CSSProperties = { color: roleTint(role), ...(width ? { width, flex: "none" } : {}) };
  return (
    <span className={s.chip} style={style}>
      <Truncate expand="none" size="xs" tone="inherit">
        {children ?? role}
      </Truncate>
    </span>
  );
}

export function Separator({ orientation = "horizontal" }: { orientation?: "horizontal" | "vertical" }) {
  return <hr className={s.separator} data-orientation={orientation} aria-orientation={orientation} />;
}
