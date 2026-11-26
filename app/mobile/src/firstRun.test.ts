// A new cloud team's first run on the phone: who sees it, and each step ticked from the team's own state.
import { describe, expect, it } from "vitest";
import { BILLING_SAMPLES } from "../../desktop/src/shared/billing.samples";
import type { ClaudeAccountsGetOutput } from "../../desktop/src/shared/contracts";
import { readBilling } from "./billing";
import { computersChoice, firstRunShown, firstRunSteps, nextStep } from "./firstRun";

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

  it("a workspace born with no plan, no machine and no Claude: where agents run first, its own machine free beside fleetd's computers", () => {
    const steps = firstRunSteps(readBilling(BILLING_SAMPLES.none), accounts());
    expect(steps.map((s) => [s.id, s.title, s.done])).toEqual([
      ["where", "Where Agents Run", false],
      ["claude", "Connect Claude", false],
      ["bot", "Start a Bot", false],
    ]);
    expect(steps[0]!.detail).toBe("Your own machine, free, or fleetd's computers.");
    expect(nextStep(steps)).toBe("where");
    // Not bought yet is no warning: fleetd's computers are only the other way.
    expect(computersChoice(readBilling(BILLING_SAMPLES.none))).toEqual({ message: undefined, title: "Choose a Plan" });
  });

  it("ticks where agents run on the workspace's own machine joining, with no plan; an offline one, the runner or the agents' Mac don't count", () => {
    const none = readBilling(BILLING_SAMPLES.none);
    expect(firstRunSteps(none, accounts(), true, [{ status: "degraded" }])[0]!.done).toBe(true);
    expect(firstRunSteps(none, accounts(), true, [{ status: "offline" }])[0]!.done).toBe(false);
    expect(firstRunSteps(none, accounts(), true, [{ status: "online", runner: true }])[0]!.done).toBe(false);
    expect(firstRunSteps(none, accounts(), true, [{ status: "online", agentsMac: true }])[0]!.done).toBe(false);
  });

  it("ticks where agents run on a plan, then Claude by its API key or a subscription", () => {
    const plan = readBilling(BILLING_SAMPLES.plan);
    expect(computersChoice(plan)).toBeNull();
    expect(nextStep(firstRunSteps(plan, accounts()))).toBe("claude");
    const keyed = firstRunSteps(plan, accounts({ hubApi: { endpoint: "https://api.anthropic.com" } as never }));
    expect(keyed.map((s) => [s.title, s.done])).toEqual([
      ["Where Agents Run", true],
      ["Claude Connected", true],
      ["Start a Bot", false],
    ]);
    expect(nextStep(keyed)).toBe("bot");
    expect(nextStep(firstRunSteps(plan, accounts({ people: [{ subscription: { email: "a@x" } } as never] })))).toBe("bot");
  });

  it("before fleetd's computers are on, or before Billing is read: its own machine alone", () => {
    expect(firstRunSteps(readBilling(BILLING_SAMPLES.off), accounts()).map((s) => [s.id, s.detail])).toEqual([
      ["where", "Your own machine: a Mac or Linux computer, free."],
      ["claude", "The team's Anthropic API key, or a Claude subscription, for its agents."],
      ["bot", "Make one, and its chat shows up here."],
    ]);
    expect(computersChoice(readBilling(BILLING_SAMPLES.off))).toBeNull();
    expect(computersChoice(undefined)).toBeNull();
  });

  it("on an iPhone, fleetd's computers name no buy: Plan or Credits, and a stopped workspace's line in Billing's plain words", () => {
    expect(computersChoice(readBilling(BILLING_SAMPLES.none), false)).toEqual({ message: undefined, title: "Plan or Credits" });
    expect(computersChoice(readBilling(BILLING_SAMPLES.cap), false)?.message).toContain("spend cap");
    expect(firstRunSteps(readBilling(BILLING_SAMPLES.plan), accounts(), false)[0]!.done).toBe(true);
  });
});
