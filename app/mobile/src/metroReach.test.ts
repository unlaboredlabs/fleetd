// The desktop modules the phone imports (src/desktop.ts) and theirs in turn are bundled only from the folders
// metro.config.js watches: one importing from another folder builds in vitest and fails the iOS and Android bundles
// ("Unable to resolve module ../onboarding/form", the Add project problems' sentence did).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = resolve(app, "../desktop/src");
const watched = [...readFileSync(resolve(app, "metro.config.js"), "utf8").matchAll(/path\.join\(desktop, "([^"]+)"\)/gu)].map((m) => resolve(desktop, m[1] ?? ""));

const file = (base: string): string | undefined =>
  ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((f) => {
    try {
      return readFileSync(f) !== undefined;
    } catch {
      return false;
    }
  });

it("reaches only desktop modules in the folders Metro watches", () => {
  expect(watched.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  const outside: string[] = [];
  const walk = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    if (path.startsWith(desktop) && !watched.some((w) => path.startsWith(`${w}/`))) outside.push(path.slice(desktop.length + 1));
    const text = readFileSync(path, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gmu)) {
      const next = file(resolve(dirname(path), m[1] ?? ""));
      if (next !== undefined && (next.startsWith(desktop) || path.startsWith(desktop))) walk(next);
    }
  };
  walk(resolve(app, "src/desktop.ts"));
  expect([...seen].filter((p) => p.startsWith(desktop)).length).toBeGreaterThan(10);
  expect(outside).toEqual([]);
});
