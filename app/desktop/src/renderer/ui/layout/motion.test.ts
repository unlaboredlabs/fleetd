/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// How the sidebar and the panel come and go, pinned against the CSS the app ships (read from disk: Vitest blanks CSS
// imports). Only transform moves, so the chat beside never lays out mid-way; a transition, so a toggle mid-way turns it
// back from where it is; short, with an ease-out that starts at once; out sooner than in; nothing with reduced motion.
const layout = readFileSync(new URL("./layout.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");

/** The body of the rule whose selector list is exactly `selector` (not the end of a longer list), `{` to `}`. */
const rule = (css: string, selector: string): string => {
  let start = css.indexOf(`${selector} {`);
  while (start > 0 && css.slice(0, start).trimEnd().endsWith(",")) start = css.indexOf(`${selector} {`, start + 1);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
};
const decls = (body: string): Record<string, string> =>
  Object.fromEntries([...body.matchAll(/^\s*([\w-]+):\s*(.+);$/gmu)].map((m) => [m[1] ?? "", m[2] ?? ""]));

const ms = (token: string, css = tokens): number => Number(new RegExp(`--${token}:\\s*(\\d+)ms;`, "u").exec(css)?.[1]);

const OUT = '.side[data-motion="out"],\n.aside[data-motion="out"]';

it("slides each side by a transition of transform alone, never keyframes, from and to its own edge", () => {
  expect(decls(rule(layout, ".side[data-motion]"))).toEqual({ transition: "transform var(--dur-base) var(--ease-out)" });
  expect(decls(rule(layout, ".aside[data-motion]"))).toEqual({ transition: "transform var(--dur-panel-in) var(--ease-panel)" });
  expect(layout).not.toMatch(/@keyframes|animation/u);
  // In from its edge: the side's first style, then its place. The sidebar is flush to the window's edge.
  const starting = layout.slice(layout.indexOf("@starting-style {"));
  expect(decls(rule(starting, '.side[data-motion="in"]'))).toEqual({ transform: "translateX(-100%)" });
  expect(decls(rule(starting, '.aside[data-motion="in"]'))).toEqual({ transform: "translateX(100%)" });
  // Out to it.
  expect(decls(rule(layout, '.side[data-motion="out"]'))).toMatchObject({ transform: "translateX(-100%)" });
  expect(decls(rule(layout, '.aside[data-motion="out"]'))).toMatchObject({ transform: "translateX(100%)" });
  // Nothing in the frame transitions a size or the grid: the chat lays out once, at the toggle.
  expect(layout).not.toMatch(/transition[^;]*(width|grid|inset|left|right|margin|padding|all)/u);
});

it("comes in over --dur-base and goes over --dur-fast, with --ease-out", () => {
  expect(decls(rule(layout, '.side[data-motion="out"]'))["transition-duration"]).toBe("var(--dur-fast)");
  expect(ms("dur-base")).toBe(180);
  expect(ms("dur-fast")).toBe(120);
  // An ease-out that moves in the first frame: the curve's first control point rises at least as fast as it runs.
  const curve = /--ease-out:\s*cubic-bezier\(([^)]+)\);/u.exec(tokens)?.[1]?.split(",").map(Number) ?? [];
  expect(curve).toHaveLength(4);
  expect(curve[1]).toBeGreaterThanOrEqual(curve[0] ?? 1);
  expect(curve[3]).toBe(1);
});

it("moves the panel on a spring with no overshoot, 280 ms in and 220 ms out", () => {
  expect(decls(rule(layout, '.aside[data-motion="out"]'))["transition-duration"]).toBe("var(--dur-panel-out)");
  expect(ms("dur-panel-in")).toBe(280);
  expect(ms("dur-panel-out")).toBe(220);
  // Sampled, it rises without ever passing 1 or stepping back, and is at rest at its end.
  const points = [.../--ease-panel:\s*linear\(([^)]+)\);/u.exec(tokens)?.[1]?.matchAll(/(?:^|,)\s*([\d.]+)/gu) ?? []].map((m) => Number(m[1]));
  expect(points.length).toBeGreaterThan(10);
  expect(points.every((v, i) => v <= 1 && (i === 0 || v >= (points[i - 1] ?? 0)))).toBe(true);
  expect(points.at(-1)).toBe(1);
  // It leaves at speed: the first step is a fifth of the way.
  expect(points[1]).toBeGreaterThan(0.15);
});

it("draws a side going out over the main area, out of the grid, so the chat takes its room at once", () => {
  expect(decls(rule(layout, OUT))).toMatchObject({ position: "absolute", "grid-area": "auto", "pointer-events": "none" });
});

it("doesn't move with reduced motion", () => {
  const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(ms("dur-base", reduced)).toBe(0);
  expect(ms("dur-fast", reduced)).toBe(0);
  expect(ms("dur-panel-in", reduced)).toBe(0);
  expect(ms("dur-panel-out", reduced)).toBe(0);
});

it("paints the panel's column in its own tone before the panel slides over it, so no lighter frame shows first", () => {
  expect(decls(rule(layout, ".withAside::before"))).toEqual({ content: '""', "grid-area": "aside", background: "var(--bg)" });
  expect(decls(rule(layout, ".aside")).background).toBe("var(--bg)");
});
