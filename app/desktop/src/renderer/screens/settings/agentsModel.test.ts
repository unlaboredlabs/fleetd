import { describe, expect, it } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import {
  aboveAutoLine,
  agentsLabel,
  appliedLine,
  changeLine,
  clampMax,
  diskLine,
  extrasLine,
  extrasOver,
  fleetAgents,
  fleetLine,
  fleetWarning,
  machineAgents,
  machineCap,
  machineHint,
  machineLine,
  pauseLine,
  projectAgents,
  projectAutoLine,
  serialNote,
  sliderTop,
} from "./agentsModel";

const storefront = { machineId: "devbox", projectId: "storefront" };
const billing = { machineId: "devbox", projectId: "billing" };
const docs = { machineId: "mbp", projectId: "docs" };
// Two machines: devbox fits 12 by its memory, mbp is set to 4 above the 2 its 8 GB fits. No fleet cap, so the
// hub's `cap` is their total, 16.
const slots: SlotState = {
  cap: 16,
  used: 9,
  queued: 2,
  perMachine: [
    { machineId: "mbp", cap: 4, auto: 2, why: "memory 8 GB", running: 1, diskRoom: 6, set: true, source: "set" },
    { machineId: "devbox", cap: 12, auto: 12, why: "memory 32 GB", running: 8, diskRoom: 60, set: false, source: "memory" },
  ],
  perProject: [
    { projectRef: storefront, maxAgents: 6, running: 6, queued: 2, set: true },
    { projectRef: billing, maxAgents: 12, running: 2, queued: 0, set: false },
    { projectRef: docs, maxAgents: 4, running: 1, queued: 0, set: false },
  ],
};
const name = (id: string) => ({ devbox: "devbox", mbp: "MacBook Air" })[id] ?? id;
/** Each machine, by name; at least two, which every test here has. */
const machines = (s: SlotState) => {
  const [first, second, ...rest] = machineAgents(s, name);
  if (first === undefined) throw new Error("no machines");
  return [first, second ?? first, ...rest] as const;
};

describe("max agents per project", () => {
  it("reads a project's max, and its machine's cap when it has none of its own", () => {
    expect(projectAgents(slots, storefront)).toEqual({ running: 6, queued: 2, max: 6, top: 12, own: true });
    expect(projectAgents(slots, billing)).toEqual({ running: 2, queued: 0, max: 12, top: 12, own: false });
    expect(projectAgents(slots, { machineId: "devbox", projectId: "new" })).toEqual({ running: 0, queued: 0, max: 12, top: 12, own: false });
    // A max above a machine cap lowered later is held to the cap.
    expect(projectAgents({ ...slots, perMachine: [{ machineId: "devbox", cap: 4, auto: 12, why: "memory 32 GB", running: 8, set: true }] }, storefront).max).toBe(4);
    expect(agentsLabel(projectAgents(slots, storefront))).toBe("agents 6 / 6 · 2 queued");
    expect(agentsLabel(projectAgents(slots, billing))).toBe("agents 2 / 12");
    expect(projectAutoLine(projectAgents(slots, billing), "devbox")).toBe("Auto: up to devbox's cap of 12.");
  });

  // The regression #414 brought: `cap` became the machines' total, so a project on a smaller machine read as having
  // its own max (4 < 16), and its slider reached 16.
  it("never reads a project on a smaller machine as having its own max, and tops its slider at that machine's cap", () => {
    const a = projectAgents(slots, docs);
    expect(a.own).toBe(false);
    expect(a.max).toBe(4);
    expect(a.top).toBe(4);
    expect(machineCap(slots, "mbp")).toBe(4);
    // A max the hub says nobody set is auto, whatever its number; one a person set is theirs, even at the cap.
    expect(projectAgents({ ...slots, perProject: [{ projectRef: docs, maxAgents: 4, running: 1, queued: 0, set: true }] }, docs).own).toBe(true);
  });

  it("reads a hub from before machine caps: no machines, and the fleet cap tops every project", () => {
    const old: SlotState = { cap: 12, used: 8, queued: 1, perProject: [{ projectRef: storefront, maxAgents: 6, running: 6, queued: 2 }] };
    expect(projectAgents(old, storefront)).toEqual({ running: 6, queued: 2, max: 6, top: 12, own: false });
    expect(machineAgents(old, name)).toEqual([]);
    expect(fleetAgents(old)).toEqual({ cap: 12, fits: 12, used: 8, queued: 1 });
  });

  it("says that lowering below the running count lets them finish and makes new ones wait", () => {
    const a = projectAgents(slots, storefront);
    expect(extrasOver(6, 4)).toBe(2);
    expect(extrasOver(2, 4)).toBe(0);
    expect(changeLine(a, 4)).toBe("6 running now, 2 over the new max: they finish their current work, and new agents wait until fewer than 4 run.");
    expect(changeLine(a, 1)).toMatch(/new agents wait until none is running\.$/u);
    expect(changeLine(a, 9)).toBe("Up to 9 at once. 2 of the 2 queued can start now.");
    expect(changeLine(projectAgents(slots, billing), 6)).toBe("Up to 6 at once. New agents wait while 6 run.");
    expect(pauseLine(2)).toBe("Pause the 2 extras now");
    expect(pauseLine(1)).toBe("Pause the extra one now");
    expect(changeLine(a, 6)).toBe("6 agents running now, 2 queued.");
    expect(changeLine(projectAgents(slots, billing), 12)).toBe("2 agents running now.");
    expect(serialNote(1)).toMatch(/One agent at a time/u);
    expect(serialNote(2)).toBeNull();
  });

  it("keeps a slider value within 1 and its top", () => {
    expect(clampMax(0, 12)).toBe(1);
    expect(clampMax(40, 12)).toBe(12);
    expect(clampMax(3.6, 12)).toBe(4);
    expect(clampMax(5, 0)).toBe(1);
  });

  it("says what an applied change did, auto included, and what the agents over a lowered max do", () => {
    expect(appliedLine("Max agents", 6, 3)).toBe("Max agents: 3, was 6.");
    expect(appliedLine("Max agents", 3, "auto")).toBe("Max agents: auto, was 3.");
    expect(appliedLine("Whole fleet", "auto", 40, "no limit")).toBe("Whole fleet: 40, was no limit.");
    expect(extrasLine(2, 0)).toBe("2 agents over it finish their current work first.");
    expect(extrasLine(1, 0)).toBe("1 agent over it finishes its current work first.");
    expect(extrasLine(0, 0)).toBeNull();
    // Once paused, the paused count is what matters, even as the running count catches up.
    expect(extrasLine(0, 2)).toBe("2 agents saved their work and wait for room.");
  });
});

describe("max agents per machine", () => {
  it("lists each machine by name with its cap and what sets it", () => {
    const [devbox, mbp] = machines(slots);
    expect(devbox).toEqual({ machineId: "devbox", cap: 12, auto: 12, why: "memory 32 GB", running: 8, set: false, diskRoom: 60, source: "memory" });
    expect(mbp.machineId).toBe("mbp");
    expect(machineLine(devbox)).toBe("Auto: memory 32 GB.");
    expect(machineLine(mbp)).toBe("Set to 4. Auto would be 2 (memory 8 GB).");
    const cpu = { machineId: "ci", cap: 28, auto: 28, why: "28 of 32 CPUs", running: 0, set: false, diskRoom: undefined, source: "cpu" } as const;
    expect(machineLine(cpu)).toBe("Auto: 28 of 32 CPUs.");
    expect(machineHint(cpu)).toBeNull();
    expect(machineHint(devbox)).toBeNull();
  });

  it("says why auto reads low or odd, and what to do about it", () => {
    const old = { machineId: "pi", cap: 4, auto: 4, why: "memory unknown", running: 0, set: false, diskRoom: undefined, source: "unknown" } as const;
    expect(machineLine(old)).toBe("Auto: memory unknown.");
    expect(machineHint(old)).toBe("Its node doesn't report memory, so auto counts 4. Run fleetd update on it to size it by its memory.");
    // Set by hand, the old node still wants updating.
    expect(machineHint({ ...old, cap: 8, set: true, source: "set" })).toMatch(/Run fleetd update on it/u);
    expect(machineHint({ ...old, why: "not measured yet", source: "unmeasured" })).toBe("Its node hasn't reported yet; auto sizes it once it does.");
    expect(machineHint({ ...old, cap: 64, auto: 64, why: "top of 64", source: "top" })).toBe("Auto stops at 64. Set a number to run more.");
    // A hub that doesn't say what sets the cap: read from its why.
    const bare: SlotState = { ...slots, perMachine: [{ machineId: "pi", cap: 4, auto: 4, why: "memory unknown", running: 0 }] };
    expect(machineAgents(bare, name)[0]).toMatchObject({ set: false, source: "unknown" });
    const top: SlotState = { ...slots, perMachine: [{ machineId: "big", cap: 64, auto: 64, why: "top of 64", running: 0 }] };
    expect(machineAgents(top, name)[0]).toMatchObject({ source: "top" });
  });

  it("warns, in the design's words, when a number goes above what the machine fits", () => {
    const [devbox, mbp] = machines(slots);
    expect(aboveAutoLine(mbp, 4)).toBe("Above the 2 this machine's 8 GB fits.");
    expect(aboveAutoLine(mbp, 2)).toBeNull();
    expect(aboveAutoLine(devbox, 12)).toBeNull();
    expect(aboveAutoLine({ auto: 28, why: "28 of 32 CPUs" }, 30)).toBe("Above the 28 this machine's 32 CPUs fit.");
    expect(aboveAutoLine({ auto: 64, why: "top of 64" }, 80)).toBe("Above the 64 auto starts.");
  });

  it("says when free disk leaves room for fewer new agents than the cap", () => {
    // devbox: 8 of 12 running, room for 60 more; mbp: 1 of 4, room for 6.
    expect(machineAgents(slots, name).map(diskLine)).toEqual([null, null]);
    const at = (diskRoom: number | undefined) =>
      diskLine(machines({ ...slots, perMachine: [{ machineId: "devbox", cap: 12, auto: 12, why: "memory 32 GB", running: 8, ...(diskRoom === undefined ? {} : { diskRoom }), source: "memory" }] })[0]);
    expect(at(2)).toBe("Disk: room for 2 more now.");
    expect(at(0)).toBe("Disk: no room for more now. New agents wait until space frees.");
    expect(at(4)).toBeNull();
    expect(at(undefined)).toBeNull();
  });

  it("lets a slider reach past auto's 64, and any value set higher", () => {
    expect(sliderTop(12, 12)).toBe(64);
    expect(sliderTop(200, 12)).toBe(200);
  });
});

describe("the whole fleet", () => {
  it("is unset by default, next to what the machines fit; a saved cap shows as set", () => {
    expect(fleetAgents(slots)).toEqual({ cap: null, fits: 16, used: 9, queued: 2 });
    expect(fleetLine(fleetAgents(slots))).toBe("No limit: the machines fit 16 together.");
    const set = fleetAgents({ ...slots, cap: 10, fleetCap: 10 });
    expect(set).toEqual({ cap: 10, fits: 16, used: 9, queued: 2 });
    expect(fleetLine(set)).toBe("Set to 10 · the machines fit 16.");
  });

  it("warns when the fleet cap is below a max someone set", () => {
    const projectName = (r: { projectId: string }) => r.projectId;
    const own: SlotState = { ...slots, perProject: slots.perProject.map((p) => ({ ...p, set: true })) };
    expect(fleetWarning(own, 12, projectName)).toBeNull();
    // billing's 12 is its machine's cap, not a max of its own: nothing to warn about.
    expect(fleetWarning(slots, 8, projectName)).toBeNull();
    expect(fleetWarning(own, 8, projectName)).toBe("Below billing's max of 12: it runs at most 8 until you raise this.");
    expect(fleetWarning(own, 5, projectName)).toBe("Below the max of storefront and billing: they run at most 5 until you raise this.");
    expect(fleetWarning(own, 3, projectName)).toBe("Below the max of 3 projects: they run at most 3 until you raise this.");
  });
});
