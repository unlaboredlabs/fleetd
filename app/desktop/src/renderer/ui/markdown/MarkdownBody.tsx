// The markdown parser (react-markdown, remark-gfm, micromark): about half the design system's code, so Markdown loads
// it on first use rather than with the app.
import type { ReactElement, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "../primitives/Toast";
import { Code, InlineCode } from "./Code";
import s from "./Markdown.module.css";

const REMARK = [remarkGfm];

/**
 * A link that main opens in the browser (window.fleetd.openExternal decides which hosts; nothing navigates the app).
 * A refused link says why in a toast. A link without a web address (react-markdown blanks unsafe schemes) is text.
 */
function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        void window.fleetd.openExternal(href).then((outcome) => {
          if (!outcome.ok) toast({ title: "Link not opened", description: outcome.message, tone: "warning", key: "link-refused" });
        });
      }}
    >
      {children}
    </a>
  );
}

/** The text inside a fenced block's <code> element (react-markdown hands it over as children). */
function fenceOf(children: ReactNode): { code: string; lang: string | null } | null {
  const el = Array.isArray(children) ? (children as ReactNode[])[0] : children;
  if (!el || typeof el !== "object" || !("props" in el)) return null;
  const props = (el as ReactElement<{ className?: string | undefined; children?: ReactNode }>).props;
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
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  // No remote content: an image becomes its alt text as a link.
  img: ({ src, alt }) => <ExternalLink href={typeof src === "string" ? src : undefined}>{alt || "image"}</ExternalLink>,
  table: ({ children }) => (
    <div className={s.tableWrap}>
      <table>{children}</table>
    </div>
  ),
};

export default function MarkdownBody({ source }: { source: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} components={COMPONENTS} skipHtml>
      {source}
    </ReactMarkdown>
  );
}
