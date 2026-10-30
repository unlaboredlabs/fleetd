// The markdown parser (react-markdown, remark-gfm, micromark): about half the design system's code, so Markdown loads
// it on first use rather than with the app.
import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ContextMenu, ContextMenuCopy, ContextMenuItem } from "../primitives/ContextMenu";
import { toast } from "../primitives/Toast";
import { markdownBlocks } from "./blocks";
import { BLOCK_FENCE } from "../../../shared/contracts";
import { Code, InlineCode, Unshown } from "./Code";
import s from "./Markdown.module.css";

const REMARK = [remarkGfm];

const openLink = (href: string): void => {
  void window.fleetd.openExternal(href).then((outcome) => {
    if (!outcome.ok) toast({ title: "Link not opened", description: outcome.message, tone: "warning", key: "link-refused" });
  });
};

/**
 * A link that main opens in the browser (window.fleetd.openExternal decides which links; nothing navigates the app).
 * A refused link says why in a toast. A link without a web address (react-markdown blanks unsafe schemes) is text.
 * Its right-click menu opens or copies it.
 */
function ExternalLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
  return (
    <ContextMenu
      menu={() => (
        <>
          <ContextMenuItem onSelect={() => openLink(href)}>Open link</ContextMenuItem>
          <ContextMenuCopy text={href}>Copy link</ContextMenuCopy>
        </>
      )}
    >
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault();
          openLink(href);
        }}
      >
        {children}
      </a>
    </ContextMenu>
  );
}

/** An app route (a PR in the panel, chat/format prLinks): the hash router follows it, and its menu opens it. */
function AppLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <ContextMenu menu={() => <ContextMenuItem onSelect={() => (window.location.hash = href)}>Open link</ContextMenuItem>}>
      <a href={href}>{children}</a>
    </ContextMenu>
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

/** A fenced block as code; with `blocks` (unless a person wrote the words), a fleetd-block fence as its chip. */
const pre =
  (blocks: boolean) =>
  ({ children }: { children?: ReactNode }) => {
    const fence = fenceOf(children);
    if (blocks && fence?.lang === BLOCK_FENCE) return <Unshown code={fence.code} />;
    return fence ? <Code code={fence.code} lang={fence.lang} /> : <pre>{children}</pre>;
  };

const COMPONENTS: Components = {
  pre: pre(false),
  code: ({ children }) => <InlineCode>{children}</InlineCode>,
  // An app route stays in the app.
  a: ({ href, children }) => (href?.startsWith("#/") ? <AppLink href={href}>{children}</AppLink> : <ExternalLink href={href}>{children}</ExternalLink>),
  // No remote content: an image becomes its alt text as a link.
  img: ({ src, alt }) => <ExternalLink href={typeof src === "string" ? src : undefined}>{alt || "image"}</ExternalLink>,
  table: ({ children }) => (
    <div className={s.tableWrap}>
      <table>{children}</table>
    </div>
  ),
};

const WITH_BLOCKS: Components = { ...COMPONENTS, pre: pre(true) };

const Block = memo(function Block({ source, blocks }: { source: string; blocks: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} components={blocks ? WITH_BLOCKS : COMPONENTS} skipHtml>
      {source}
    </ReactMarkdown>
  );
});

/** Block by block: a reply streaming in re-parses only its last block, the one still growing. */
export default function MarkdownBody({ source, blocks = true }: { source: string; blocks?: boolean }) {
  const parts = useMemo(() => markdownBlocks(source), [source]);
  // By position: a streaming message only grows at its end, so every block before the last keeps its key and text.
  return parts.map((b, i) => <Block key={i} source={b} blocks={blocks} />);
}
