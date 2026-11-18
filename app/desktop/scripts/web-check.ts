// `pnpm build:web` ends with this: the web app's bundle (out/web) holds nothing of Electron or Node (a module Vite left
// out for the browser leaves its stub, `__vite-browser-external`) and loads nothing from another origin, which the
// cloud's CSP ('self') would refuse anyway. And its first load, the files index.html names (vite.web.config.ts), comes
// in one wave and stays within its budget, with nothing in it the first chat doesn't draw. Fails with what it found.
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dir = path.join(import.meta.dirname, "..", "out", "web");
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/__vite-browser-external/u, "a Node module left out for the browser"],
  [/require\(["']electron["']\)|from\s*["']electron["']/u, "Electron"],
  [/<script[^>]+src=["']https?:/u, "a script from another origin"],
  [/<link[^>]+href=["']https?:/u, "a style or preload from another origin"],
];

/**
 * The first load's budget, gzip (level 9) of every file index.html names: 641 KB / 47 files when set (W701), down from
 * 827 KB / 50 files in 3-4 waves. A change that needs more moves what the first chat doesn't draw out of it (a chunk
 * loaded on use, or once the chat has shown: ui/lib/idle.ts), rather than raising these.
 */
const FIRST_LOAD_KB = 660;
const FIRST_LOAD_FILES = 50;
/** Chunks and files that load on use or once the chat has shown, never with the first load. */
const NOT_FIRST: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Settings(Screen|Sheet)-/u, "Settings, loaded once the chat has shown"],
  [/^(core|engine-javascript|typescript|tsx|javascript)-/u, "Shiki, loaded once the chat has painted"],
  [/^libsodium/u, "libsodium, loaded on the first secret"],
  [/-more-[\w-]+\.woff2$/u, "a font's extended half, loaded when the text uses it"],
];
/** What the first chat draws, loaded by import(): named in index.html, or it comes a wave (a round trip) later. */
const FIRST: ReadonlyArray<readonly [RegExp, string]> = [
  [/^main-[\w-]+\.js$/u, "the app"],
  [/^MarkdownBody-[\w-]+\.js$/u, "the messages' markdown"],
  [/^ProjectPanel-[\w-]+\.js$/u, "the panel"],
  [/^panes-[\w-]+\.js$/u, "the panel's panes"],
  [/^Geist-Regular-latin-[\w-]+\.woff2$/u, "the text's font"],
];

const found: string[] = [];
const walk = (at: string): void => {
  for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
    const file = path.join(at, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|html|css)$/u.test(entry.name)) {
      const text = fs.readFileSync(file, "utf8");
      for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) found.push(`${path.relative(dir, file)}: ${what}`);
    }
  }
};
if (!fs.existsSync(path.join(dir, "index.html"))) {
  console.error("out/web/index.html is missing: run vite build -c vite.web.config.ts first");
  process.exit(1);
}
walk(dir);
if (found.length > 0) {
  console.error(`The web bundle holds what a browser can't run:\n${found.join("\n")}`);
  process.exit(1);
}

// The first load: every file index.html names, its static imports among them (else they'd come a wave later).
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const first = new Set([...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/gu)].map((m) => m[1] ?? ""));
let bytes = 0;
for (const file of first) {
  const at = path.join(dir, "assets", file);
  if (!fs.existsSync(at)) {
    found.push(`index.html names assets/${file}, which the build doesn't hold`);
    continue;
  }
  const body = fs.readFileSync(at);
  bytes += gzipSync(body, { level: 9 }).length;
  for (const [pattern, what] of NOT_FIRST) if (pattern.test(file)) found.push(`index.html loads ${file} first: ${what}`);
  if (!file.endsWith(".js")) continue;
  for (const m of body.toString("utf8").matchAll(/(?:import|from)\s*["']\.\/([^"']+\.js)["']/gu)) {
    const dep = m[1] ?? "";
    if (!first.has(dep)) found.push(`${file} imports ${dep}, which index.html doesn't name: it would load a wave later`);
  }
}
for (const [pattern, what] of FIRST) {
  if (![...first].some((f) => pattern.test(f)))
    found.push(`index.html doesn't name ${what} (${pattern.source}): it would load a wave later`);
}
if (!html.includes('<link rel="preload" href="/web/session" as="fetch"'))
  found.push("index.html doesn't preload /web/session: the page would ask who is signed in only once its script has run");
const kb = Math.round(bytes / 1024);
if (kb > FIRST_LOAD_KB) found.push(`the first load is ${kb} KB gzip, over its ${FIRST_LOAD_KB} KB budget`);
if (first.size > FIRST_LOAD_FILES) found.push(`the first load is ${first.size} files, over its ${FIRST_LOAD_FILES}`);
if (found.length > 0) {
  console.error(`The web bundle's first load is off:\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`out/web: the web app's bundle, browser only; first load ${first.size} files, ${kb} KB gzip, in one wave`);
