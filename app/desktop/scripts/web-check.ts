// `pnpm build:web` ends with this: the web app's bundle (out/web) holds nothing of Electron or Node (a module Vite left
// out for the browser leaves its stub, `__vite-browser-external`) and loads nothing from another origin, which the
// cloud's CSP ('self') would refuse anyway. Fails with what it found.
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "out", "web");
const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/__vite-browser-external/u, "a Node module left out for the browser"],
  [/require\(["']electron["']\)|from\s*["']electron["']/u, "Electron"],
  [/<script[^>]+src=["']https?:/u, "a script from another origin"],
  [/<link[^>]+href=["']https?:/u, "a style or preload from another origin"],
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
console.log("out/web: the web app's bundle, browser only");
