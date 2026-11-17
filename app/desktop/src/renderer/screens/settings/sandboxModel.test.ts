import { describe, expect, it } from "vitest";
import { domainOf, keyOf, limitChoices, notPlacingLine, orderLine, providerHint, providerLine, providerName, takesDomain, withFix } from "./sandboxModel";

const at = "2026-11-17T09:00:00.000Z";

describe("the providers", () => {
  it("names each as people know it, and a newer hub's as it names it; only E2B takes a domain", () => {
    expect(["e2b", "boat", "daytona", "modal"].map(providerName)).toEqual(["E2B", "boat.dev", "Daytona", "modal"]);
    expect(takesDomain("e2b")).toBe(true);
    expect(takesDomain("boat")).toBe(false);
    expect(providerHint("e2b")).toContain("self-hosted");
  });

  it("says the order agents go to them only with two or more connected", () => {
    const p = (provider: string, connected: boolean) => ({ provider, connected, limit: connected ? 5 : 0 });
    expect(orderLine([p("e2b", true), p("boat", false), p("daytona", false)])).toBeNull();
    expect(orderLine([p("e2b", true), p("boat", false), p("daytona", true)])).toBe("Agents go to E2B, then Daytona.");
    expect(orderLine([p("e2b", true), p("boat", true), p("daytona", true)])).toBe("Agents go to E2B, then boat.dev, then Daytona.");
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
  it("says nothing at rest while it works or isn't connected, Works just after a check, else its domain", () => {
    expect(providerLine({ provider: "e2b", connected: false }, true)).toBeNull();
    expect(providerLine({ provider: "e2b", connected: true, check: { at, ok: true } }, false)).toBeNull();
    expect(providerLine({ provider: "e2b", connected: true, check: { at, ok: true } }, true)).toEqual({ text: "Works", tone: "quiet" });
    expect(providerLine({ provider: "e2b", connected: true, domain: "e2b.example.com", check: { at, ok: true } }, false)).toEqual({ text: "e2b.example.com", tone: "quiet", domain: true });
  });

  it("says what a failed check found, in the hub's words else its reason's, with its fix", () => {
    expect(providerLine({ provider: "daytona", connected: true, check: { at, ok: false, reason: "invalid_key" } }, false)?.text).toBe("Daytona refused the key: it is wrong, revoked or expired.");
    const line = providerLine({ provider: "boat", connected: true, check: { at, ok: false, reason: "billing", message: "devbox: payment required", fix: "check it at boat.dev" } }, false);
    expect(line).toEqual({ text: "devbox: payment required", tone: "danger", fix: "check it at boat.dev" });
    expect(withFix(line ?? { text: "" })).toBe("devbox: payment required Check it at boat.dev.");
    expect(withFix({ text: "Works" })).toBe("Works");
  });
});

describe("what was typed", () => {
  it("trims a key and a domain, and empty is none", () => {
    expect(keyOf("  e2b_abc\n")).toBe("e2b_abc");
    expect(keyOf("   ")).toBeNull();
    expect(domainOf(" e2b.example.com ")).toBe("e2b.example.com");
    expect(domainOf("")).toBeUndefined();
  });
});
