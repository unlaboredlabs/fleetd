import { describe, expect, it } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import {
  agentsLabel,
  appliedLine,
  changeLine,
  clampMax,
  extrasLine,
  extrasOver,
  fleetTop,
  fleetWarning,
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

describe("max agents", () => {
  it("reads a project's max, and the fleet cap when it has none of its own", () => {
    expect(projectAgents(slots, storefront)).toEqual({ running: 6, queued: 2, max: 6, cap: 12, own: true });
    expect(projectAgents(slots, billing)).toEqual({ running: 2, queued: 0, max: 12, cap: 12, own: false });
    expect(projectAgents(slots, { machineId: "devbox", projectId: "new" })).toEqual({ running: 0, queued: 0, max: 12, cap: 12, own: false });
    // A share above a cap lowered later is held to the cap.
    expect(projectAgents({ ...slots, cap: 4 }, storefront).max).toBe(4);
    expect(agentsLabel(projectAgents(slots, storefront))).toBe("agents 6 / 6 · 2 queued");
    expect(agentsLabel(projectAgents(slots, billing))).toBe("agents 2 / 12");
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
    expect(projectAgents(machines, storefront)).toEqual({ running: 0, queued: 0, max: 6, cap: 6, own: false });
    expect(projectAgents(machines, billing)).toEqual({ running: 0, queued: 0, max: 3, cap: 6, own: true });
    expect(projectAgents(machines, { machineId: "builder", projectId: "new" }).max).toBe(14);
    // A fleet cap below the machine's holds the project to it.
    expect(projectAgents({ ...machines, cap: 4 }, storefront)).toMatchObject({ max: 4, cap: 4, own: false });
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
    expect(agentsLabel(projectAgents(raised, storefront))).toBe("agents 6 / 12");
    expect(agentsLabel(projectAgents(raised, billing))).toBe("agents 2 / 16");
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
