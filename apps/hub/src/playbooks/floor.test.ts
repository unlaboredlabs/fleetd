import { type Brief, type DecisionRule, type MachineId, researchOutcome } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { floorRefusal, withTierDefault } from "./floor.ts";
import { bundledDir, loadAll } from "./load.ts";
import { verdictText } from "./verdict.ts";

const playbooks = loadAll(bundledDir(), undefined);
const playbook = (name: "bugfix" | "feature" | "research" | "finish-all") => playbooks.get(name)!.playbook;

const brief = (doneWhen: Brief["doneWhen"], over: Partial<Brief> = {}): Brief =>
  ({ goal: "g", why: "w", pointers: [], constraints: [], doneWhen, tier: "S", ...over }) as Brief;

const cmd = { type: "cmd", machineId: "lab-a" as MachineId, argv: ["pnpm", "test"], expectExit: 0 } as const;
const test = { type: "test", repo: "wynn-dev/lab", testId: "readme typo" } as const;
const merged = { type: "pr_merged", repo: "wynn-dev/lab" } as const;
const judge = { type: "judge", criteria: "report p50 cold start for baseline and candidate" } as const;
const rule: DecisionRule = { better: "higher", goAtLeast: 0.1, stopBelow: 0.1 };
const research = { baseline: "the current cache", metric: "hit rate", decisionRule: rule, budget: { agentHours: 4 } };

describe("brief floor", () => {
  it("bugfix needs a test or cmd repro check", () => {
    expect(floorRefusal(playbook("bugfix"), brief([merged]))).toBe("bugfix needs a failing repro check (type test or cmd)");
    expect(floorRefusal(playbook("bugfix"), brief([merged, cmd]))).toBeUndefined();
    expect(floorRefusal(playbook("bugfix"), brief([test]))).toBeUndefined();
  });

  it("feature and finish-all add nothing to the base brief", () => {
    expect(floorRefusal(playbook("feature"), brief([merged]))).toBeUndefined();
    expect(floorRefusal(playbook("finish-all"), brief([{ type: "human", question: "is the backlog clear?" }]))).toBeUndefined();
  });

  it("research needs a judge check and the pre-registered fields, naming the missing ones", () => {
    expect(floorRefusal(playbook("research"), brief([judge], research))).toBeUndefined();
    expect(floorRefusal(playbook("research"), brief([merged], research))).toBe(
      "research needs a judge check that reports the metric for baseline and candidate (type judge)",
    );
    expect(floorRefusal(playbook("research"), brief([judge], { metric: "hit rate", budget: {} }))).toBe(
      "a research brief needs baseline, metric, decisionRule and budget.agentHours; missing baseline, decisionRule, budget.agentHours",
    );
  });

  it("fills a missing tier from the playbook and keeps a given one", () => {
    expect(withTierDefault({ goal: "g" }, playbook("feature"))).toEqual({ goal: "g", tier: "M" });
    expect(withTierDefault({ goal: "g", tier: "L" }, playbook("bugfix"))).toEqual({ goal: "g", tier: "L" });
  });
});

describe("research verdict", () => {
  it("counts a value exactly on the line as on it, despite float error", () => {
    // 0.6 − 0.5 is 0.09999999999999998 in floating point.
    expect(researchOutcome(rule, { baseline: 0.5, candidate: 0.6 })).toBe("go");
    expect(researchOutcome(rule, { baseline: 0.5, candidate: 0.5999 })).toBe("stop");
    expect(researchOutcome({ better: "lower", goAtLeast: 20, stopBelow: 5 }, { baseline: 120, candidate: 100 })).toBe("go");
    expect(researchOutcome({ better: "lower", goAtLeast: 20, stopBelow: 5 }, { baseline: 120, candidate: 110 })).toBe("inconclusive");
    expect(researchOutcome({ better: "lower", goAtLeast: 20, stopBelow: 5 }, { baseline: 120, candidate: 118 })).toBe("stop");
  });

  it("says what the verdict rests on, and for INCONCLUSIVE what would change it", () => {
    expect(verdictText("go", rule, { baseline: 0.5, candidate: 0.6 }, "hit rate")).toBe(
      "GO: candidate 0.6 vs baseline 0.5 on hit rate (higher is better): improvement 0.1, at least the go line 0.1.",
    );
    expect(verdictText("stop", rule, { baseline: 0.5, candidate: 0.52 }, undefined)).toBe(
      "STOP: candidate 0.52 vs baseline 0.5 (higher is better): improvement 0.02, below the stop line 0.1. STOP is a success: the question is answered.",
    );
    expect(verdictText("inconclusive", { better: "lower", goAtLeast: 20, stopBelow: 5 }, { baseline: 120, candidate: 110 }, "p50 ms")).toBe(
      "INCONCLUSIVE: candidate 110 vs baseline 120 on p50 ms (lower is better): improvement 10, between the stop line 5 and the go line 20. An improvement of at least 20 would make it GO; one below 5 would make it STOP.",
    );
  });
});
