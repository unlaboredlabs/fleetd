// The open-source notices Settings shows (notices.json, from scripts/notices.ts): current with what's installed, so a
// dependency added or moved without `npm run notices` fails here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packagesOf } from "../scripts/notices";
import notices from "./notices.json";

const ROOT = join(import.meta.dirname, "..");
/** Dependencies only the build uses: config plugins, never in the bundle or the native build. */
const BUILD_ONLY = ["expo-build-properties"];

describe("notices.json", () => {
  it("lists each shipped package at the version installed: after a dependency moves, run npm run notices", () => {
    for (const p of notices.packages) {
      const installed = JSON.parse(readFileSync(join(ROOT, "node_modules", p.name, "package.json"), "utf8")) as { version: string };
      expect(`${p.name} ${p.version}`).toBe(`${p.name} ${installed.version}`);
    }
  });

  it("lists every dependency the app ships: after adding one, run npm run notices", () => {
    const deps = Object.keys((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies);
    const listed = new Set(notices.packages.map((p) => p.name));
    expect(deps.filter((d) => !listed.has(d) && !BUILD_ONLY.includes(d))).toEqual([]);
  });

  it("holds each licence text once, and every package's points at one or at none", () => {
    expect(new Set(notices.texts).size).toBe(notices.texts.length);
    for (const p of notices.packages) expect(p.text).toBeLessThan(notices.texts.length);
    expect(notices.packages.find((p) => p.name === "react-native")?.text).toBeGreaterThanOrEqual(0);
  });
});

describe("packagesOf", () => {
  it("names each source's package by its nearest node_modules, a scoped one with its scope, the app's own files none", () => {
    expect([...packagesOf(["../src/screens/Settings.tsx", "../node_modules/react-native/index.js", "../node_modules/@noble/hashes/sha2.js", "../node_modules/a/node_modules/b/x.js"])]).toEqual([
      "react-native",
      "@noble/hashes",
      "b",
    ]);
  });
});
