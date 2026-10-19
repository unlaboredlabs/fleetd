import { memo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Code, InlineCode } from "./Code";
import s from "./Markdown.module.css";

const REMARK = [remarkGfm];

/** The text inside a fenced block's <code> element (react-markdown hands it over as children). */
function fenceOf(children: ReactNode): { code: string; lang: string | null } | null {
  const el = Array.isArray(children) ? (children as ReactNode[])[0] : children;
  if (!el || typeof el !== "object" || !("props" in el)) return null;
  const props = (el as ReactElement<{ className?: string; children?: ReactNode }>).props;
  const lang = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? null;
  const kids = props.children;
  const code = typeof kids === "string" ? kids : Array.isArray(kids) ? kids.filter((k) => typeof k === "string").join("") : "";
  return { code, lang };
}

const COMPONENTS: Components = {
  pre: ({ children }) => {
    const fence = fenceOf(children);
    return fence ? <Code code={fence.code} lang={fence.lang} /> : <pre>{children}</pre>;
  },
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  // https links open in the user's browser (main's window-open handler); nothing navigates the app itself.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" title={href}>
      {children}
    </a>
  ),
  // No remote content: an image becomes its alt text as a link.
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noreferrer" title={src}>
        {alt || "image"}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  table: ({ children }) => (
    <div className={s.tableWrap}>
      <table>{children}</table>
    </div>
  ),
};

export interface MarkdownProps {
  /** The message or prompt as written (markdown). */
  source: string;
  className?: string;
  /** Show a Formatted/Raw switch, for places where "exactly as sent" matters (prompts, what an agent was told). */
  rawToggle?: boolean;
  /** Start in raw view. */
  initialRaw?: boolean;
}

/**
 * Rendered markdown (GFM: tables, task lists, strikethrough, autolinks). Raw HTML is dropped, never rendered.
 * Memoized on its props, so a message parses once and re-renders of the list around it cost nothing.
 */
export const Markdown = memo(function Markdown({ source, className, rawToggle, initialRaw = false }: MarkdownProps) {
  const [raw, setRaw] = useState(initialRaw);
  const body =
    raw && rawToggle ? (
      <pre className={s.raw} data-text="code">
        {source}
      </pre>
    ) : (
      <div className={cx(s.root, !rawToggle && className)} data-text="wrap">
        <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} skipHtml>
          {source}
        </ReactMarkdown>
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

