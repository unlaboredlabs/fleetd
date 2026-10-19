/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The same AA guarantee the GPUI theme tested (theme.rs), checked against the CSS the app actually ships. Read from
// disk: Vitest blanks CSS imports, even ?raw ones.
const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6,8})\s*;/gi)) out[m[1] ?? ""] = (m[2] ?? "").toLowerCase();
  return out;
}

const light = block('[data-theme="light"]');
const dark = { ...light, ...block('[data-theme="dark"] {') };

function rgba(hex: string): [number, number, number, number] {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [n(1), n(3), n(5), hex.length === 9 ? n(7) / 255 : 1];
}

function over(surface: string, overlay: string): string {
  const [r, g, b, a] = rgba(overlay);
  const [sr, sg, sb] = rgba(surface);
  const mix = (o: number, s: number) => Math.round(o * a + s * (1 - a)).toString(16).padStart(2, "0");
  return `#${mix(r, sr)}${mix(g, sg)}${mix(b, sb)}`;
}

function luminance(hex: string): number {
  const [r, g, b] = rgba(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const TEXT = ["text", "quiet", "accent", "danger", "success", "warning", "role-implementer", "role-reviewer", "role-verifier", "role-lead"];
const SYNTAX = ["shiki-token-comment", "shiki-token-keyword", "shiki-token-string", "shiki-token-constant", "shiki-token-function", "shiki-token-parameter", "shiki-token-punctuation"];

describe.each([
  ["light", light],
  ["dark", dark],
])("%s tokens", (_name, p) => {
  const get = (k: string) => {
    const v = p[k];
    if (!v) throw new Error(`missing --${k}`);
    return v;
  };
  const bases = ["bg", "sidebar", "raised"].map((k) => [k, get(k)] as const);
  const surfaces = [
    ...bases,
    ["diff-add", get("diff-add")] as const,
    ["diff-del", get("diff-del")] as const,
    ...bases.flatMap(([k, c]) => [[`${k}+hover`, over(c, get("hover"))] as const, [`${k}+selected`, over(c, get("selected"))] as const]),
  ];

  it("every text colour passes AA on every surface, hovered and selected included", () => {
    for (const [surface, bg] of surfaces)
      for (const token of TEXT) expect(contrast(get(token), bg), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it("syntax colours pass AA on the code surface", () => {
    for (const token of SYNTAX) expect(contrast(get(token), get("sidebar")), token).toBeGreaterThanOrEqual(4.5);
  });

  it("control edges and the focus outline reach 3:1 on every surface (WCAG 1.4.11)", () => {
    for (const [surface, bg] of surfaces) {
      if (surface.startsWith("diff")) continue;
      expect(contrast(get("control-border"), bg), `control edge on ${surface}`).toBeGreaterThanOrEqual(3);
      // The focus outline is drawn in the accent (base.css :focus-visible).
      expect(contrast(get("accent"), bg), `focus outline on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the primary button label passes AA and faint stays visible", () => {
    expect(contrast(get("on-accent"), get("accent-fill"))).toBeGreaterThanOrEqual(4.5);
    for (const [, bg] of bases) expect(contrast(get("faint"), bg)).toBeGreaterThanOrEqual(2.5);
  });

  it("the sidebar is a tone step from the content, not a jump", () => {
    const r = contrast(get("bg"), get("sidebar"));
    expect(r).toBeGreaterThan(1.03);
    expect(r).toBeLessThan(1.15);
  });
});
