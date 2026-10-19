import type { ElementType, ReactNode } from "react";
import { cx } from "../lib/cx";
import s from "./text.module.css";

export type TextSize = "xs" | "sm" | "md" | "lg" | "xl" | "display";
export type TextTone = "default" | "quiet" | "faint" | "accent" | "danger" | "success" | "warning" | "inherit";

export interface TextStyleProps {
  size?: TextSize | undefined;
  tone?: TextTone | undefined;
  strong?: boolean | undefined;
  /** The machine voice: commands, paths, logs. Never for human sentences. */
  mono?: boolean | undefined;
  /** Tabular figures for counts and durations that change in place. */
  tabular?: boolean | undefined;
}

export function textClass({ size = "md", tone = "default", strong, mono, tabular }: TextStyleProps): string {
  return cx(s[size], s[tone], strong ? s.strong : s.regular, mono && s.mono, tabular && s.tabular);
}

export interface TextProps extends TextStyleProps {
  as?: ElementType;
  /** Keep the author's line breaks (messages, prompts). */
  preserveLines?: boolean;
  className?: string | undefined;
  id?: string;
  title?: string;
  children?: ReactNode;
}

/**
 * Body text. It always wraps, including long unbroken runs (URLs, paths), and can shrink inside flex and grid
 * rows. Use it for anything someone reads in full: criteria, questions, messages, descriptions.
 */
export function Text({ as: As = "span", preserveLines, className, children, ...rest }: TextProps) {
  const { size, tone, strong, mono, tabular, ...attrs } = rest;
  return (
    <As
      data-text="wrap"
      className={cx(s.text, preserveLines && s.pre, textClass({ size, tone, strong, mono, tabular }), className)}
      {...attrs}
    >
      {children}
    </As>
  );
}
