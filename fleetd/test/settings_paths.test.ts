// Every "Settings › …" path the hub, the node and the CLI write for a person (an error's fix, a lead's line, a
// doctor's check) names pages the apps' Settings has, by the names its index shows (app/desktop/src/shared/
// settingsPages.ts, which the index takes its labels from). The apps' own lines are held to it by settingsPages.test.ts.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readableLines, settingsPathProblems } from "../../app/desktop/src/shared/settingsPages.ts";

const SRC = join(import.meta.dir, "..", "src");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });

test("the hub's Settings paths name pages the apps' Settings has", () => {
  const found = sources(SRC).flatMap((path) =>
    readableLines(readFileSync(path, "utf8")).flatMap((line) => settingsPathProblems(line).map((p) => `${path.slice(SRC.length + 1)}: ${p}`)),
  );
  expect(found).toEqual([]);
});
