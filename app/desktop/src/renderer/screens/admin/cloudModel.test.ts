import { describe, expect, it } from "vitest";
import type { CloudMachine, CloudView } from "../../../shared/contracts";
import { cloudStatusLine, costPreview, heldLine, machineLine, money, ownMachines, parseDollars, resettable, stateTone, stateWord, stopAllLine } from "./cloudModel";

const machine = (machineId: string, state: CloudMachine["state"], more: Partial<CloudMachine> = {}): CloudMachine => ({ machineId, state, agents: 0, screens: 0, today: 0, ...more });

const view = (more: Partial<CloudView> = {}): CloudView => ({
  boxPubKey: "A".repeat(43) + "=",
  environmentDefault: "fleetd-devbox",
  hasKey: true,
  enabled: true,
  poolSize: 3,
  machineType: "large",
  dayBudget: 3,
  monthBudget: 20,
  monthIsPlan: true,
  projects: [],
  today: 0.41,
  month: 6.1,
  machines: [machine("boat-1", "awake", { agents: 2, today: 0.3 }), machine("boat-2", "waking"), machine("boat-3", "asleep")],
  sizes: [
    { kind: "small", perHour: 0.018 },
    { kind: "default", perHour: 0.036 },
    { kind: "large", perHour: 0.072 },
    { kind: "xlarge", perHour: 0.2 },
  ],
  planDollars: 20,
  ...more,
});

describe("Settings › Hub › Machines' cloud model", () => {
  it("lists the person's own machines apart from the cloud ones", () => {
    const machines = [{ machineId: "devbox" }, { machineId: "boat-1" }, { machineId: "laptop" }, { machineId: "boat-3" }, { machineId: "boat-4", cloud: true }];
    expect(ownMachines(machines, view()).map((m) => m.machineId)).toEqual(["devbox", "laptop"]);
    // Before the pool answers, the machines the hub marks as cloud are left out still.
    expect(ownMachines(machines, undefined).map((m) => m.machineId)).toEqual(["devbox", "boat-1", "laptop", "boat-3"]);
  });

  it("names each state, reads asleep as calm and broken as wanting a fix, and offers Reset only where it helps", () => {
    expect(stateWord("asleep")).toBe("Asleep");
    expect(stateWord("creating")).toBe("Setting up");
    expect(stateWord("hibernating")).toBe("hibernating");
    expect(stateTone("awake")).toBe("success");
    expect(stateTone("asleep")).toBe("quiet");
    expect(stateTone("broken")).toBe("danger");
    expect(["broken", "failed", "gone"].every(resettable)).toBe(true);
    expect(["awake", "waking", "asleep", "creating", "stopping"].some(resettable)).toBe(false);
  });

  it("says under each machine what runs there, or that it sleeps for free, and what it cost today", () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    expect(machineLine(machine("boat-1", "awake", { agents: 2, screens: 1, today: 0.3 }), now)).toBe("2 agents running · 1 screen · $0.30 today");
    expect(machineLine(machine("boat-1", "awake", { agents: 1 }), now)).toBe("1 agent running · $0.00 today");
    expect(machineLine(machine("boat-1", "awake"), now)).toBe("Idle, sleeps after 15 minutes · $0.00 today");
    expect(machineLine(machine("boat-2", "asleep", { sinceMs: new Date(2026, 10, 4, 14, 2).getTime(), today: 0.12 }), now)).toBe("Asleep since 14:02, costs nothing · $0.12 today");
    expect(machineLine(machine("boat-3", "broken"), now)).toContain("Reset deletes it");
    expect(machineLine(machine("boat-3", "failed", { note: "its setup failed: claude" }), now)).toBe("Not made: its setup failed: claude");
    // When it was refused, or began setting up: an old refusal reads as old.
    const at = new Date(2026, 10, 4, 14, 5).getTime();
    expect(machineLine(machine("boat-1", "failed", { note: "boat.dev has no environment named fleetd-devbox", sinceMs: at }), now)).toBe("Not made (14:05): boat.dev has no environment named fleetd-devbox");
    expect(machineLine(machine("boat-1", "creating", { sinceMs: at }), now)).toBe("Setting up since 14:05: it joins in a few minutes, then sleeps");
  });

  it("puts the day's spend and the machines awake on one line, and none before the pool is set up", () => {
    expect(cloudStatusLine(view())).toBe("Cloud today: $0.41 of $3.00 · 2 awake");
    expect(cloudStatusLine(view({ enabled: false }))).toBe("Cloud today: $0.41 of $3.00 · off");
    expect(cloudStatusLine(view({ hasKey: false }))).toBeNull();
    expect(cloudStatusLine(view({ enabled: false, machines: [] }))).toBeNull();
    expect(cloudStatusLine(undefined)).toBeNull();
  });

  it("says why starts wait: a pause first, the hub's hold only while on", () => {
    expect(heldLine(view({ held: "cloud paused: today's boat.dev budget ($3.00) is spent" }))).toBe("Cloud paused: today's boat.dev budget ($3.00) is spent");
    expect(heldLine(view({ enabled: false, held: "cloud machines are off" }))).toBeNull();
    expect(heldLine(view({ enabled: false, paused: "boat.dev needs billing attention" }))).toBe("Boat.dev needs billing attention");
    expect(heldLine(view())).toBeNull();
  });

  it("shows the ceiling, the budget that stops it and a typical day before the pool is turned on", () => {
    const p = costPreview(view(), { poolSize: 3, machineType: "large", dayBudget: 3, monthBudget: undefined });
    expect(p.perHour).toBe("$0.072 an hour a machine (large)");
    expect(p.ceiling).toBe("At most $5.18 a day, if all 3 stayed awake around the clock.");
    expect(p.stops).toBe("The day budget stops them at $3.00.");
    expect(p.typical).toBe("A typical busy day: 5.5–10 machine-hours, about $0.40–$0.72.");
    expect(p.month).toBe("Up to $20.00 a month: your plan's included dollars.");
    // One small machine never reaches the budget: nothing to stop.
    const small = costPreview(view(), { poolSize: 1, machineType: "small", dayBudget: 3, monthBudget: 10 });
    expect(small.ceiling).toBe("At most $0.43 a day, if it stayed awake around the clock.");
    expect(small.stops).toBeNull();
    expect(small.month).toBe("Up to $10.00 a month.");
  });

  it("reads dollars as typed and refuses anything else", () => {
    expect(parseDollars("3")).toBe(3);
    expect(parseDollars(" $2.50 ")).toBe(2.5);
    expect(parseDollars("0")).toBeNull();
    expect(parseDollars("-1")).toBeNull();
    expect(parseDollars("2.505")).toBeNull();
    expect(parseDollars("three")).toBeNull();
    expect(money(5.184)).toBe("$5.18");
    expect(money(Number.NaN)).toBe("$0.00");
  });

  it("names the machines the kill switch stops, and says it asks boat.dev itself", () => {
    expect(stopAllLine(view())).toMatch(/^boat-1, boat-2 are awake now/u);
    expect(stopAllLine(view())).toContain("every machine with this hub's label");
    expect(stopAllLine(view({ machines: [machine("boat-1", "asleep")] }))).toMatch(/^None is awake now\./u);
  });
});
