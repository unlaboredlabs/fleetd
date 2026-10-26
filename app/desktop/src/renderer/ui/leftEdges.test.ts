/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// DESIGN.md: no coloured left edge on a card, row or callout; a quote or indent rule is a neutral hairline. Checked
// against every stylesheet in the renderer, read from disk: Vitest blanks CSS imports.
const root = fileURLToPath(new URL("..", import.meta.url));

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sheets(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

/** The colours a left edge may take: the neutral rules, or none at all. */
const NEUTRAL = new Set(["--hairline", "--border"]);

/** Words in an edge's value that aren't a colour. */
const NOT_COLOUR = new Set(["none", "hidden", "solid", "dashed", "dotted", "double", "inset", "transparent", "inherit", "initial", "unset"]);

/** Whether a value names any colour beyond the neutral rules. */
function coloured(value: string): boolean {
  const vars = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1] ?? "");
  if (vars.some((v) => !NEUTRAL.has(v))) return true;
  const bare = value.replace(/var\([^)]*\)/g, "");
  if (/#[0-9a-f]{3,8}\b|[a-z-]+\(/i.test(bare)) return true;
  const words = bare.replace(/-?[\d.]+[a-z%]*/gi, "").match(/[a-z]+/gi) ?? [];
  return words.some((w) => !NOT_COLOUR.has(w.toLowerCase()));
}

/** A value's parts split on top-level commas (not those inside var() or rgb()). */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      out.push(value.slice(from, i));
      from = i + 1;
    }
  }
  return [...out, value.slice(from)].map((l) => l.trim());
}

/** A shadow drawn as a stripe down the left: inset and shifted right, or outside and shifted left, with no blur
    or vertical offset. */
function leftStripe(shadow: string): boolean {
  const lengths = shadow.replace(/var\([^)]*\)|\w+\([^)]*\)/g, "").match(/-?[\d.]+(?:px|rem|em)?/g) ?? [];
  const [x = 0, y = 0, blur = 0] = lengths.map((l) => parseFloat(l));
  const inset = /\binset\b/.test(shadow);
  return y === 0 && blur === 0 && (inset ? x > 0 : x < 0) && coloured(shadow);
}

/** Every coloured left edge in a stylesheet, as "selector: declaration". */
export function leftEdges(css: string): string[] {
  const found: string[] = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? "").trim();
    for (const decl of (rule[2] ?? "").split(";")) {
      const at = decl.indexOf(":");
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim().toLowerCase();
      const value = decl.slice(at + 1).trim();
      const edge =
        /^border-(?:left|inline-start)(?:-color)?$/.test(prop)
          ? coloured(value)
          : prop === "border-color"
            ? (() => {
                const parts = value.split(/\s+(?![^(]*\))/);
                return parts.length === 4 && parts[3] !== parts[1] && coloured(parts[3] ?? "");
              })()
            : prop === "box-shadow"
              ? layers(value).some(leftStripe)
              : false;
      if (edge) found.push(`${selector}: ${prop}: ${value}`);
    }
  }
  return found;
}

describe("left edges", () => {
  it("finds a coloured edge in any of its forms, and lets a neutral rule be", () => {
    expect(leftEdges(".a { border-left: 3px solid var(--danger); }")).toHaveLength(1);
    expect(leftEdges(".a { border-left-color: var(--accent); }")).toHaveLength(1);
    expect(leftEdges(".a { border-inline-start: 2px solid #f00; }")).toHaveLength(1);
    expect(leftEdges(".a { border-color: var(--hairline) var(--hairline) var(--hairline) var(--warning); }")).toHaveLength(1);
    expect(leftEdges(".a { box-shadow: inset 3px 0 0 var(--success); }")).toHaveLength(1);
    expect(leftEdges(".a { box-shadow: 0 1px 2px var(--shadow), inset 2px 0 0 0 red; }")).toHaveLength(1);
    expect(leftEdges(".a { border-left: 2px solid var(--hairline); border-left: none; border-inline-start: 1px solid var(--border); }")).toEqual([]);
    expect(leftEdges(".a { box-shadow: inset 0 0 0 1.5px currentColor; box-shadow: inset 0 0 0 100px var(--hover); }")).toEqual([]);
  });

  it("has none in the app's stylesheets", () => {
    const found = sheets(root).flatMap((file) => leftEdges(readFileSync(file, "utf8")).map((e) => `${relative(root, file)}: ${e}`));
    expect(found).toEqual([]);
  });
});
