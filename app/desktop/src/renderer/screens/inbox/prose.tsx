import type { ReactNode } from "react";
import { InlineCode } from "../../ui";

/**
 * The lead's prose with its `backtick` spans as inline code, so file names, hosts and commands it quotes read as
 * code (and the QA raw-text rule, which exempts code, holds). Everything else stays plain text.
 */
export const prose = (text: string): ReactNode => {
  const parts = text.split(/`([^`\n]+)`/u);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (i % 2 === 1 ? <InlineCode key={i}>{part}</InlineCode> : part));
};
