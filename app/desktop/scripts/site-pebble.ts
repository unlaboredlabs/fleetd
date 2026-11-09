// `pnpm site:pebble`: site/pebble.js, the bot on fleetd.sh drawn by the app's own code (shared/bot.ts, the rig, and
// ui/lib/botLife.ts, its canvas and clock), bundled as one script that sets `window.Pebble`. The landing page loads it
// rather than a copy, so the site's bot moves exactly as the app's. src/shared/bot.site.test.ts fails while the file
// in site/ isn't what this writes (it runs this with --print): run it again after changing either.
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const OUT = path.resolve(import.meta.dirname, "../../../site/pebble.js");

const BANNER = "// Written by `pnpm site:pebble` in app/desktop (scripts/site-pebble.ts) from the app's bot code; don't edit.";

/** The bundle's text: what site/pebble.js should hold. */
async function bundle(): Promise<string> {
  const out = await build({
    stdin: {
      contents: [
        'export { bringToLife } from "../src/renderer/ui/lib/botLife.ts";',
        'export { drawnAt, LARGE, newRig } from "../src/shared/bot.ts";',
      ].join("\n"),
      resolveDir: import.meta.dirname,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    globalName: "Pebble",
    target: "es2020",
    minify: true,
    legalComments: "none",
    banner: { js: BANNER },
    write: false,
  });
  return out.outputFiles[0]?.text ?? "";
}

// --print: the bundle on stdout, for the test to compare with the file.
if (process.argv[1] === import.meta.filename) {
  if (process.argv.includes("--print")) process.stdout.write(await bundle());
  else {
    fs.writeFileSync(OUT, await bundle());
    console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
  }
}
