import { lazy, memo, Suspense, useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import s from "./Markdown.module.css";

const MarkdownBody = lazy(() => import("./MarkdownBody"));

export interface MarkdownProps {
  /** The message or prompt as written (markdown). */
  source: string;
  className?: string | undefined;
  /** Show a Formatted/Raw switch, for places where "exactly as sent" matters (prompts, what an agent was told). */
  rawToggle?: boolean;
  /** Start in raw view. */
  initialRaw?: boolean;
  /**
   * On (the default): a fleetd-block fence that reaches markdown is a lead's block that didn't show, drawn as a
   * small chip, never its JSON. Off for words a person wrote, where it is code like any other.
   */
  blocks?: boolean;
}

/**
 * Rendered markdown (GFM: tables, task lists, strikethrough, autolinks). Raw HTML is dropped, never rendered.
 * Memoized on its props, so a message parses once and re-renders of the list around it cost nothing.
 */
export const Markdown = memo(function Markdown({ source, className, rawToggle, initialRaw = false, blocks = true }: MarkdownProps) {
  const [raw, setRaw] = useState(initialRaw);
  const body =
    raw && rawToggle ? (
      <pre className={s.raw} data-text="code">
        {source}
      </pre>
    ) : (
      <div className={cx(s.root, !rawToggle && className)} data-text="wrap">
        {/* aria-busy until the parser has loaded, which the QA gate waits out. */}
        <Suspense fallback={<div aria-busy="true" />}>
          <MarkdownBody source={source} blocks={blocks} />
        </Suspense>
      </div>
    );
  if (!rawToggle) return body;
  return (
    <div className={cx(s.frame, className)}>
      <div className={s.toggle}>
        <Button variant="quiet" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
          {raw ? "Formatted" : "Raw"}
        </Button>
      </div>
      {body}
    </div>
  );
});

