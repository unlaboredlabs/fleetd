import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// `bun build` keeps one module per file, so a file imported with two loaders (`type: "json"` here, `type: "text"`
// there) gets whichever import the bundler resolves first: a binary where one of them reads the wrong form.
test("every file imported with an attribute has one loader", () => {
  const src = join(import.meta.dir, "../src");
  const loaders = new Map<string, Set<string>>();
  for (const file of new Bun.Glob("**/*.ts").scanSync(src)) {
    const text = readFileSync(join(src, file), "utf8");
    for (const [, spec, type] of text.matchAll(/from\s+"([^"]+)"\s+with\s*\{\s*type:\s*"(\w+)"\s*\}/g)) {
      const path = resolve(dirname(join(src, file)), spec!);
      loaders.set(path, (loaders.get(path) ?? new Set()).add(type!));
    }
  }
  const mixed = [...loaders].filter(([, types]) => types.size > 1).map(([path, types]) => `${path}: ${[...types]}`);
  expect(mixed).toEqual([]);
});
