import { describe, expect, it } from "vitest";
import { keyOf, limitChoices, providerHint, providerName } from "./sandboxModel";

describe("the providers", () => {
  it("names each as people know it, and a newer hub's as it names it", () => {
    expect(["boat", "modal"].map(providerName)).toEqual(["fleetd's computers", "modal"]);
    expect(providerHint("boat")).toContain("browser, Linux desktop and Android");
  });
});

describe("the limit", () => {
  it("offers none up to 500, and keeps one set that isn't a step", () => {
    const steps = limitChoices(5).map((c) => c.value);
    expect(steps[0]).toBe("0");
    expect(steps.at(-1)).toBe("500");
    expect(limitChoices(5)[0]?.label).toBe("None at once");
    expect(limitChoices(7).map((c) => c.value)).toContain("7");
    expect(limitChoices(7).map((c) => Number(c.value))).toEqual([...limitChoices(7).map((c) => Number(c.value))].sort((a, b) => a - b));
  });
});

describe("what was typed", () => {
  it("trims a key, and empty is none", () => {
    expect(keyOf("  boat_abc\n")).toBe("boat_abc");
    expect(keyOf("   ")).toBeNull();
  });
});
