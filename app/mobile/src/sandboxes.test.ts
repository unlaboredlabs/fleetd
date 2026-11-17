import { describe, expect, it } from "vitest";
import { introFooter, limitChoices, limitWords, providerFooter, providerName, sandboxesShown, takesDomain } from "./sandboxes";

const at = "2026-11-17T09:00:00.000Z";
const p = (provider: string, connected: boolean) => ({ provider, connected, limit: connected ? 5 : 0 });

describe("Settings › Sandboxes", () => {
  it("is an admin's, on a hub that serves it", () => {
    expect(sandboxesShown(true, true)).toBe(true);
    expect(sandboxesShown(false, true)).toBe(false);
    expect(sandboxesShown(undefined, true)).toBe(false);
    expect(sandboxesShown(true, false)).toBe(false);
  });

  it("names the providers, and only E2B takes a domain", () => {
    expect(["e2b", "boat", "daytona", "modal"].map(providerName)).toEqual(["E2B", "boat.dev", "Daytona", "modal"]);
    expect(takesDomain("e2b")).toBe(true);
    expect(takesDomain("daytona")).toBe(false);
  });

  it("says what it is for, the order with two or more, and that none runs there yet", () => {
    const one = introFooter({ placing: false, providers: [p("e2b", true), p("boat", false), p("daytona", false)] });
    expect(one).toContain("which bills you");
    expect(one).not.toContain("Agents go to");
    expect(one).toContain("They don't run there yet");
    const two = introFooter({ placing: true, providers: [p("e2b", true), p("boat", false), p("daytona", true)] });
    expect(two).toContain("Agents go to E2B, then Daytona.");
    expect(two).not.toContain("yet");
  });

  it("offers none up to 500, keeping one set that isn't a step", () => {
    expect(limitChoices(5)[0]).toBe(0);
    expect(limitChoices(5).at(-1)).toBe(500);
    expect(limitChoices(7)).toContain(7);
    expect(limitWords(0)).toBe("None");
    expect(limitWords(20)).toBe("20");
  });

  it("puts a failed check with its fix under a provider, else its domain", () => {
    expect(providerFooter({ provider: "e2b", connected: false })).toBeUndefined();
    expect(providerFooter({ provider: "e2b", connected: true, check: { at, ok: true } })).toBeUndefined();
    expect(providerFooter({ provider: "e2b", connected: true, domain: "e2b.acme.dev", check: { at, ok: true } })).toEqual({ text: "Self-hosted at e2b.acme.dev", problem: false });
    expect(providerFooter({ provider: "daytona", connected: true, check: { at, ok: false, reason: "invalid_key", message: "devbox: Daytona refused the key.", fix: "make a new one" } })).toEqual({
      text: "devbox: Daytona refused the key. Make a new one.",
      problem: true,
    });
  });
});
