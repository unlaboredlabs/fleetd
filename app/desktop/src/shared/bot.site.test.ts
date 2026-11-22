import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "esbuild";
import { expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "../..");

/** scripts/site-pebble.ts's bundle, read by path: a Node script, outside the projects that check src/shared. */
const bundle = async (plugins: Plugin[] = []): Promise<string> => {
  const script = (await import(path.join(desktop, "scripts/site-pebble.ts"))) as { bundle: (plugins: Plugin[]) => Promise<string> };
  return script.bundle(plugins);
};

it("fleetd.sh's bot is this bot: site/pebble.js is the bundle `pnpm site:pebble` writes", () => {
  const want = execFileSync(process.execPath, ["scripts/site-pebble.ts", "--print"], { cwd: desktop, encoding: "utf8" });
  const have = fs.readFileSync(path.join(desktop, "../../site/pebble.js"), "utf8");
  expect(have === want, "site/pebble.js is stale: run `pnpm site:pebble` in app/desktop").toBe(true);
});

/** The contracts module as esbuild reads it, with `more` at its end: another PR's change to it. */
const contractsWith = (more: string): Plugin => ({
  name: "contracts-with",
  setup(b) {
    b.onLoad({ filter: /shared[\\/]contracts[\\/]contracts\.ts$/ }, (args) => ({ contents: fs.readFileSync(args.path, "utf8") + more, loader: "ts" }));
  },
});

it("a change to the contracts that the bot doesn't read leaves the bundle as it is, so a merge batch never finds it stale", async () => {
  const now = await bundle();
  // Types and lists another PR adds, big enough to shift the letters' counts that minified names were picked by.
  const more = Array.from({ length: 40 }, (_, i) =>
    [
      `export type Quizzical${String(i)} = { zzqqjjxx?: "quixotic"; vvkkwwyy?: number; jazzy: readonly QuizKind${String(i)}[] };`,
      `export type QuizKind${String(i)} = "quiz" | "jazz" | "fizz" | "buzz" | "zyxw";`,
      `export const QUIZ_${String(i)} = ["quiz", "jazz", "fizz", "buzz"] as const;`,
    ].join("\n"),
  ).join("\n");
  expect((await bundle([contractsWith(`\n${more}\n`)])) === now).toBe(true);
});
