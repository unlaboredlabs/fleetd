// A new cloud team's first run on the phone: who sees it, and each step ticked from the team's own state.
import { describe, expect, it } from "vitest";
import { BILLING_SAMPLES } from "../../desktop/src/shared/billing.samples";
import type { ClaudeAccountsGetOutput } from "../../desktop/src/shared/contracts";
import { readBilling } from "./billing";
import { firstRunShown, firstRunSteps, nextStep } from "./firstRun";

const accounts = (more: Partial<ClaudeAccountsGetOutput> = {}) => ({ leadsRunOn: "hub_api", settings: {}, people: [], ...more }) as unknown as ClaudeAccountsGetOutput;

describe("a cloud team's first run", () => {
  it("shows to an owner or admin of a cloud team with no bots, never to a member, an invited team or a self-hosted hub", () => {
    expect(firstRunShown({ cloud: true }, { projects: {}, admin: true })).toBe(true);
    expect(firstRunShown({ cloud: true }, { projects: { "m/p": {} }, admin: true })).toBe(false);
    expect(firstRunShown({ cloud: true }, { projects: {}, admin: false })).toBe(false);
    expect(firstRunShown({ cloud: true, invited: true }, { projects: {}, admin: true })).toBe(false);
    expect(firstRunShown({}, { projects: {}, admin: true })).toBe(false);
    // Not read yet: neither it nor No Chats Yet flashes first.
    expect(firstRunShown({ cloud: true }, { projects: undefined, admin: true })).toBe(false);
  });

  it("a team born with no plan and no Claude: the plan first, in Billing's words", () => {
    const steps = firstRunSteps(readBilling(BILLING_SAMPLES.none), accounts());
    expect(steps.map((s) => [s.id, s.title, s.done])).toEqual([
      ["plan", "Choose a Plan", false],
      ["claude", "Connect Claude", false],
      ["bot", "Start a Bot", false],
    ]);
    expect(steps[0]!.detail).toContain("no plan and no credits");
    expect(nextStep(steps)).toBe("plan");
  });

  it("ticks the plan, then Claude by its API key or a subscription", () => {
    const plan = readBilling(BILLING_SAMPLES.plan);
    expect(nextStep(firstRunSteps(plan, accounts()))).toBe("claude");
    const keyed = firstRunSteps(plan, accounts({ hubApi: { endpoint: "https://api.anthropic.com" } as never }));
    expect(keyed.map((s) => [s.title, s.done])).toEqual([
      ["Plan or Credits", true],
      ["Claude Connected", true],
      ["Start a Bot", false],
    ]);
    expect(nextStep(keyed)).toBe("bot");
    expect(nextStep(firstRunSteps(plan, accounts({ people: [{ subscription: { email: "a@x" } } as never] })))).toBe("bot");
  });

  it("has no plan step on a team that runs on its own machines, or before Billing is read", () => {
    expect(firstRunSteps(readBilling(BILLING_SAMPLES.off), accounts()).map((s) => s.id)).toEqual(["claude", "bot"]);
    expect(firstRunSteps(undefined, undefined).map((s) => s.id)).toEqual(["claude", "bot"]);
  });

  it("on an iPhone, the plan step names no buy: Plan or Credits, in Billing's plain words", () => {
    const steps = firstRunSteps(readBilling(BILLING_SAMPLES.none), accounts(), false);
    expect(steps[0]).toEqual({ id: "plan", title: "Plan or Credits", detail: "This team has no plan and no credits, so fleetd can't start a computer for its bots.", done: false });
    expect(firstRunSteps(readBilling(BILLING_SAMPLES.plan), accounts(), false)[0]!.done).toBe(true);
  });
});
