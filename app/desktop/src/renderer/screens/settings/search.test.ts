import { describe, expect, it } from "vitest";
import { OPTIONS, searchSettings } from "./search";

const labels = (q: string) => searchSettings(q).map((o) => o.label);

describe("settings search", () => {
  it("finds an option by its own name, name matches first", () => {
    expect(labels("max agents")[0]).toBe("Max agents per project");
    expect(labels("max agents")).toContain("Whole fleet");
    expect(labels("MOTION")).toEqual(["Motion"]);
  });

  it("finds an option by the words people use for it", () => {
    expect(labels("dark")).toEqual(["Appearance"]);
    expect(labels("retention")).toEqual(["Time data"]);
  });

  it("finds a prompt by its name, opening it in the editor", () => {
    const [reviewer] = searchSettings("reviewer");
    expect(reviewer?.prompt).toBe("review.reviewer");
    expect(reviewer?.tab).toBe("prompts");
  });

  it("needs every word, and finds nothing for nothing", () => {
    expect(labels("dark motion")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("gives every option a unique key", () => {
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
  });
});
