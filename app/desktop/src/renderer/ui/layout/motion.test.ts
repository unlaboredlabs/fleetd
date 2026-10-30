/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// How the sidebar and the panel come and go, pinned against the CSS the app ships (read from disk: Vitest blanks CSS
// imports). Only transform moves, so the chat beside never lays out mid-way; short, with an ease-out that starts
// at once; out sooner than in; nothing with reduced motion.
const layout = readFileSync(new URL("./layout.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

/** The declarations of the last rule whose selector line is exactly this one. */
const rule = (css: string, selector: string): Record<string, string> => {
  const at = css.split("\n").findLastIndex((line) => line.trim() === `${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  const body = css.split("\n").slice(at + 1);
  const out: Record<string, string> = {};
  for (const line of body) {
    if (line.trim() === "}") break;
    const m = /^\s*([\w-]+):\s*(.+);$/u.exec(line);
    if (m !== null) out[m[1] ?? ""] = m[2] ?? "";
  }
  return out;
};

/** A keyframes block's properties, whichever frames they are in. */
const animated = (name: string): Array<string> => {
  const start = layout.indexOf(`@keyframes ${name} {`);
  if (start < 0) throw new Error(`no @keyframes ${name}`);
  let depth = 0;
  let end = start;
  for (let i = layout.indexOf("{", start); i < layout.length; i++) {
    if (layout[i] === "{") depth += 1;
    if (layout[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  return [...layout.slice(start, end).matchAll(/([\w-]+):/gu)].map((m) => m[1] ?? "");
};

const ms = (token: string, css = tokens): number => Number(new RegExp(`--${token}:\\s*(\\d+)ms;`, "u").exec(css)?.[1]);

it("slides each side in and out by transform alone, from and to its own edge", () => {
  for (const name of ["side-in", "side-out", "aside-in", "aside-out"]) expect(animated(name)).toEqual(["transform"]);
  expect(layout).toMatch(/@keyframes side-in \{\s*from \{\s*transform: translateX\(-100%\);/u);
  expect(layout).toMatch(/@keyframes side-out \{\s*to \{\s*transform: translateX\(-100%\);/u);
  expect(layout).toMatch(/@keyframes aside-in \{\s*from \{\s*transform: translateX\(100%\);/u);
  expect(layout).toMatch(/@keyframes aside-out \{\s*to \{\s*transform: translateX\(100%\);/u);
  // Nothing in the frame transitions a size or the grid: the chat lays out once, at the toggle.
  expect(layout).not.toMatch(/transition[^;]*(width|grid|inset|left|right|margin|padding)/u);
});

it("comes in over --dur-base and goes over --dur-fast, both with --ease-out", () => {
  expect(rule(layout, '.side[data-motion="in"]')["animation"]).toBe("side-in var(--dur-base) var(--ease-out)");
  expect(rule(layout, '.aside[data-motion="in"]')["animation"]).toBe("aside-in var(--dur-base) var(--ease-out)");
  expect(rule(layout, '.side[data-motion="out"]')["animation"]).toBe("side-out var(--dur-fast) var(--ease-out) forwards");
  expect(rule(layout, '.aside[data-motion="out"]')["animation"]).toBe("aside-out var(--dur-fast) var(--ease-out) forwards");
  expect(ms("dur-base")).toBe(180);
  expect(ms("dur-fast")).toBe(120);
  // An ease-out that moves in the first frame: the curve's first control point rises at least as fast as it runs.
  const curve = /--ease-out:\s*cubic-bezier\(([^)]+)\);/u.exec(tokens)?.[1]?.split(",").map(Number) ?? [];
  expect(curve).toHaveLength(4);
  expect(curve[1]).toBeGreaterThanOrEqual(curve[0] ?? 1);
  expect(curve[3]).toBe(1);
});

it("draws a side going out over the main area, out of the grid, so the chat takes its room at once", () => {
  const start = layout.indexOf('.side[data-motion="out"],\n.aside[data-motion="out"] {');
  expect(start).toBeGreaterThan(0);
  const out = layout.slice(start, layout.indexOf("}", start));
  for (const decl of ["position: absolute;", "grid-area: auto;", "pointer-events: none;"]) expect(out).toContain(decl);
});

it("doesn't move with reduced motion", () => {
  const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(ms("dur-base", reduced)).toBe(0);
  expect(ms("dur-fast", reduced)).toBe(0);
});
