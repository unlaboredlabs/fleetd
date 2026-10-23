import { describe, expect, it } from "vitest";
import { orderPhase, type PhaseInput } from "./phase";

const base: PhaseInput = { state: "running", openAsks: 0, lanes: [], hasTasks: true, prs: [], leadWorking: false };

describe("order phase", () => {
  it("follows the hub's first-match order", () => {
    expect(orderPhase({ ...base, openAsks: 2 })).toEqual({ phase: "waiting_on_you", detail: "2 questions" });
    expect(orderPhase({ ...base, state: "failed", headline: "CI is red" })).toEqual({ phase: "failed", detail: "CI is red" });
    expect(orderPhase({ ...base, state: "done", prs: [{ state: "merged", number: 4 }] })).toEqual({ phase: "done", detail: "1 PR merged" });
    const working = { role: "implementer", status: "working" } as const;
    const reviewer = { role: "reviewer", status: "starting" } as const;
    expect(orderPhase({ ...base, lanes: [working, reviewer] }).phase).toBe("working");
    expect(orderPhase({ ...base, lanes: [reviewer] })).toEqual({ phase: "reviewing", detail: "1 reviewing" });
    expect(orderPhase({ ...base, prs: [{ state: "ci", number: 212 }] })).toEqual({ phase: "merging", detail: "#212 in CI" });
    expect(orderPhase({ ...base, state: "verifying" }).phase).toBe("verifying");
  });

  it("is queued only when every live lane is, and planning while the lead works on an order with no tasks", () => {
    const queued = { role: "implementer", status: "queued", statusReason: "fleet cap: 40 of 40 running" } as const;
    const done = { role: "implementer", status: "done" } as const;
    expect(orderPhase({ ...base, lanes: [queued, done] })).toEqual({ phase: "queued", detail: "queued: fleet cap: 40 of 40 running" });
    expect(orderPhase({ ...base, hasTasks: false, leadWorking: true }).phase).toBe("planning");
    expect(orderPhase({ ...base, state: "draft" }).phase).toBe("planning");
    expect(orderPhase(base)).toEqual({ phase: "idle", detail: "waiting for the lead" });
  });
});
