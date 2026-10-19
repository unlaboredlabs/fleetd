import { describe, expect, it } from "vitest";

const el = {} as Element;
import { paletteCache, type Palette } from "./paint";

const palette = (accent: string): Palette => ({ fill: [], edge: [], danger: "", accent, warning: "", grid: "", selection: "" });

describe("palette cache", () => {
  it("reads the colours again when the document's theme changes, and only then", () => {
    let tokens = "light-accent";
    let reads = 0;
    const get = paletteCache(() => {
      reads += 1;
      return palette(tokens);
    });
    expect(get("light", 1, el).accent).toBe("light-accent");
    expect(get("light", 1, el).accent).toBe("light-accent");
    expect(reads).toBe(1);
    // The provider flips data-theme and the tokens with it; the next paint is keyed on the attribute.
    tokens = "dark-accent";
    expect(get("dark", 1, el).accent).toBe("dark-accent");
    expect(get("dark", 2, el).accent).toBe("dark-accent");
    expect(reads).toBe(3);
  });
});
