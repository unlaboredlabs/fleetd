// The markdown parser (react-markdown, remark-gfm, micromark): about half the design system's code, so Markdown loads
// it on first use rather than with the app.
import { memo, useMemo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ContextMenu, ContextMenuCopy, ContextMenuItem } from "../primitives/ContextMenu";
import { toast } from "../primitives/Toast";
import { markdownBlocks } from "./blocks";
import { BLOCK_FENCE } from "../../../shared/contracts";
import { refOf, splitRefs, type Ref } from "../../../shared/refs";
import { RefMark } from "../text/Refs";
import { Code, InlineCode, Unshown } from "./Code";
import s from "./Markdown.module.css";

/** A markdown tree's node, as far as `softBreaks` and `refLinks` read it. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/**
 * Each line break inside a paragraph shows as one, as a chat writes it (remark-breaks' rule, and the phone's bubbles):
 * the text's newlines become `break` nodes. Code keeps its own lines; it is never a `text` node.
 */
const softBreaks = () => (tree: Node) => {
  const walk = (node: Node): void => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child): Node[] => {
      if (child.type !== "text" || child.value?.includes("\n") !== true) {
        walk(child);
        return [child];
      }
      return child.value.split(/\r?\n/u).flatMap((line, i): Node[] => [...(i === 0 ? [] : [{ type: "break" }]), ...(line === "" ? [] : [{ type: "text", value: line }])]);
    });
  };
  walk(tree);
};

/** A ref link's address: `#ref=T12`, `#ref=T12&opens` where it opens a sentence. Never a route: `a` draws it. */
const REF_HREF = "#ref=";
const refLink = (r: Ref): Node => ({ type: "link", url: `${REF_HREF}${r.id}${r.opens ? "&opens" : ""}`, children: [{ type: "text", value: r.id }] });

/**
 * fleetd's ids in the words (T12, W3: shared/refs) as ref links, which `a` draws as the app's chips; an inline code span
 * that is one id alone too. Links keep their words, and code blocks are never text nodes.
 */
const refLinks = () => (tree: Node) => {
  const walk = (node: Node): void => {
    if (node.children === undefined || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child): Node[] => {
      // A code span of one agent or order id; one of `F12` is a key as often as a file, so stays code.
      const kind = child.type === "inlineCode" && child.value !== undefined ? refOf(child.value) : undefined;
      if (kind === "agent" || kind === "order") return [refLink({ id: (child.value ?? "").trim(), kind, opens: false })];
      if (child.type !== "text" || child.value === undefined) {
        walk(child);
        return [child];
      }
      const runs = splitRefs(child.value);
      if (runs.length === 1 && typeof runs[0] === "string") return [child];
      return runs.map((r): Node => (typeof r === "string" ? { type: "text", value: r } : refLink(r)));
    });
  };
  walk(tree);
};

/** A ref link's id back, from its address. */
const refOfHref = (href: string): Ref | undefined => {
  const [id = "", flag] = href.slice(REF_HREF.length).split("&");
  const kind = refOf(id);
  return kind === undefined ? undefined : { id, kind, opens: flag === "opens" };
};

const REMARK = [remarkGfm, refLinks];
const REMARK_BREAKS = [remarkGfm, softBreaks, refLinks];

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
  // An app route stays in the app; a ref link is the app's chip for the id.
  a: ({ href, children }) => {
    const ref = href?.startsWith(REF_HREF) === true ? refOfHref(href) : undefined;
    if (ref !== undefined) return <RefMark of={ref} />;
    return href?.startsWith("#/") ? <AppLink href={href}>{children}</AppLink> : <ExternalLink href={href}>{children}</ExternalLink>;
  },
  // No remote content: an image becomes its alt text as a link.
  img: ({ src, alt }) => <ExternalLink href={typeof src === "string" ? src : undefined}>{alt || "image"}</ExternalLink>,
  table: ({ children }) => (
    <div className={s.tableWrap}>
      <table>{children}</table>
    </div>
  ),
};

const WITH_BLOCKS: Components = { ...COMPONENTS, pre: pre(true) };

/**
 * A small LRU of parsed blocks, keyed by text and how it parses: a row that mounts again (a chat opened again, a message
 * scrolled back into view) reuses its block's elements instead of parsing it again. react-markdown's Markdown is a plain
 * function with no hooks, and its elements hold no state, so one tree serves every mount.
 */
const PARSED_MAX = 500;
const parsed = new Map<string, ReactElement>();

export function parsedBlock(source: string, blocks: boolean, breaks = false): ReactElement {
  const key = `${blocks ? "1" : "0"}${breaks ? "1" : "0"}${source}`;
  const hit = parsed.get(key);
  if (hit !== undefined) {
    parsed.delete(key);
    parsed.set(key, hit);
    return hit;
  }
  const tree = ReactMarkdown({ children: source, remarkPlugins: breaks ? REMARK_BREAKS : REMARK, components: blocks ? WITH_BLOCKS : COMPONENTS, skipHtml: true });
  parsed.set(key, tree);
  if (parsed.size > PARSED_MAX) {
    const oldest = parsed.keys().next().value;
    if (oldest !== undefined) parsed.delete(oldest);
  }
  return tree;
}

const Block = memo(function Block({ source, blocks, breaks }: { source: string; blocks: boolean; breaks: boolean }) {
  return parsedBlock(source, blocks, breaks);
});

/** Block by block: a reply streaming in re-parses only its last block, the one still growing. */
export default function MarkdownBody({ source, blocks = true, breaks = false }: { source: string; blocks?: boolean; breaks?: boolean }) {
  const parts = useMemo(() => markdownBlocks(source), [source]);
  // By position: a streaming message only grows at its end, so every block before the last keeps its key and text.
  return parts.map((b, i) => <Block key={i} source={b} blocks={blocks} breaks={breaks} />);
}
