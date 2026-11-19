import { describe, expect, it } from "vitest";
import {
  tailnetValue,
  tailnetWaiting,
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
    // The hub's runner with no Claude account: the cause in a few words, not the hub's sentence.
    const hosted = { status: "degraded", runner: true, degradedReason: "agents in hosted sandboxes run on a Claude account, and none reaches them. Fix: connect one" } as const;
    expect(machineValue({ ...hosted, degradedCause: "claude_login" })).toEqual({ text: "Needs a Claude account", warn: true });
    expect(machineValue(hosted)).toEqual({ text: "Agents in hosted sandboxes run on a Claude account, and none reaches them", warn: true });
  });
});

describe("its providers", () => {
  it("lists the sandbox providers, each named, with what it runs", () => {
    const list = providersOf({ boxPubKey: BOX, placing: true, providers: [sb("e2b", true, 20), sb("boat", false), sb("daytona", false)] });
    expect(list.map((p) => p.id)).toEqual(["e2b", "boat", "daytona"]);
    expect(["e2b", "boat", "daytona", "modal"].map(providerName)).toEqual(["E2B", "boat.dev", "Daytona", "modal"]);
    expect(canWords(specOf("e2b"))).toBe("Agents");
    // A hub without sandbox_get lists none.
    expect(providersOf(undefined)).toEqual([]);
    expect(takesDomain("e2b")).toBe(true);
    expect(takesDomain("boat")).toBe(false);
  });

  it("says each one's state: not connected, its limit, connected, or a check that failed", () => {
    expect(providerValue({ id: "boat", connected: false, limit: 0 })).toEqual({ text: "Not connected", problem: false });
    expect(providerValue({ id: "e2b", connected: true, limit: 20 })).toEqual({ text: "20 at once", problem: false });
    expect(providerValue({ id: "e2b", connected: true, limit: 0 })).toEqual({ text: "None at once", problem: false });
    expect(providerValue({ id: "modal", connected: true })).toEqual({ text: "Connected", problem: false });
    expect(providerValue({ id: "daytona", connected: true, limit: 5, check: { ok: false, at } })).toEqual({ text: "Check failed", problem: true });
  });

  it("says what they cost and the order, and that none runs agents yet while none does", () => {
    expect(providersFooter({ placing: true })).toContain("which bill you");
    expect(providersFooter({ placing: true })).not.toContain("yet");
    expect(providersFooter({ placing: false })).toContain("Agents don't run in hosted sandboxes yet");
    // A provider fleetd removed that the hub had connected: its line after them, for as long as the hub lists it.
    const gone = "Revyl was removed from fleetd, with the key you connected: iOS simulators run on a Mac machine, Android on a Linux machine.";
    expect(providersFooter({ placing: true, removed: [gone] }).endsWith(`once your machines are full.\n\n${gone}`)).toBe(true);
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
    expect(providerFooter({ id: "boat", connected: true, check: { ok: false, at } })).toEqual({ text: "boat.dev didn't take the key.", problem: true });
  });
});

describe("what runs where", () => {
  it("says where agents go: the machines, then each connected provider with room", () => {
    expect(agentsWhere([sb("e2b", false), sb("boat", false)])).toBe("Your machines");
    expect(agentsWhere([sb("daytona", true, 5), sb("e2b", true, 20)])).toBe("Your machines first, then E2B, then Daytona");
  });

  it("keeps recordings for a number of days, the one set among them", () => {
    expect(daysChoices(30)).toEqual([7, 14, 30, 60, 90, 180, 365]);
    expect(daysChoices(45)).toContain(45);
  });
});

describe("Tailscale", () => {
  it("says it's connected with the tailnet's name, and only what the person needs now otherwise", () => {
    expect(tailnetValue({ status: "off" })).toEqual({ text: "Not connected", problem: false });
    expect(tailnetValue({ status: "connected", tailnet: "example.com", device: "fleetd" })).toEqual({ text: "Connected", detail: "example.com · as fleetd", problem: false });
    expect(tailnetValue({ status: "login", loginUrl: "https://login.tailscale.com/a/x" }).text).toBe("Sign in");
    expect(tailnetValue({ status: "failed", problem: "it ended" })).toEqual({ text: "Not working", detail: "it ended", problem: true });
    expect(tailnetValue({ status: "off", problem: "Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64)" })).toEqual({
      text: "Not available",
      detail: "Tailscale's gateway runs on Linux hubs, and this hub runs on darwin (arm64).",
      problem: false,
    });
  });

  it("reads again only while it waits on a sign-in or an approval", () => {
    expect(tailnetWaiting({ status: "login" })).toBe(true);
    expect(tailnetWaiting({ status: "approve" })).toBe(true);
    expect(tailnetWaiting({ status: "connected" })).toBe(false);
    expect(tailnetWaiting(undefined)).toBe(false);
  });
});
