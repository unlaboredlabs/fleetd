import { describe, expect, it } from "vitest";
import {
  atOnceWord,
  computerStateWord,
  FLEETD,
  MAC_OWN_ONLY,
  providedChoices,
  providedValue,
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
  teamMachines,
} from "./machines";

const at = "2026-11-17T09:00:00.000Z";
const sb = (provider: string, connected: boolean, limit = connected ? 5 : 0) => ({ provider, connected, limit });
const BOX = "box";
const BILLING = { what: "start", reason: "billing", message: "fleetd's computers refused: billing isn't set up on the account", fix: "try again later" };

describe("Settings › Machines", () => {
  it("lists the team's computers, never the hub's runner for hosted sandboxes", () => {
    const ms = [{ machineId: "devbox", runner: false }, { machineId: "hosted", runner: true }, { machineId: "studio" }];
    expect(teamMachines(ms).map((m) => m.machineId)).toEqual(["devbox", "studio"]);
  });

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
  it("lists the sandbox providers, each named, with what it runs", () => {
    const list = providersOf({ boxPubKey: BOX, placing: true, providers: [sb("boat", true, 20)] });
    expect(list.map((p) => p.id)).toEqual(["boat"]);
    expect(["boat", "modal"].map(providerName)).toEqual(["fleetd's computers", "modal"]);
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
    expect(providerFooter({ id: "boat", connected: true, check: { ok: false, at, message: "fleetd's computers refused the key.", fix: "try again later" } })).toEqual({
      text: "fleetd's computers refused the key. Try again later.",
      problem: true,
      action: "test",
    });
    expect(providerFooter({ id: "boat", connected: true, check: { ok: false, at } })).toEqual({ text: "fleetd's computers didn't take the key.", problem: true, action: "test" });
    // A refusal at boat.dev: why, its fix and Try again; no Claude account: Connect; starting or ready, nothing.
    expect(providerFooter({ id: "boat", connected: true, limit: 20, trouble: BILLING }, { status: "online" })).toEqual({
      text: "Couldn't start: fleetd's computers refused: billing isn't set up on the account. Try again later.",
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
    expect(linuxChoices([sb("boat", true)], true).map((c) => c.label)).toEqual(["Your machines", "Your machines first, then fleetd's computers", "fleetd's computers only"]);
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
  it("reads again only while it waits on a sign-in or an approval", () => {
    expect(tailnetWaiting({ status: "login" })).toBe(true);
    expect(tailnetWaiting({ status: "approve" })).toBe(true);
    expect(tailnetWaiting({ status: "connected" })).toBe(false);
    expect(tailnetWaiting(undefined)).toBe(false);
  });
});

describe("fleetd's computers on the phone, from the desktop's one model", () => {
  it("offers the team's own machines and fleetd's computers, and says Macs are the team's own", () => {
    expect(providedChoices("boat", true).map((c) => c.label)).toEqual(["Your machines", "Your machines first, then fleetd's computers", "fleetd's computers only"]);
    expect(providedChoices("boat", false)).toEqual([{ value: "boat", label: FLEETD }]);
    expect(providedValue(true)).toBe("Your machines and fleetd's computers");
    expect(MAC_OWN_ONLY).toBe("fleetd's computers don't run Macs");
  });

  it("counts what runs at once of the plan's, and says a bot's computer asleep or awake", () => {
    expect(atOnceWord([{ limit: 10, running: 2 }])).toBe("2 of 10 at once");
    expect(atOnceWord([{ limit: 0, running: 0 }])).toBeNull();
    expect(computerStateWord(true)).toBe("Asleep");
    expect(computerStateWord(false, 2)).toBe("Awake · 2 agents");
  });
});
