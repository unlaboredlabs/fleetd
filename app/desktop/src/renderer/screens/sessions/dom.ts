// A step's page snapshot from the HTML the node read after a step (dom.jsonl): the page's structure, one element a line
// under its parent (its role, its name, its value), as a person reads a page rather than as its markup nests. DOMParser
// makes an inert document: no script runs and nothing loads, and none of it is ever put on screen as HTML. A password
// field never shows a value, whatever the HTML holds (the node scrubbed the secrets it knew already).
import type { PageSnapshot, SnapshotNode } from "./model";

/** The most lines a snapshot shows; a huge page is cut, not slowed down. */
const MAX_NODES = 600;
/** How much of an element's text names it. */
const NAME_CHARS = 120;

const LANDMARK: Readonly<Record<string, string>> = {
  header: "banner",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  form: "form",
  dialog: "dialog",
  table: "table",
  tr: "row",
  ul: "list",
  ol: "list",
  li: "listitem",
  select: "combobox",
  textarea: "textbox",
  img: "img",
  p: "paragraph",
};

const INPUT_ROLE: Readonly<Record<string, string>> = {
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
  search: "searchbox",
  range: "slider",
};

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "head", "meta", "link"]);

const clip = (text: string): string => {
  const one = text.replace(/\s+/gu, " ").trim();
  return one.length > NAME_CHARS ? `${one.slice(0, NAME_CHARS - 1)}…` : one;
};

/** The element's role, as the page says it or as its tag implies; undefined for one the outline passes through. */
const roleOf = (el: Element): string | undefined => {
  const given = el.getAttribute("role")?.split(" ")[0];
  if (given !== undefined && given !== "" && given !== "presentation" && given !== "none") return given;
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/u.test(tag)) return "heading";
  if (tag === "a") return el.hasAttribute("href") ? "link" : undefined;
  if (tag === "button") return "button";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    return type === "hidden" ? undefined : (INPUT_ROLE[type] ?? "textbox");
  }
  if (tag === "section" || tag === "div") return el.hasAttribute("aria-label") ? "region" : undefined;
  return LANDMARK[tag];
};

/** Its accessible name, near enough: its label, its own words, or what stands in for them. */
const nameOf = (el: Element, doc: Document): string | undefined => {
  const aria = el.getAttribute("aria-label");
  if (aria !== null && aria.trim() !== "") return clip(aria);
  const id = el.getAttribute("id");
  const label = id === null ? null : doc.querySelector(`label[for="${CSS.escape(id)}"]`);
  const wrapped = el.closest("label");
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") {
    const text = label?.textContent ?? wrapped?.textContent ?? el.getAttribute("placeholder") ?? el.getAttribute("name") ?? "";
    return text.trim() === "" ? undefined : clip(text);
  }
  if (tag === "img") return el.getAttribute("alt") ?? undefined;
  // Containers name themselves by their label only; their words are their children's.
  if (["form", "table", "ul", "ol", "header", "nav", "main", "aside", "footer", "dialog", "section", "div"].includes(tag)) return undefined;
  const text = el.textContent;
  return text.trim() === "" ? undefined : clip(text);
};

const valueOf = (el: Element): Pick<SnapshotNode, "value" | "secret"> => {
  const tag = el.tagName.toLowerCase();
  if (tag !== "input") return {};
  const type = (el.getAttribute("type") ?? "text").toLowerCase();
  if (type === "password") return { secret: "vault" };
  if (type === "checkbox" || type === "radio") return el.hasAttribute("checked") ? { value: "checked" } : {};
  const value = el.getAttribute("value");
  return value === null || value === "" ? {} : { value: clip(value) };
};

/**
 * The page in `html` as lines of structure, and the lines of what `selector` (a CSS selector a step acted on) names:
 * the element itself, or the nearest one of its own that has a line.
 */
export const structureOf = (html: string, selector?: string): PageSnapshot => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes: SnapshotNode[] = [];
  const index = new Map<Element, number>();
  const walk = (el: Element, depth: number) => {
    if (nodes.length >= MAX_NODES || SKIP.has(el.tagName.toLowerCase()) || el.hasAttribute("hidden")) return;
    const role = roleOf(el);
    let next = depth;
    if (role !== undefined) {
      const name = nameOf(el, doc);
      index.set(el, nodes.length);
      nodes.push({ depth, role, ...(name === undefined ? {} : { name }), ...valueOf(el) });
      next = depth + 1;
      // A named leaf's words are its name: its inline children say nothing more.
      if (role !== "listitem" && role !== "row" && name !== undefined && el.querySelector("a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6") === null) return;
    }
    for (const child of Array.from(el.children)) walk(child, next);
  };
  walk(doc.body, 0);
  return { nodes, targets: targetsOf(doc, selector, index) };
};

const targetsOf = (doc: Document, selector: string | undefined, index: ReadonlyMap<Element, number>): number[] => {
  if (selector === undefined) return [];
  let found: Element[];
  try {
    found = Array.from(doc.querySelectorAll(selector));
  } catch {
    // Not CSS after all (an agent-browser locator): nothing to point at.
    return [];
  }
  const out = new Set<number>();
  for (const el of found) {
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const i = index.get(at);
      if (i !== undefined) {
        out.add(i);
        break;
      }
    }
  }
  return [...out];
};
