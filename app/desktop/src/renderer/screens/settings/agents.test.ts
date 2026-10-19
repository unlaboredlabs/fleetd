import { describe, expect, it } from "vitest";
import type { SlotState } from "../../../shared/contracts";
import { agentsLabel, changeLine, clampMax, extrasOver, pauseLine, projectAgents, serialNote } from "./agents";

const storefront = { machineId: "devbox", projectId: "storefront" };
const billing = { machineId: "devbox", projectId: "billing" };
const slots: SlotState = {
  cap: 12,
  used: 8,
  queued: 1,
  reservedBand: 2,
  perProject: [
    { projectRef: storefront, maxAgents: 6, running: 6, queued: 2, used: 7 },
    { projectRef: billing, maxAgents: 12, running: 2, queued: 0, used: 3 },
  ],
};

describe("max agents", () => {
  it("reads a project's max, and the fleet cap when it has none of its own", () => {
    expect(projectAgents(slots, storefront)).toEqual({ running: 6, queued: 2, max: 6, cap: 12, own: true });
    expect(projectAgents(slots, billing)).toEqual({ running: 2, queued: 0, max: 12, cap: 12, own: false });
    expect(projectAgents(slots, { machineId: "devbox", projectId: "new" })).toEqual({ running: 0, queued: 0, max: 12, cap: 12, own: false });
    // A share above a cap lowered later is held to the cap.
    expect(projectAgents({ ...slots, cap: 4 }, storefront).max).toBe(4);
    expect(agentsLabel(projectAgents(slots, storefront))).toBe("agents 6 / 6 · 2 waiting");
    expect(agentsLabel(projectAgents(slots, billing))).toBe("agents 2 / 12");
  });

  it("says that lowering below the running count lets them finish and makes new ones wait", () => {
    const a = projectAgents(slots, storefront);
    expect(extrasOver(6, 4)).toBe(2);
    expect(extrasOver(2, 4)).toBe(0);
    expect(changeLine(a, 4)).toBe("6 running now, 2 over the new max: they finish their current work, and new agents wait until fewer than 4 run.");
    expect(changeLine(a, 9)).toBe("Up to 9 at once. 2 of the 2 waiting can start now.");
    expect(changeLine(projectAgents(slots, billing), 6)).toBe("Up to 6 at once. New agents wait while 6 run.");
    expect(pauseLine(2)).toMatch(/^Pause the 2 extras now/u);
    expect(changeLine(a, 6)).toBe("6 agents running now, 2 waiting for a slot.");
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
});
