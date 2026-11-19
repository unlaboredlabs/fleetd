// @vitest-environment happy-dom
/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { underModal } from "./under";

it("holds what comes before a modal at every level up to the body, and lets go of only what it held", () => {
  document.body.innerHTML = `<div id="root"><div id="shell"><div id="app"></div><div id="was" inert></div><div id="scrim"></div><div id="after"></div></div></div><div id="portal"><div id="overlay"></div></div>`;
  const at = (id: string) => document.getElementById(id);
  const held = () => [...document.querySelectorAll("[data-under-modal]")].map((el) => el.id);

  // Settings: its scrim in the shell, after the app.
  const letGo = underModal(at("scrim"));
  expect(held()).toEqual(["app"]);
  expect(at("app")?.hasAttribute("inert")).toBe(true);
  expect(at("after")?.hasAttribute("inert")).toBe(false);
  letGo?.();
  expect(held()).toEqual([]);
  expect(at("app")?.hasAttribute("inert")).toBe(false);
  expect(at("was")?.hasAttribute("inert"), "one inert before stays so").toBe(true);

  // New bot: its overlay in a portal on the body, after the app's root.
  const letGoPortal = underModal(at("overlay"));
  expect(held()).toEqual(["root"]);
  letGoPortal?.();
  expect(held()).toEqual([]);
  expect(underModal(null)).toBeUndefined();
});

// Read from disk: Vitest blanks CSS imports.
const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sheets = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sheets(path.join(dir, e.name)) : e.name.endsWith(".css") ? [path.join(dir, e.name)] : [],
  );

it("no window-wide scrim draws a backdrop filter: over the Mac's see-through sidebar its words show through crisp", () => {
  const found: string[] = [];
  for (const file of sheets(renderer)) {
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const fills = /position:\s*fixed/.test(body) && /(^|[\s;])inset:\s*0\s*;/.test(body);
      const filters = /backdrop-filter:\s*(?!none)[^;]+;/.test(body);
      if (fills && filters) found.push(`${path.relative(renderer, file)} ${selector.trim()}`);
    }
  }
  expect(found, "blur what is under a modal with underModal (ui/lib/under.ts), never with a backdrop filter").toEqual([]);
});
