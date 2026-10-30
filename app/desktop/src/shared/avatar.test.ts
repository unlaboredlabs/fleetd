import { describe, expect, it } from "vitest";
import { initials, tintIndex } from "./avatar";

describe("initials", () => {
  it("takes one or two words' first letters", () => {
    expect(initials("Ada")).toBe("A");
    expect(initials("billing-api")).toBe("BA");
    expect(initials("docs site v2")).toBe("DS");
    expect(initials("élan vital")).toBe("ÉV");
    expect(initials("  ")).toBe("?");
    expect(initials("🚀")).toBe("🚀");
  });
});

describe("tintIndex", () => {
  it("is the same for a name and within the palette", () => {
    expect(tintIndex("Ada", 10)).toBe(tintIndex("Ada", 10));
    const seen = new Set(["Ada", "Household", "billing-api", "storefront", "docs-site", "infra"].map((n) => tintIndex(n, 10)));
    for (const i of seen) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(10);
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(tintIndex("x", 0)).toBe(0);
  });
});
