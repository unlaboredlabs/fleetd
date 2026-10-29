import type { ReactNode } from "react";
import { InlineCode } from "../../ui";
import { marks } from "./Exact";

/**
 * The lead's prose with its `backtick` spans as inline code, so file names, hosts and commands it quotes read as
 * code (and the QA raw-text rule, which exempts code, holds). Everything else stays plain text. Its hidden characters
 * show as marks, and the whole is isolated so its direction stays its own.
 */
export const prose = (text: string): ReactNode => {
  const parts = text.split(/`([^`\n]+)`/u);
  return <bdi dir="auto">{parts.map((part, i) => (i % 2 === 1 ? <InlineCode key={i}>{marks(part)}</InlineCode> : marks(part, true)))}</bdi>;
};
