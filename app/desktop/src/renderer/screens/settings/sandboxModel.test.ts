import { describe, expect, it } from "vitest";
import { keyOf, limitChoices, notPlacingLine, providerHint, providerLine, providerName, withFix } from "./sandboxModel";

const at = "2026-11-17T09:00:00.000Z";

describe("the providers", () => {
  it("names each as people know it, and a newer hub's as it names it", () => {
    expect(["boat", "modal"].map(providerName)).toEqual(["boat.dev", "modal"]);
    expect(providerHint("boat")).toContain("browser, Linux desktop and Android");
  });

  it("says while no agent runs there yet, and nothing once they do", () => {
    expect(notPlacingLine({ placing: false })).toContain("don't run in hosted sandboxes yet");
    expect(notPlacingLine({ placing: true })).toBeNull();
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

describe("a provider's row line", () => {
  it("says nothing at rest while it works or isn't connected, and Works just after a check", () => {
    expect(providerLine({ provider: "boat", connected: false }, true)).toBeNull();
    expect(providerLine({ provider: "boat", connected: true, check: { at, ok: true } }, false)).toBeNull();
    expect(providerLine({ provider: "boat", connected: true, check: { at, ok: true } }, true)).toEqual({ text: "Works", tone: "quiet" });
  });

  it("says what a failed check found, in the hub's words else its reason's, with its fix", () => {
    expect(providerLine({ provider: "boat", connected: true, check: { at, ok: false, reason: "invalid_key" } }, false)?.text).toBe("boat.dev refused the key: it is wrong, revoked or expired.");
    const line = providerLine({ provider: "boat", connected: true, check: { at, ok: false, reason: "billing", message: "devbox: payment required", fix: "check it at boat.dev" } }, false);
    expect(line).toEqual({ text: "devbox: payment required", tone: "danger", fix: "check it at boat.dev" });
    expect(withFix(line ?? { text: "" })).toBe("devbox: payment required Check it at boat.dev.");
    expect(withFix({ text: "Works" })).toBe("Works");
  });
});

describe("what was typed", () => {
  it("trims a key, and empty is none", () => {
    expect(keyOf("  boat_abc\n")).toBe("boat_abc");
    expect(keyOf("   ")).toBeNull();
  });
});
