// The DOM checks that fail a QA run. Bundled to an IIFE and evaluated in the renderer over CDP, which the app's CSP
// does not apply to, so this must stay free of Node imports.
//
// Text-slot contract with the design system (E2): `data-text="code"` marks code views (exempt from the raw-text rule
// and allowed to scroll sideways). Everything else is held to the APP-WIDE TEXT RULE: wrap, or truncate with an
// ellipsis; never clip, spill or overlap.

import { allowlist, type CheckId } from "./allowlist.ts";
import { findRawText } from "./text-rules.ts";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Finding {
  check: CheckId;
  message: string;
  text: string;
  where: string;
  box: Box;
}

export interface CheckOptions {
  edgeInset: number;
  // Native chrome drawn over the page (the macOS traffic lights) that no content may sit under.
  reserved: Box[];
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Sub-pixel layout and font rounding stay below this.
const SLOP = 1.5;

const rectOf = (r: DOMRect | Rect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const empty = (r: Rect) => r.right - r.left <= SLOP || r.bottom - r.top <= SLOP;
const intersect = (a: Rect, b: Rect): Rect => ({
  left: Math.max(a.left, b.left),
  top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right),
  bottom: Math.min(a.bottom, b.bottom),
});
// A text run's rect is its line box, taller than the glyphs; a fifth off the top and bottom approximates the ink.
const inkOf = (r: Rect): Rect => {
  const pad = (r.bottom - r.top) * 0.2;
  return { left: r.left, right: r.right, top: r.top + pad, bottom: r.bottom - pad };
};
const toBox = (r: Rect): Box => ({ x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
const snippet = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
};

function exempt(el: Element, check: CheckId) {
  return allowlist.some((a) => a.check === check && el.closest(a.selector) !== null);
}

function describe(el: Element) {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
    const screen = e.getAttribute("data-screen");
    const testId = e.getAttribute("data-testid");
    const cls = typeof e.className === "string" ? e.className.split(/\s+/).find(Boolean) : undefined;
    let part = e.tagName.toLowerCase();
    if (screen) part += `[data-screen=${screen}]`;
    else if (testId) part += `[data-testid=${testId}]`;
    else if (e.id) part += `#${e.id}`;
    else if (cls) part += `.${cls}`;
    parts.unshift(part);
    if (screen) break;
  }
  return parts.join(" > ");
}

function hidden(el: Element) {
  if (el.closest("[aria-hidden='true'], [inert], svg")) return true;
  return !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}

// Whether a background hides what is under it: a colour at least 90% opaque, or a backdrop blur.
function opaque(s: CSSStyleDeclaration) {
  if (s.backdropFilter !== "none" && s.backdropFilter !== "") return true;
  const bg = s.backgroundColor;
  if (bg === "transparent" || bg === "") return false;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(bg);
  const legacy = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(bg);
  const raw = slash ?? legacy;
  if (!raw) return true;
  const alpha = Number(raw[1]) / (raw[2] === "%" ? 100 : 1);
  return alpha >= 0.9;
}

// text-overflow draws an ellipsis only on a single-line block container that clips; on a flex or grid container, or
// on wrapping text, it does nothing and the text is simply cut.
const ELLIPSIS_DISPLAYS = ["block", "inline-block", "list-item", "flow-root", "table-cell"];
function ellipsizes(s: CSSStyleDeclaration) {
  const nowrap = s.whiteSpace === "nowrap" || s.whiteSpace === "pre" || s.getPropertyValue("text-wrap-mode") === "nowrap";
  return s.textOverflow === "ellipsis" && clips(s.overflowX) && nowrap && ELLIPSIS_DISPLAYS.includes(s.display);
}

const scrolls = (v: string) => v === "auto" || v === "scroll";
const clips = (v: string) => v !== "visible";

export function runChecks(opts: CheckOptions): Finding[] {
  const findings: Finding[] = [];
  const viewport: Rect = {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth,
    bottom: document.documentElement.clientHeight,
  };
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (el: Element) => {
    let s = styles.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };

  // Screen-reader-only text (Radix VisuallyHidden, .sr-only: an absolutely positioned box clipped to nothing) is
  // meant to be invisible, so it is exempt from the layout checks; its words still meet the raw-text rule.
  const srMemo = new Map<Element, boolean>();
  const screenReaderOnly = (el: Element): boolean => {
    const known = srMemo.get(el);
    if (known !== undefined) return known;
    const s = style(el);
    const clipped =
      s.position === "absolute" &&
      // `clip` is deprecated but is what Radix VisuallyHidden and most .sr-only rules still set.
      (!["auto", ""].includes(s.getPropertyValue("clip")) ||
        s.clipPath.startsWith("inset(50%") ||
        (el.clientWidth <= 1 && el.clientHeight <= 1 && clips(s.overflowX)));
    const result = clipped || (el.parentElement !== null && screenReaderOnly(el.parentElement));
    srMemo.set(el, result);
    return result;
  };

  // The region where an element's content can be seen: the viewport cut by every clipping ancestor.
  const clipMemo = new Map<Element, Rect>();
  const clipOf = (el: Element): Rect => {
    const known = clipMemo.get(el);
    if (known) return known;
    const s = style(el);
    let clip = s.position === "fixed" || !el.parentElement ? viewport : clipOf(el.parentElement);
    if (clips(s.overflowX) || clips(s.overflowY)) {
      const r = el.getBoundingClientRect();
      const inner = {
        left: r.left + el.clientLeft,
        top: r.top + el.clientTop,
        right: r.left + el.clientLeft + el.clientWidth,
        bottom: r.top + el.clientTop + el.clientHeight,
      };
      clip = intersect(clip, {
        left: clips(s.overflowX) ? inner.left : -Infinity,
        right: clips(s.overflowX) ? inner.right : Infinity,
        top: clips(s.overflowY) ? inner.top : -Infinity,
        bottom: clips(s.overflowY) ? inner.bottom : Infinity,
      });
    }
    clipMemo.set(el, clip);
    return clip;
  };

  // Text runs: one rect per line fragment of every visible text node.
  interface Run {
    node: Text;
    el: Element;
    rect: Rect;
    visible: Rect;
  }
  const runs: Run[] = [];
  // Every run including those clipped out of sight, which the overflow check needs.
  const allRuns: Run[] = [];
  const blockText = new Map<Element, string>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const el = node.parentElement;
    if (!el || !node.data.trim() || el.closest("script, style, noscript, template") || hidden(el)) continue;
    let block: Element = el;
    while (block.parentElement && ["inline", "contents"].includes(style(block).display)) block = block.parentElement;
    if (!exempt(el, "raw-text")) blockText.set(block, (blockText.get(block) ?? "") + node.data);
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      const rect = rectOf(r);
      if (empty(rect)) continue;
      const visible = intersect(rect, clipOf(el));
      if (screenReaderOnly(el)) continue;
      allRuns.push({ node, el, rect, visible });
      if (!empty(visible)) runs.push({ node, el, rect, visible });
    }
  }

  // Content scrolls under an opaque sticky or fixed bar (a list's header, the top bar) by design. Where such a bar is
  // the topmost thing over a run, that part of the run is hidden, not overlapping, and is cut from its visible rect.
  const occluders = [...document.body.querySelectorAll("*")].filter((el) => {
    const s = style(el);
    return (s.position === "sticky" || s.position === "fixed") && opaque(s) && !hidden(el);
  });
  // Cuts the parts of `v` (the visible rect of `el`) that an occluder is drawn over.
  const uncover = (el: Element, v: Rect) => {
    for (const occ of occluders) {
      if (occ.contains(el)) continue;
      const o = rectOf(occ.getBoundingClientRect());
      const hit = intersect(v, o);
      if (empty(hit)) continue;
      const top = document.elementFromPoint((hit.left + hit.right) / 2, (hit.top + hit.bottom) / 2);
      if (!top || !occ.contains(top)) continue;
      if (o.left <= v.left + SLOP && o.right >= v.right - SLOP) {
        // A full-width bar covers the top or bottom part.
        if (o.top <= v.top) v.top = Math.min(v.bottom, o.bottom);
        else v.bottom = Math.max(v.top, o.top);
      } else {
        v.right = v.left;
      }
    }
  };
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    if (!run) continue;
    uncover(run.el, run.visible);
    if (empty(run.visible)) runs.splice(i, 1);
  }

  // 1. Overflow: a text run outside the box that holds it. A box that scrolls, ellipsizes (sideways) or clamps
  // (downwards) contains the run on that axis, and from there on its own box stands for the run: it must itself fit
  // every ancestor, or the ellipsis never shows and an outer pane cuts the line. Each run is reported once, on the
  // nearest box it escapes. Line boxes are taller than the ink, so the vertical test uses the trimmed run (`inkOf`);
  // a tight line-height never counts.
  const reportedOverflow = new Set<Element>();
  for (const run of allRuns) {
    const ink = inkOf(run.rect);
    const extent = { left: run.rect.left, right: run.rect.right, top: ink.top, bottom: ink.bottom };
    for (let e: Element | null = run.el; e && e !== document.documentElement; e = e.parentElement) {
      const s = style(e);
      if (s.display === "inline" || s.display === "contents") continue;
      if (exempt(e, "overflow")) break;
      const r = e.getBoundingClientRect();
      const box = {
        left: r.left + e.clientLeft,
        top: r.top + e.clientTop,
        right: r.left + e.clientLeft + e.clientWidth,
        bottom: r.top + e.clientTop + e.clientHeight,
      };
      const containsX = scrolls(s.overflowX) || ellipsizes(s);
      const containsY = scrolls(s.overflowY) || (s.getPropertyValue("-webkit-line-clamp") !== "none" && clips(s.overflowY));
      const outX = extent.left < box.left - SLOP || extent.right > box.right + SLOP;
      const outY = extent.top < box.top - SLOP || extent.bottom > box.bottom + SLOP;
      const problem =
        outX && !containsX
          ? clips(s.overflowX)
            ? "text is cut off at the side: wrap it or truncate with an ellipsis (a flex child needs min-width: 0)"
            : "text runs out of its box sideways: wrap it or truncate with an ellipsis (a flex child needs min-width: 0)"
          : outY && !containsY
            ? clips(s.overflowY)
              ? "text is cut off at the bottom: the box must grow to fit its wrapped text"
              : "text spills out of its box: the box must grow to fit its wrapped text"
            : undefined;
      if (problem) {
        if (!reportedOverflow.has(e)) {
          reportedOverflow.add(e);
          findings.push({
            check: "overflow",
            message: problem,
            text: snippet(e.textContent),
            where: describe(e),
            box: toBox(intersect(rectOf(r), viewport)),
          });
        }
        break;
      }
      if (containsX) Object.assign(extent, { left: box.left, right: box.right });
      if (containsY) Object.assign(extent, { top: box.top, bottom: box.bottom });
      // A positioned box sits where it is put, past its ancestors' edges on purpose (popovers, badges).
      if (s.position === "absolute" || s.position === "fixed") break;
    }
  }

  // 2a. Overlap between the ink of text runs of different nodes.
  const CELL = 64;
  const grid = new Map<string, number[]>();
  const trimmed = runs.map(({ visible }) => inkOf(visible));
  const reportedPairs = new Set<string>();
  const elIds = new Map<Element, number>();
  const idOf = (e: Element) => {
    let id = elIds.get(e);
    if (id === undefined) {
      id = elIds.size;
      elIds.set(e, id);
    }
    return id;
  };
  trimmed.forEach((r, i) => {
    const seen = new Set<number>();
    for (let cx = Math.floor(r.left / CELL); cx <= Math.floor(r.right / CELL); cx++) {
      for (let cy = Math.floor(r.top / CELL); cy <= Math.floor(r.bottom / CELL); cy++) {
        const key = `${cx},${cy}`;
        const bucket = grid.get(key) ?? [];
        for (const j of bucket) {
          if (seen.has(j)) continue;
          seen.add(j);
          const a = runs[i];
          const b = runs[j];
          const other = trimmed[j];
          if (!a || !b || !other || a.node === b.node || exempt(a.el, "overlap") || exempt(b.el, "overlap")) continue;
          const hit = intersect(r, other);
          if (empty(hit)) continue;
          const pair = [idOf(a.el), idOf(b.el)].sort((x, y) => x - y).join(":");
          if (reportedPairs.has(pair)) continue;
          reportedPairs.add(pair);
          findings.push({
            check: "overlap",
            message: `text overlaps other text ("${snippet(b.node.data).slice(0, 40)}")`,
            text: snippet(a.node.data),
            where: describe(a.el),
            box: toBox(hit),
          });
        }
        bucket.push(i);
        grid.set(key, bucket);
      }
    }
  });

  // 2b. Overlap between sibling boxes that carry text: rows and cells that do not size to their content. In-flow
  // siblings are compared with each other, and absolutely positioned ones with each other (virtual list rows).
  for (const parent of document.body.querySelectorAll("*")) {
    if (parent.childElementCount < 2 || hidden(parent)) continue;
    const groups = new Map<string, { el: Element; rect: Rect }[]>();
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || hidden(child) || !child.textContent.trim() || screenReaderOnly(child)) continue;
      const s = style(child);
      // Sticky and fixed boxes overlap the content scrolling under them by design (see occluders above).
      if (s.display === "inline" || s.display === "contents" || s.position === "fixed" || s.position === "sticky") continue;
      if (exempt(child, "overlap")) continue;
      const rect = intersect(rectOf(child.getBoundingClientRect()), clipOf(parent));
      if (empty(rect)) continue;
      const group = s.position === "absolute" ? "absolute" : "flow";
      const list = groups.get(group) ?? [];
      list.push({ el: child, rect });
      groups.set(group, list);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.rect.top - b.rect.top);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!a || !b) continue;
          if (b.rect.top >= a.rect.bottom - SLOP) break;
          const hit = intersect(a.rect, b.rect);
          if (empty(hit)) continue;
          const pair = [idOf(a.el), idOf(b.el)].sort((x, y) => x - y).join(":");
          if (reportedPairs.has(pair)) continue;
          reportedPairs.add(pair);
          findings.push({
            check: "overlap",
            message: `box overlaps its sibling (${describe(b.el).split(" > ").pop() ?? ""})`,
            text: snippet(a.el.textContent),
            where: describe(a.el),
            box: toBox(hit),
          });
        }
      }
    }
  }

  // 3. Edge inset: visible text and controls keep clear of the window edge and of native chrome. Only sides that are
  // the content's own edge count; a side cut by a scrolling or clipping box is that box's edge, not the content's.
  const inset = opts.edgeInset;
  const edgeTargets: { el: Element; rect: Rect; visible: Rect; text: string }[] = runs.map((r) => ({
    el: r.el,
    rect: r.rect,
    visible: r.visible,
    text: r.node.data,
  }));
  const controls = document.body.querySelectorAll(
    "button, a[href], input, textarea, select, [role='button'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='switch'], [role='combobox']",
  );
  for (const el of controls) {
    if (hidden(el) || screenReaderOnly(el)) continue;
    const rect = rectOf(el.getBoundingClientRect());
    // The box itself is cut by its ancestors' clips, not its own; a fixed box escapes them.
    const clip = style(el).position === "fixed" || !el.parentElement ? viewport : clipOf(el.parentElement);
    const visible = intersect(rect, clip);
    uncover(el, visible);
    if (!empty(visible)) edgeTargets.push({ el, rect, visible, text: el.textContent || el.getAttribute("aria-label") || "" });
  }
  // Inside a box that scrolls on an axis, content passes the window edge on that axis while scrolling; only the
  // other axis is held to the inset.
  const scrollMemo = new Map<Element, { x: boolean; y: boolean }>();
  const scrollingAxes = (el: Element): { x: boolean; y: boolean } => {
    const known = scrollMemo.get(el);
    if (known) return known;
    const s = style(el);
    const outer = s.position === "fixed" || !el.parentElement ? { x: false, y: false } : scrollingAxes(el.parentElement);
    const axes = {
      x: outer.x || (scrolls(s.overflowX) && el.scrollWidth > el.clientWidth),
      y: outer.y || (scrolls(s.overflowY) && el.scrollHeight > el.clientHeight),
    };
    scrollMemo.set(el, axes);
    return axes;
  };
  const edgeReported = new Set<Element>();
  for (const t of edgeTargets) {
    if (edgeReported.has(t.el) || exempt(t.el, "edge")) continue;
    const { rect: r, visible: v } = t;
    const axes = scrollingAxes(t.el);
    const sides: string[] = [];
    if (!axes.x && v.left === r.left && v.left < inset) sides.push("left");
    if (!axes.y && v.top === r.top && v.top < inset) sides.push("top");
    if (!axes.x && v.right === r.right && v.right > viewport.right - inset) sides.push("right");
    if (!axes.y && v.bottom === r.bottom && v.bottom > viewport.bottom - inset) sides.push("bottom");
    const under = opts.reserved.some((box) =>
      !empty(intersect(v, { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height })),
    );
    if (sides.length === 0 && !under) continue;
    edgeReported.add(t.el);
    findings.push({
      check: "edge",
      message: under
        ? "content sits under the window controls"
        : `content is within ${inset} px of the window's ${sides.join(" and ")} edge`,
      text: snippet(t.text),
      where: describe(t.el),
      box: toBox(v),
    });
  }

  // 4. Raw machine text and markdown syntax, per block of text, outside code views.
  for (const [block, text] of blockText) {
    const hits = findRawText(text);
    if (hits.length === 0) continue;
    findings.push({
      check: "raw-text",
      message: hits.map((h) => `${h.kind} "${h.match.slice(0, 60)}"`).join(", "),
      text: snippet(text),
      where: describe(block),
      box: toBox(intersect(rectOf(block.getBoundingClientRect()), viewport)),
    });
  }

  return findings;
}

// Scrolling: the checks see only what is rendered and in view, so the harness steps every scroll container through
// its range, a container-height at a time, and checks again at each step. A virtualized list is then checked on the
// rows it renders at each step.

export interface ScrollStep {
  scroller: number;
  top: number;
  left: number;
  where: string;
  // The container's last step: the harness keeps a screenshot of it.
  last: boolean;
}

// A 20k-line log is sampled, not walked: this many evenly spaced stops per axis at most.
const MAX_STEPS = 40;

interface QaWindow {
  __fleetdQaScrollers?: { el: Element; top: number; left: number }[];
}

export function scrollSteps(): ScrollStep[] {
  const scrollers: Element[] = [];
  for (const el of document.querySelectorAll("*")) {
    if (hidden(el) || el.closest("[data-text='code'], #fleetd-qa-overlay")) continue;
    const s = getComputedStyle(el);
    const y = scrolls(s.overflowY) && el.scrollHeight > el.clientHeight + SLOP;
    const x = scrolls(s.overflowX) && el.scrollWidth > el.clientWidth + SLOP;
    if (x || y) scrollers.push(el);
  }
  const root = document.scrollingElement;
  if (root && root.scrollHeight > root.clientHeight + SLOP && !scrollers.includes(root)) scrollers.push(root);
  // Lists that start at the end (a conversation) are restored to where they were.
  (window as QaWindow).__fleetdQaScrollers = scrollers.map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));

  const stops = (max: number, page: number, start: number) => {
    if (max <= SLOP) return [];
    const count = Math.min(Math.ceil(max / Math.max(page, 1)), MAX_STEPS);
    return Array.from({ length: count + 1 }, (_, k) => Math.round((max * k) / count)).filter((p) => Math.abs(p - start) > SLOP);
  };
  return scrollers.flatMap((el, scroller) => {
    const where = describe(el);
    const steps = [
      ...stops(el.scrollHeight - el.clientHeight, el.clientHeight, el.scrollTop).map((top) => ({ top, left: 0 })),
      ...stops(el.scrollWidth - el.clientWidth, el.clientWidth, el.scrollLeft).map((left) => ({ top: 0, left })),
    ];
    return steps.map((p, k) => ({ scroller, ...p, where, last: k === steps.length - 1 }));
  });
}

export function scrollToStep(step: ScrollStep) {
  const entry = (window as QaWindow).__fleetdQaScrollers?.[step.scroller];
  entry?.el.scrollTo({ top: step.top, left: step.left, behavior: "instant" });
}

export function restoreScroll() {
  for (const { el, top, left } of (window as QaWindow).__fleetdQaScrollers ?? []) el.scrollTo({ top, left, behavior: "instant" });
}

const COLORS: Record<CheckId, string> = {
  overflow: "#e5484d",
  overlap: "#f76b15",
  edge: "#8e4ec6",
  "raw-text": "#0090ff",
};

// Draws numbered boxes over the findings for the annotated screenshot. CSSOM writes are not inline style attributes,
// so the app's CSP allows them.
export function annotate(findings: Finding[]) {
  clearAnnotations();
  const layer = document.createElement("div");
  layer.id = "fleetd-qa-overlay";
  Object.assign(layer.style, { position: "fixed", inset: "0", zIndex: "2147483647", pointerEvents: "none" });
  findings.forEach((f, i) => {
    const color = COLORS[f.check];
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute",
      left: `${f.box.x}px`,
      top: `${f.box.y}px`,
      width: `${Math.max(f.box.width, 4)}px`,
      height: `${Math.max(f.box.height, 4)}px`,
      outline: `2px solid ${color}`,
      background: `${color}22`,
    });
    const label = document.createElement("div");
    label.textContent = `${i + 1} ${f.check}`;
    Object.assign(label.style, {
      position: "absolute",
      left: "0",
      top: "-16px",
      font: "600 11px/16px system-ui, sans-serif",
      color: "#fff",
      background: color,
      padding: "0 4px",
      whiteSpace: "nowrap",
    });
    box.append(label);
    layer.append(box);
  });
  document.body.append(layer);
}

export function clearAnnotations() {
  document.getElementById("fleetd-qa-overlay")?.remove();
}
