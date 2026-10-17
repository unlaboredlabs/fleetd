import { describe, expect, it } from "vitest";
import { codexInstance, effortOption, otherCodex, type ProviderInstance, routeModel } from "../executor/ProviderList.ts";
import { CODED_RULES, gate, missingReviews, reviewPlan, type RoleReview, ruleFor } from "./rules.ts";

const P = "1".repeat(40);
const Q = "2".repeat(40);
const review = (taskId: string, role: RoleReview["role"], blocking = 0, patchId = P, receipts = role === "verifier"): RoleReview => ({
  taskId,
  role,
  patchId,
  blocking,
  receipts,
});

describe("tier matrix", () => {
  it("plans no review for S, one for M, and two reviewers plus a verifier for L with Codex as the second when there is one", () => {
    expect(reviewPlan(CODED_RULES.S, true)).toEqual([]);
    expect(reviewPlan(CODED_RULES.M, true)).toEqual([{ role: "reviewer", provider: "claude" }]);
    expect(reviewPlan(CODED_RULES.L, true).map((p) => `${p.role}/${p.provider}`)).toEqual(["reviewer/claude", "reviewer/codex", "verifier/claude"]);
    expect(reviewPlan(CODED_RULES.L, false).map((p) => `${p.role}/${p.provider}`)).toEqual(["reviewer/claude", "reviewer/claude", "verifier/claude"]);
    expect(missingReviews(reviewPlan(CODED_RULES.L, true), ["reviewer"]).map((p) => `${p.role}/${p.provider}`)).toEqual(["reviewer/codex", "verifier/claude"]);
    expect(missingReviews(reviewPlan(CODED_RULES.L, true), ["reviewer", "verifier", "reviewer"])).toEqual([]);
  });

  it("is ready only with the tier's clean verdicts bound to the current patch", () => {
    expect(gate("S", CODED_RULES.S, undefined, []).ready).toBe(true);
    expect(gate("M", CODED_RULES.M, P, [])).toMatchObject({ ready: false, waitingForHead: false });
    expect(gate("M", CODED_RULES.M, P, [review("T2", "reviewer")]).ready).toBe(true);
    // A clean review of another patch counts for nothing.
    expect(gate("M", CODED_RULES.M, Q, [review("T2", "reviewer")]).ready).toBe(false);

    const two = [review("T2", "reviewer"), review("T3", "reviewer")];
    expect(gate("L", CODED_RULES.L, P, two)).toMatchObject({ ready: false, why: "waiting for the verifier's clean verdict with receipts" });
    expect(gate("L", CODED_RULES.L, P, [...two, review("T4", "verifier", 0, P, false)]).ready).toBe(false);
    expect(gate("L", CODED_RULES.L, P, [...two, review("T4", "verifier")]).ready).toBe(true);
    // The same reviewer twice is one review.
    expect(gate("L", CODED_RULES.L, P, [review("T2", "reviewer"), review("T2", "reviewer"), review("T4", "verifier")]).ready).toBe(false);
  });

  it("holds a patch with any blocking verdict until the patch changes, and lets a waiver through otherwise", () => {
    const blocked = gate("M", CODED_RULES.M, P, [review("T2", "reviewer", 2), review("T3", "reviewer")]);
    expect(blocked).toEqual({ ready: false, waitingForHead: true, why: "blocking findings from T2 (2); waiting for a new head" });
    expect(gate("M", CODED_RULES.M, Q, [review("T2", "reviewer", 2, P), review("T5", "reviewer", 0, Q)]).ready).toBe(true);
    expect(gate("M", CODED_RULES.M, Q, [], "waived").ready).toBe(true);
  });
});

describe("playbook review rules", () => {
  const strict = {
    S: { reviewers: 1, verifier: false, planFirst: false },
    M: { reviewers: 2, verifier: true, planFirst: false },
    L: { reviewers: 3, verifier: true, planFirst: true },
  };

  it("takes the pinned playbook's rule for the tier, and the coded tiers without one", () => {
    expect(ruleFor("M", { reviewRules: strict })).toEqual(strict.M);
    expect(ruleFor("M")).toEqual(CODED_RULES.M);
    expect(reviewPlan(ruleFor("S", { reviewRules: strict }), false)).toEqual([{ role: "reviewer", provider: "claude" }]);
    expect(reviewPlan(strict.L, true).map((p) => `${p.role}/${p.provider}`)).toEqual(["reviewer/claude", "reviewer/codex", "reviewer/claude", "verifier/claude"]);
  });

  it("gates on the rule's reviewers and verifier, not the tier's coded ones", () => {
    // A playbook that reviews S: tier S is no longer ready by itself.
    expect(gate("S", strict.S, P, [])).toMatchObject({ ready: false, why: "0/1 clean reviews on this patch" });
    expect(gate("S", strict.S, P, [review("T2", "reviewer")]).ready).toBe(true);
    // M under this playbook needs two reviewers and a verifier with receipts.
    expect(gate("M", strict.M, P, [review("T2", "reviewer")]).ready).toBe(false);
    expect(gate("M", strict.M, P, [review("T2", "reviewer"), review("T3", "reviewer")]).why).toBe("waiting for the verifier's clean verdict with receipts");
    expect(gate("M", strict.M, P, [review("T2", "reviewer"), review("T3", "reviewer"), review("T4", "verifier")]).ready).toBe(true);
    // And one that waives M review lets it through with none.
    expect(gate("M", { reviewers: 0, verifier: false, planFirst: false }, undefined, [])).toEqual({ ready: true, why: "tier M needs no review" });
  });
});

describe("Codex availability", () => {
  const claude: ProviderInstance = { instanceId: "fleetd", driver: "claudeAgent", usable: true, models: ["claude-opus-5-5"] };
  const codex: ProviderInstance = { instanceId: "fleetd-codex", driver: "codex", usable: true, models: ["gpt-6-astra", "astra"], defaultModel: "gpt-6-astra" };
  // Any Codex instance fleetd did not set up could reach T3's own spawn tools.
  const theirs: ProviderInstance = { ...codex, instanceId: "codex" };

  it("finds a usable fleetd Codex instance with a model, and nothing otherwise", () => {
    expect(codexInstance([claude, codex])?.instanceId).toBe("fleetd-codex");
    expect(codexInstance([claude])).toBeUndefined();
    expect(codexInstance([claude, { ...codex, usable: false }])).toBeUndefined();
    expect(codexInstance([claude, { instanceId: "fleetd-codex", driver: "codex", usable: true, models: [] }])).toBeUndefined();
    expect(codexInstance([claude, theirs])).toBeUndefined();
    expect(otherCodex([claude, theirs, codex])).toEqual(["codex"]);
  });

  it("runs only Codex-only models on the fleetd Codex instance, with Codex's effort option", () => {
    expect(routeModel([claude, codex], "gpt-6-astra")).toEqual({ instanceId: "fleetd-codex", driver: "codex" });
    expect(routeModel([claude, codex], "astra")).toEqual({ instanceId: "fleetd-codex", driver: "codex" });
    expect(routeModel([claude, theirs], "gpt-6-astra").instanceId).toBe("fleetd");
    expect(routeModel([claude, codex], "claude-opus-5-5").instanceId).toBe("fleetd");
    expect(routeModel([claude, { ...codex, usable: false }], "gpt-6-astra").instanceId).toBe("fleetd");
    expect(routeModel([], "anything").instanceId).toBe("fleetd");
    expect(effortOption("codex", "max")).toEqual({ id: "reasoningEffort", value: "xhigh" });
    expect(effortOption("claudeAgent", "max")).toEqual({ id: "effort", value: "max" });
  });
});
