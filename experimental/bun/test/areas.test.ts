import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `hub.area(name, make)` keeps whichever service was made first, so a second `make` for one name (a seam's stand-in
// left beside its owner's module) wins or loses by start-up order: the train's sweep stand-in once hid the real sweep,
// whose `start` it lacked, and `fleetd hub start` threw.
test("every area name has one maker", () => {
  const src = join(import.meta.dir, "../src");
  const makers = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.ts").scanSync(src)) {
    const text = readFileSync(join(src, file), "utf8");
    for (const [, name] of text.matchAll(/\.area(?:<[^>]*>)?\(\s*"([^"]+)"\s*,/g)) {
      makers.set(name!, [...(makers.get(name!) ?? []), file]);
    }
  }
  const twice = [...makers].filter(([, files]) => files.length > 1).map(([name, files]) => `${name}: ${files}`);
  expect(twice).toEqual([]);
});
