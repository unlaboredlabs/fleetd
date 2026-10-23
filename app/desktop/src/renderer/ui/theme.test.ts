import { describe, expect, it } from "vitest";
import { humanizeKey } from "./text/humanize";
import { isThemeMode, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("follows the system only in system mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("accepts only the three modes from storage", () => {
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("Dark")).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe("humanizeKey", () => {
  it("turns slugs and keys into a sentence-case label, without a leading option index", () => {
    expect(humanizeKey("public-snapshot")).toBe("Public snapshot");
    expect(humanizeKey("retryOnFailure")).toBe("Retry on failure");
    expect(humanizeKey("b-prorated")).toBe("Prorated");
  });
});
