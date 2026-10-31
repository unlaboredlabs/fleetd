// The phone's map of the built-in icons (botIconFiles.ts, generated) names every face in every color, at 32 and 96
// points, and each file it requires is there at 1x, 2x and 3x, as Metro picks one for the screen's scale.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ICON_COLORS, ICON_FACES } from "./desktop";

const here = dirname(fileURLToPath(import.meta.url));
const map = readFileSync(join(here, "botIconFiles.ts"), "utf8");
const entries = [...map.matchAll(/^ {2}"([a-z]+-[a-z]+)": \[require\("([^"]+)"\), require\("([^"]+)"\)\],$/gmu)];

describe("the built-in icons' files", () => {
  it("has every face in every color", () => {
    expect(entries.map((e) => e[1])).toEqual(ICON_FACES.flatMap((f) => ICON_COLORS.map((c) => `${f.id}-${c.id}`)));
  });

  it("has each at 32 and 96 points, at every scale", () => {
    for (const [, key, small, large] of entries) {
      expect(small).toMatch(new RegExp(`/${String(key)}-32\\.webp$`, "u"));
      expect(large).toMatch(new RegExp(`/${String(key)}-96\\.webp$`, "u"));
      for (const file of [small, large]) {
        for (const scale of ["", "@2x", "@3x"]) expect(existsSync(join(here, String(file).replace(/\.webp$/u, `${scale}.webp`))), `${String(file)} ${scale}`).toBe(true);
      }
    }
  });
});
