import { describe, expect, it } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import {
  appliedLine,
  changeLine,
  clampMax,
  extrasLine,
  extrasOver,
  fleetTop,
  fleetWarning,
  machineAgents,
  machineHolds,
  machineSource,
  pauseLine,
  projectAgents,
  serialNote,
  sourceLine,
} from "./agentsModel";

const storefront = { machineId: "devbox", projectId: "storefront" };
const billing = { machineId: "devbox", projectId: "billing" };
const slots: SlotState = {
  cap: 12,
  used: 8,
  queued: 1,
  perProject: [
    { projectRef: storefront, maxAgents: 6, running: 6, queued: 2 },
    { projectRef: billing, maxAgents: 12, running: 2, queued: 0 },
  ],
};

describe("machines", () => {
  // devbox: 60 GB, whose memory term fits 22; a project there set to 30 under a fleet cap of 50.
  const devbox = { machineId: "devbox", cap: 22, auto: 22, running: 22, why: "memory 60 GB, about 2 GB an agent" };
  const fleet: SlotState = {
    cap: 50,
    fleetCap: 50,
    used: 22,
    queued: 8,
    perMachine: [devbox, { machineId: "builder", cap: 40, maxAgents: 40, auto: 28, running: 0, why: "28 of 32 CPUs" }],
    perProject: [{ projectRef: storefront, maxAgents: 30, own: true, running: 22, queued: 8 }],
  };

  it("says where each machine's number comes from in plain words", () => {
    expect(machineSource(devbox)).toBe("Auto: memory 60 GB, about 2 GB an agent.");
    expect(machineAgents(fleet)).toEqual([
      { machineId: "devbox", cap: 22, set: false, auto: 22, running: 22, source: "Auto: memory 60 GB, about 2 GB an agent." },
      { machineId: "builder", cap: 40, set: true, auto: 28, running: 0, source: "Set by you. Auto would be 28: 28 of 32 CPUs." },
    ]);
    // A hub from before machine caps sends none.
    expect(machineAgents(slots)).toEqual([]);
  });

  it("lets a project's slider go to the fleet cap, and says when its machine holds it below", () => {
    const a = projectAgents(fleet, storefront);
    expect(a).toMatchObject({ max: 30, cap: 22, machineCap: 22, top: 50, limit: 22, own: true });
    expect(a).toMatchObject({ running: 22, queued: 8 });
    expect(machineHolds(a, 22, "devbox")).toBeNull();
    // Raising it while devbox runs its 22: the queued wait for the machine, not start.
    expect(changeLine(a, 40)).toBe("Up to 40 at once, but its machine runs 22 at most: the 8 queued wait for it.");
    const room = projectAgents(
      { ...fleet, used: 20, perMachine: [{ ...devbox, running: 20 }], perProject: [{ projectRef: storefront, maxAgents: 20, own: true, running: 20, queued: 8 }] },
      storefront,
    );
    expect(changeLine(room, 40)).toBe("Up to 40 at once. 2 of the 8 queued can start now; the rest wait for its machine.");
    expect(changeLine(room, 21)).toBe("Up to 21 at once. 1 of the 8 queued can start now.");
    // Under a fleet cap below devbox's, the fleet holds them.
    const fleet20: SlotState = { ...fleet, cap: 20, fleetCap: 20, perProject: [{ projectRef: storefront, maxAgents: 19, own: true, running: 20, queued: 8 }] };
    expect(changeLine(projectAgents(fleet20, storefront), 20)).toBe("Up to 20 at once, but the whole fleet runs 20 at most: the 8 queued wait for it.");
    expect(machineHolds(a, 30, "devbox")).toBe("devbox runs at most 22 agents at once, so this project runs 22 until an admin raises devbox.");
    // A busy project on the default: its row says the fleet's number, and it follows its machine's.
    const busy = { projectRef: billing, maxAgents: 50, own: false, running: 2, queued: 0 };
    expect(projectAgents({ ...fleet, perProject: [busy] }, billing)).toMatchObject({ max: 22, cap: 22, limit: 22, own: false });
  });

  it("counts every project's agents on the machine when saying how many queued start", () => {
    // storefront and billing share devbox's 22: 10 and 10 run, so 2 slots are free whatever storefront's max.
    const shared: SlotState = {
      ...fleet,
      used: 20,
      perMachine: [{ ...devbox, running: 20 }],
      perProject: [
        { projectRef: storefront, maxAgents: 10, own: true, running: 10, queued: 8 },
        { projectRef: billing, maxAgents: 22, own: false, running: 10, queued: 0 },
      ],
    };
    const a = projectAgents(shared, storefront);
    expect(a).toMatchObject({ running: 10, free: 2 });
    expect(changeLine(a, 30)).toBe("Up to 30 at once. 2 of the 8 queued can start now; the rest wait for its machine.");
    expect(changeLine(a, 15)).toBe("Up to 15 at once. 2 of the 8 queued can start now; the rest wait for its machine.");
    expect(changeLine(a, 11)).toBe("Up to 11 at once. 1 of the 8 queued can start now.");
    // Full with billing's too: none start.
    const full = projectAgents({ ...shared, used: 22, perMachine: [{ ...devbox, running: 22 }] }, storefront);
    expect(changeLine(full, 30)).toBe("Up to 30 at once, but its machine runs 22 at most: the 8 queued wait for it.");
  });
});

describe("max agents", () => {
  it("reads a project's max, and the fleet cap when it has none of its own", () => {
    const at12 = { cap: 12, machineCap: 12, top: 12 };
    expect(projectAgents(slots, storefront)).toEqual({ running: 6, queued: 2, max: 6, limit: 6, free: 4, ...at12, own: true });
    expect(projectAgents(slots, billing)).toEqual({ running: 2, queued: 0, max: 12, limit: 12, free: 4, ...at12, own: false });
    expect(projectAgents(slots, { machineId: "devbox", projectId: "new" })).toEqual({ running: 0, queued: 0, max: 12, limit: 12, free: 4, ...at12, own: false });
    // A share above a cap lowered later is held to the cap.
    expect(projectAgents({ ...slots, cap: 4 }, storefront).max).toBe(4);
  });

  it("holds a project to its machine's cap, and a project at that cap has no max of its own", () => {
    const machines: SlotState = {
      cap: 20,
      used: 0,
      queued: 0,
      perMachine: [
        { machineId: "devbox", cap: 6, auto: 6, running: 0, why: "memory 18 GB" },
        { machineId: "builder", cap: 14, auto: 14, running: 0, why: "14 of 16 CPUs" },
      ],
      perProject: [
        { projectRef: storefront, maxAgents: 6, running: 0, queued: 0 },
        { projectRef: billing, maxAgents: 3, running: 0, queued: 0 },
      ],
    };
    // No fleet cap: the sliders go past what the machines fit, to 64.
    const on6 = { cap: 6, machineCap: 6, top: 64, free: 6 };
    expect(projectAgents(machines, storefront)).toEqual({ running: 0, queued: 0, max: 6, limit: 6, ...on6, own: false });
    expect(projectAgents(machines, billing)).toEqual({ running: 0, queued: 0, max: 3, limit: 3, ...on6, own: true });
    expect(projectAgents(machines, { machineId: "builder", projectId: "new" }).max).toBe(14);
    // A fleet cap below the machine's holds the project to it.
    expect(projectAgents({ ...machines, cap: 4, fleetCap: 4 }, storefront)).toMatchObject({ max: 4, cap: 4, top: 4, own: false });
  });

  it("takes whether a max is the project's own from the hub, even at the top of its slider", () => {
    // storefront set to 12 when the fleet was 12; billing busy on the default.
    const hub: SlotState = {
      cap: 12,
      fleetCap: 12,
      used: 8,
      queued: 0,
      perProject: [
        { projectRef: storefront, maxAgents: 12, own: true, running: 6, queued: 0 },
        { projectRef: billing, maxAgents: 12, own: false, running: 2, queued: 0 },
      ],
    };
    const own = projectAgents(hub, storefront);
    expect(own).toMatchObject({ max: 12, cap: 12, own: true });
    expect(sourceLine(hub, own)).toBe("Set for this project. The default is 12.");
    const follows = projectAgents(hub, billing);
    expect(follows).toMatchObject({ max: 12, own: false });
    expect(sourceLine(hub, follows)).toBe("Follows the default: the whole fleet's cap.");
    // The fleet raised to 20 on a machine that runs 16: the default is the machine's, and storefront keeps its 12.
    const raised: SlotState = {
      ...hub,
      cap: 20,
      fleetCap: 20,
      perMachine: [{ machineId: "devbox", cap: 16, auto: 16, running: 8, why: "memory 34 GB" }],
      perProject: [...hub.perProject.slice(0, 1), { projectRef: billing, maxAgents: 16, own: false, running: 2, queued: 0 }],
    };
    expect(projectAgents(raised, storefront)).toMatchObject({ running: 6, limit: 12 });
    expect(projectAgents(raised, billing)).toMatchObject({ running: 2, limit: 16 });
    expect(sourceLine(raised, projectAgents(raised, billing))).toBe("Follows the default: its machine's cap, within the whole fleet's.");
    expect(sourceLine(raised, projectAgents(raised, storefront))).toBe("Set for this project. The default is 16.");
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

  it("keeps a slider value within 1 and the fleet cap", () => {
    expect(clampMax(0, 12)).toBe(1);
    expect(clampMax(40, 12)).toBe(12);
    expect(clampMax(3.6, 12)).toBe(4);
    expect(clampMax(5, 0)).toBe(1);
  });

  it("says what an applied change did, and what the agents over a lowered max do", () => {
    expect(appliedLine("Max agents", 6, 3)).toBe("Max agents: 3, was 6.");
    expect(extrasLine(2, 0)).toBe("2 agents over it finish their current work first.");
    expect(extrasLine(1, 0)).toBe("1 agent over it finishes its current work first.");
    expect(extrasLine(0, 0)).toBeNull();
    // Once paused, the paused count is what matters, even as the running count catches up.
    expect(extrasLine(0, 2)).toBe("2 agents saved their work and wait for room.");
  });

  it("warns when the fleet cap is below a project's own max", () => {
    const name = (r: { projectId: string }) => r.projectId;
    expect(fleetWarning(slots, 12, name)).toBeNull();
    expect(fleetWarning(slots, 8, name)).toBe("Below billing's max of 12: it runs at most 8 until you raise this.");
    expect(fleetWarning(slots, 4, name)).toBe("Below the max of storefront and billing: they run at most 4 until you raise this.");
    const three = { ...slots, perProject: [...slots.perProject, { projectRef: { machineId: "m", projectId: "docs" }, maxAgents: 9, running: 0, queued: 0, used: 0 }] };
    expect(fleetWarning(three, 4, name)).toBe("Below the max of 3 projects: they run at most 4 until you raise this.");
  });

  it("doesn't warn for a project on the default, which follows the fleet cap down", () => {
    const name = (r: { projectId: string }) => r.projectId;
    const hub: SlotState = {
      cap: 12,
      fleetCap: 12,
      used: 8,
      queued: 0,
      perProject: [
        { projectRef: storefront, maxAgents: 10, own: true, running: 6, queued: 0 },
        { projectRef: billing, maxAgents: 12, own: false, running: 2, queued: 0 },
      ],
    };
    expect(fleetWarning(hub, 8, name)).toBe("Below storefront's max of 10: it runs at most 8 until you raise this.");
    expect(fleetWarning(hub, 11, name)).toBeNull();
  });

  it("lets the fleet slider reach well past today's cap, and any cap set higher", () => {
    expect(fleetTop(12)).toBe(64);
    expect(fleetTop(200)).toBe(200);
  });
});
