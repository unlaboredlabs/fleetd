import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute, replaceRoute } from "./route";
import { OPTIONS, optionHref, searchSettings } from "./search";

const labels = (q: string) => searchSettings(q).map((o) => o.label);

describe("settings search", () => {
  it("finds an option by its own name, name matches first", () => {
    expect(labels("max agents")[0]).toBe("Max agents per project");
    // The fleet and machine caps are Administration's, never Settings'.
    expect(labels("max agents")).not.toContain("Whole fleet");
    expect(labels("fleet cap")).toEqual([]);
    expect(labels("APPEARANCE")).toEqual(["Appearance"]);
  });

  it("finds an option by the words people use for it", () => {
    expect(labels("dark")).toEqual(["Appearance"]);
    expect(labels("disconnect")).toEqual(["Hub"]);
  });

  it("finds a prompt by its name, opening it in the editor", () => {
    const [reviewer] = searchSettings("reviewer");
    expect(reviewer?.prompt).toBe("review.reviewer");
    expect(reviewer?.tab).toBe("prompts");
  });

  it("needs every word, and finds nothing for nothing", () => {
    expect(labels("dark sound")).toEqual([]);
    expect(labels("   ")).toEqual([]);
  });

  it("gives every option a unique key", () => {
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
  });

  it("opens a prompt in the project Prompts was showing, so a save never lands hub-wide by surprise", () => {
    vi.stubGlobal("window", { location: { hash: "" }, history: { state: null, replaceState: () => undefined }, dispatchEvent: () => true });
    replaceRoute({ tab: "prompts", prompt: "lead.start", for: "devbox/storefront" });
    const [reviewer] = searchSettings("reviewer");
    if (reviewer === undefined) throw new Error("no reviewer");
    expect(parseRoute(optionHref(reviewer))).toMatchObject({ tab: "prompts", prompt: "review.reviewer", for: "devbox/storefront" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
