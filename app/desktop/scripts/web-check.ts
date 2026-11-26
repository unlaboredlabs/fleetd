// `pnpm build:web` ends with this: the web app's bundle (out/web) holds nothing of Electron or Node (a module Vite left
// out for the browser leaves its stub, `__vite-browser-external`) and loads nothing from another origin, which the
// cloud's CSP ('self') would refuse anyway. And its first load, the files index.html names (vite.web.config.ts), comes
// in one wave and stays within its budget, with nothing in it the first chat doesn't draw. Fails with what it found.
import { spawnSync } from "node:child_process";
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
 * 827 KB / 50 files in 3-4 waves; 613 KB / 34 once the side panel loaded after the chat, 441 KB / 28 once the fonts'
 * everyday cut, the markdown parser and the chat's cards of other screens came after it too, 373 KB / 29 once the
 * hub's frames and the session were read without zod and Medium and SemiBold came after the chat (W793), 383 KB / 22
 * once the app's shared modules came as one chunk and the icons chunk held only the first chat's (scripts/
 * firstLoadChunks.ts). A change that needs more moves what the first chat doesn't draw out of it (a chunk loaded on
 * use, or once the chat has shown: ui/lib/idle.ts), rather than raising these.
 */
const FIRST_LOAD_KB = 390;
const FIRST_LOAD_FILES = 32;
/** Chunks and files that load on use or once the chat has shown, never with the first load. */
const NOT_FIRST: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Settings(Screen|Sheet)-/u, "Settings, loaded once the chat has shown"],
  [/^(core|engine-javascript|typescript|tsx|javascript)-/u, "Shiki, loaded once the chat has painted"],
  [/^libsodium/u, "libsodium, loaded on the first secret"],
  [/^(ProjectPanel|panes|ChecklistPane)-[\w-]+\.js$/u, "the side panel, loaded once the chat has shown"],
  [/-(more|latin)-[\w-]+\.woff2$/u, "a font's symbols or extended Latin, loaded when the text uses them"],
  [/^MarkdownBody-[\w-]+\.js$/u, "the markdown parser, loaded once the chat has shown its plain words"],
  [/^Geist-(Medium|SemiBold)-/u, "Geist's Medium and SemiBold, added once the chat has shown (ui/laterFonts.ts)"],
  [/^GeistMono-/u, "the mono font, loaded when code or an id shows"],
];
/** What the first chat draws, loaded by import(): named in index.html, or it comes a wave (a round trip) later. */
const FIRST: ReadonlyArray<readonly [RegExp, string]> = [
  [/^main-[\w-]+\.js$/u, "the app"],
  [/^Geist-Regular-basic-[\w-]+\.woff2$/u, "the text's font"],
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
// Each chunk parses as a module, as the browser parses it before anything runs: a chunk that exports a name it never
// declares (a bundler's slip over a chunk group: scripts/firstLoadChunks.ts) leaves the page blank, budget or not.
const parse = spawnSync(
  process.execPath,
  [
    "--experimental-vm-modules",
    "--no-warnings",
    "--input-type=module",
    "-e",
    `import fs from "node:fs"; import vm from "node:vm";
     for (const file of process.argv.slice(1)) {
       try { new vm.SourceTextModule(fs.readFileSync(file, "utf8")); } catch (e) { console.log(file + ": " + e.message); }
     }`,
    ...fs.readdirSync(path.join(dir, "assets")).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, "assets", f)),
  ],
  { encoding: "utf8" },
);
if (parse.status !== 0) found.push(`the chunks couldn't be parsed: ${parse.stderr.trim()}`);
for (const line of parse.stdout.split("\n")) if (line !== "") found.push(path.relative(dir, line));
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
// The tab's icon, at the origin's root: a browser asks /favicon.ico by itself, and the cloud answers index.html for a
// file it doesn't hold.
for (const icon of ["favicon.svg", "favicon.ico", "apple-touch-icon.png"]) {
  if (!fs.existsSync(path.join(dir, icon))) found.push(`the build holds no ${icon}`);
  else if (!html.includes(`href="/${icon}"`)) found.push(`index.html doesn't link /${icon}`);
}
// The service worker that serves a page opened again from the browser (src/web/public/sw.js), at the origin's root.
if (!fs.existsSync(path.join(dir, "sw.js"))) found.push("the build holds no sw.js: a page opened again would wait on the network");
const kb = Math.round(bytes / 1024);
if (kb > FIRST_LOAD_KB) found.push(`the first load is ${kb} KB gzip, over its ${FIRST_LOAD_KB} KB budget`);
if (first.size > FIRST_LOAD_FILES) found.push(`the first load is ${first.size} files, over its ${FIRST_LOAD_FILES}`);
if (found.length > 0) {
  console.error(`The web bundle's first load is off:\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`out/web: the web app's bundle, browser only; first load ${first.size} files, ${kb} KB gzip, in one wave`);
