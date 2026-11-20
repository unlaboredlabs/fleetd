import { describe, expect, it } from "vitest";
import {
  tailnetValue,
  tailnetWaiting,
  canWords,
  daysChoices,
  limitChoices,
  LINUX,
  linuxChoices,
  linuxValue,
  limitWords,
  MAC,
  machinesShown,
  machineValue,
  providerFooter,
  providerName,
  providersFooter,
  providersOf,
  providerValue,
  specOf,
} from "./machines";

const at = "2026-11-17T09:00:00.000Z";
const sb = (provider: string, connected: boolean, limit = connected ? 5 : 0) => ({ provider, connected, limit });
const BOX = "box";
const BILLING = { what: "start", reason: "billing", message: "boat.dev refused: billing isn't set up on the account", fix: "set up billing in boat.dev's dashboard" };

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
    const list = providersOf({ boxPubKey: BOX, placing: true, providers: [sb("boat", true, 20)] });
    expect(list.map((p) => p.id)).toEqual(["boat"]);
    expect(["boat", "modal"].map(providerName)).toEqual(["boat.dev", "modal"]);
    expect(canWords(specOf("boat"))).toBe("Agents · Browser · Linux desktop · Android");
    // A hub without sandbox_get lists none.
    expect(providersOf(undefined)).toEqual([]);
  });

  it("says each one's real state, as the desktop's row: not connected, starting, how many run, its account, or why it can't", () => {
    const online = { status: "online" } as const;
    expect(providerValue({ id: "boat", connected: false, limit: 0 })).toEqual({ text: "Not connected", problem: false });
    expect(providerValue({ id: "boat", connected: true, limit: 20, running: 3 }, online)).toEqual({ text: "3 of 20 running", problem: false });
    expect(providerValue({ id: "boat", connected: true, limit: 20 })).toEqual({ text: "0 of 20 running", problem: false });
    expect(providerValue({ id: "modal", connected: true })).toEqual({ text: "Connected", problem: false });
    expect(providerValue({ id: "boat", connected: true, limit: 20 }, { status: "degraded", degradedCause: "starting" })).toEqual({ text: "Starting…", problem: false });
    expect(providerValue({ id: "boat", connected: true, limit: 20 }, { status: "degraded", degradedCause: "claude_login" })).toEqual({ text: "Needs a Claude account", problem: false, warn: true });
    expect(providerValue({ id: "boat", connected: true, limit: 20, trouble: BILLING }, online)).toEqual({ text: "Couldn't start", problem: true });
    expect(providerValue({ id: "boat", connected: true, limit: 5, check: { ok: false, at } })).toEqual({ text: "Key refused", problem: true });
  });

  it("says what they cost and the order, and no stale line about agents not running there", () => {
    expect(providersFooter({})).toContain("which bill you");
    expect(providersFooter({})).not.toContain("yet");
    // A provider fleetd removed that the hub had connected: its line after them, for as long as the hub lists it.
    const gone = "Revyl was removed from fleetd, with the key you connected: iOS simulators run on a Mac machine, Android on a Linux machine.";
    expect(providersFooter({ removed: [gone] }).endsWith(`once your machines are full.\n\n${gone}`)).toBe(true);
  });

  it("offers none up to 500, keeping one set that isn't a step", () => {
    expect(limitChoices(5)[0]).toBe(0);
    expect(limitChoices(5).at(-1)).toBe(500);
    expect(limitChoices(7)).toContain(7);
    expect(limitWords(0)).toBe("None");
    expect(limitWords(20)).toBe("20");
  });

  it("puts a failed check with its fix on a provider's screen, else nothing", () => {
    expect(providerFooter({ id: "boat", connected: false })).toBeUndefined();
    expect(providerFooter({ id: "boat", connected: true, check: { ok: true, at } })).toBeUndefined();
    expect(providerFooter({ id: "boat", connected: true, check: { ok: false, at, message: "boat.dev refused the key.", fix: "make a new key in boat.dev's dashboard and connect it again" } })).toEqual({
      text: "boat.dev refused the key. Make a new key in boat.dev's dashboard and connect it again.",
      problem: true,
      action: "test",
    });
    expect(providerFooter({ id: "boat", connected: true, check: { ok: false, at } })).toEqual({ text: "boat.dev didn't take the key.", problem: true, action: "test" });
    // A refusal at boat.dev: why, its fix and Try again; no Claude account: Connect; starting or ready, nothing.
    expect(providerFooter({ id: "boat", connected: true, limit: 20, trouble: BILLING }, { status: "online" })).toEqual({
      text: "Couldn't start: boat.dev refused: billing isn't set up on the account. Set up billing in boat.dev's dashboard.",
      problem: true,
      action: "retry",
    });
    expect(providerFooter({ id: "boat", connected: true, limit: 20 }, { status: "degraded", degradedCause: "claude_login" })).toEqual({ text: "Needs a Claude account", problem: false, action: "connect" });
    expect(providerFooter({ id: "boat", connected: true, limit: 20 }, { status: "degraded", degradedCause: "starting" })).toBeUndefined();
    expect(providerFooter({ id: "boat", connected: true, limit: 20, running: 2 }, { status: "online" })).toBeUndefined();
  });
});

describe("what runs where", () => {
  it("is two rows: the Linux machine a pick once there is more than one place, the Mac machine a value", () => {
    expect(linuxChoices([sb("boat", true)], true).map((c) => c.label)).toEqual(["Your machines", "Your machines first, then boat.dev", "boat.dev only"]);
    expect(linuxChoices([sb("boat", false)], true)).toHaveLength(1);
    expect(linuxValue([sb("boat", false)], false)).toBe("None yet");
    expect([LINUX, MAC]).toEqual(["Linux machine", "Mac machine"]);
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

  it("says what to do when it's connected but its sign-in can't be kept (a locked vault)", () => {
    const v = tailnetValue({ status: "connected", tailnet: "example.com", device: "fleetd", problem: "Connected, but its sign-in isn't kept: the vault is locked" });
    expect(v).toEqual({ text: "Connected", detail: "example.com · as fleetd. Connected, but its sign-in isn't kept: the vault is locked.", problem: false });
  });

  it("reads again only while it waits on a sign-in or an approval", () => {
    expect(tailnetWaiting({ status: "login" })).toBe(true);
    expect(tailnetWaiting({ status: "approve" })).toBe(true);
    expect(tailnetWaiting({ status: "connected" })).toBe(false);
    expect(tailnetWaiting(undefined)).toBe(false);
  });
});
