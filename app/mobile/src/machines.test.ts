import { describe, expect, it } from "vitest";
import {
  agentsWhere,
  canWords,
  daysChoices,
  limitChoices,
  limitWords,
  machinesShown,
  machineValue,
  providerFooter,
  providerName,
  providersFooter,
  providersOf,
  providerValue,
  routeChoices,
  routeChosen,
  specOf,
  takesDomain,
} from "./machines";

const at = "2026-11-17T09:00:00.000Z";
const sb = (provider: string, connected: boolean, limit = connected ? 5 : 0) => ({ provider, connected, limit });
const BOX = "box";

describe("Settings › Machines", () => {
  it("is an admin's", () => {
    expect(machinesShown(true)).toBe(true);
    expect(machinesShown(false)).toBe(false);
    expect(machinesShown(undefined)).toBe(false);
  });

  it("says how each machine is, warning while it needs someone", () => {
    expect(machineValue({ status: "online" })).toEqual({ text: "Online", warn: false });
    expect(machineValue({ status: "offline" })).toEqual({ text: "Offline", warn: true });
    expect(machineValue({ status: "degraded", degradedReason: "claude is not logged in. Fix: claude auth login" })).toEqual({ text: "Claude is not logged in", warn: true });
    expect(machineValue({ status: "degraded" })).toEqual({ text: "Needs a look", warn: true });
  });
});

describe("its providers", () => {
  it("lists the sandbox providers then Revyl, each named, with what it runs", () => {
    const list = providersOf(
      { boxPubKey: BOX, placing: true, providers: [sb("e2b", true, 20), sb("boat", false), sb("daytona", false)] },
      { boxPubKey: BOX, connected: true, routes: { ios: "revyl_only", android: "ours_first" } },
    );
    expect(list.map((p) => p.id)).toEqual(["e2b", "boat", "daytona", "revyl"]);
    expect(["e2b", "boat", "daytona", "revyl", "modal"].map(providerName)).toEqual(["E2B", "boat.dev", "Daytona", "Revyl", "modal"]);
    expect(canWords(specOf("e2b"))).toBe("Agents");
    expect(canWords(specOf("revyl"))).toBe("iOS simulator · Android");
    // A hub without either tool lists none of its providers.
    expect(providersOf(undefined, undefined)).toEqual([]);
    expect(takesDomain("e2b")).toBe(true);
    expect(takesDomain("revyl")).toBe(false);
  });

  it("says each one's state: not connected, its limit, connected, or a check that failed", () => {
    expect(providerValue({ id: "boat", connected: false, limit: 0 })).toEqual({ text: "Not connected", problem: false });
    expect(providerValue({ id: "e2b", connected: true, limit: 20 })).toEqual({ text: "20 at once", problem: false });
    expect(providerValue({ id: "e2b", connected: true, limit: 0 })).toEqual({ text: "None at once", problem: false });
    expect(providerValue({ id: "revyl", connected: true })).toEqual({ text: "Connected", problem: false });
    expect(providerValue({ id: "daytona", connected: true, limit: 5, check: { ok: false, at } })).toEqual({ text: "Check failed", problem: true });
  });

  it("says what they cost and the order, and that none runs agents yet while none does", () => {
    expect(providersFooter({ placing: true })).toContain("which bill you");
    expect(providersFooter({ placing: true })).not.toContain("yet");
    expect(providersFooter({ placing: false })).toContain("Agents don't run in hosted sandboxes yet");
  });

  it("offers none up to 500, keeping one set that isn't a step", () => {
    expect(limitChoices(5)[0]).toBe(0);
    expect(limitChoices(5).at(-1)).toBe(500);
    expect(limitChoices(7)).toContain(7);
    expect(limitWords(0)).toBe("None");
    expect(limitWords(20)).toBe("20");
  });

  it("puts a failed check with its fix on a provider's screen, else its domain", () => {
    expect(providerFooter({ id: "e2b", connected: false })).toBeUndefined();
    expect(providerFooter({ id: "e2b", connected: true, domain: "e2b.acme.internal" })).toEqual({ text: "Self-hosted at e2b.acme.internal", problem: false });
    expect(providerFooter({ id: "daytona", connected: true, check: { ok: false, at, message: "Daytona refused the key (401).", fix: "make a new one" } })).toEqual({
      text: "Daytona refused the key (401). Make a new one.",
      problem: true,
    });
    expect(providerFooter({ id: "revyl", connected: true, check: { ok: false, at } })).toEqual({ text: "Revyl didn't take the key.", problem: true });
  });
});

describe("what runs where", () => {
  it("says where agents go: the machines, then each connected provider with room", () => {
    expect(agentsWhere([sb("e2b", false), sb("boat", false)])).toBe("Your machines");
    expect(agentsWhere([sb("daytona", true, 5), sb("e2b", true, 20)])).toBe("Your machines first, then E2B, then Daytona");
  });

  it("makes a phone kind a choice only while Revyl is connected or its route still names it", () => {
    expect(routeChosen(false, "ours_only")).toBe(false);
    expect(routeChosen(true, "ours_only")).toBe(true);
    expect(routeChoices(true, "ours_only").map((c) => c.label)).toEqual(["Your machines first, then Revyl", "Your machines", "Revyl only"]);
    expect(routeChoices(false, "revyl_only").map((c) => c.label)).toEqual(["Your machines", "Revyl only"]);
  });

  it("keeps recordings for a number of days, the one set among them", () => {
    expect(daysChoices(30)).toEqual([7, 14, 30, 60, 90, 180, 365]);
    expect(daysChoices(45)).toContain(45);
  });
});
