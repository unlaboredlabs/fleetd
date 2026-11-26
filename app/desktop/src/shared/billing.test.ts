import { describe, expect, it } from "vitest";
import {
  billingOn,
  billingReturnOf,
  paidLine,
  PAID_WAIT_MS,
  withoutBillingReturn,
  buys,
  capFromInput,
  capLine,
  capToInput,
  expiringSoon,
  hours,
  money,
  noBuyWhy,
  offerWord,
  planChoice,
  planLine,
  planTerms,
  hoursWord,
  planWord,
  portalShown,
  readBilling,
  readCap,
  readPage,
  sizeWord,
  topLine,
  usageRows,
  limitLine,
  limitsSet,
  readLimit,
  readWarningsOn,
  warningsWhen,
  type BillingState,
} from "./billing";
import { heldLine, usedWord } from "./provided";
import { BILLING_SAMPLES, SAMPLE_NOW, type BillingSample } from "./billing.samples";

const state = (name: BillingSample): BillingState => {
  const read = readBilling(JSON.parse(JSON.stringify(BILLING_SAMPLES[name])));
  if (read === null) throw new Error(`${name} isn't read`);
  return read;
};

describe("the service's billing answer", () => {
  it("reads every state the page shows", () => {
    for (const name of Object.keys(BILLING_SAMPLES) as BillingSample[]) expect(readBilling(BILLING_SAMPLES[name]), name).not.toBeNull();
  });

  it("reads an answer from before the switch's fields as on, with nothing held, expiring or rated", () => {
    const { providedOn: _on, held: _held, rates: _rates, ...older } = BILLING_SAMPLES.plan;
    const read = readBilling({ ...older, credits: { leftCents: 500, capCents: null } });
    expect(read).toMatchObject({ providedOn: true, held: null, rates: [], credits: { leftCents: 500, capCents: null, capSpentCents: 0, expiring: null } });
  });

  it("offers the portal once the workspace paid at Stripe, not for credits fleetd gave it", () => {
    const given = { ...BILLING_SAMPLES.plan, plan: null, credits: { leftCents: 500, capCents: null, capSpentCents: 0, expiring: null } };
    const shown = (json: unknown) => {
      const read = readBilling(json);
      if (read === null) throw new Error("not read");
      return portalShown(read);
    };
    expect(shown({ ...given, customer: false })).toBe(false);
    expect(shown({ ...given, customer: true })).toBe(true);
    // An older cloud that doesn't say: as before, once anything shows as bought.
    expect(shown(given)).toBe(true);
  });

  it("refuses what isn't an answer", () => {
    expect(readBilling(null)).toBeNull();
    expect(readBilling({ ...BILLING_SAMPLES.plan, credits: { leftCents: "4210", capCents: null } })).toBeNull();
    expect(readBilling({ ...BILLING_SAMPLES.plan, plan: { key: "team" } })).toBeNull();
    expect(readBilling({ ...BILLING_SAMPLES.plan, plans: [{ key: "solo", name: "Solo", priceCents: -1, creditsCents: 0 }] })).toBeNull();
    expect(readBilling({ ...BILLING_SAMPLES.plan, providedOn: "yes" })).toBeNull();
  });

  it("reads each plan's agents at once where the cloud sends it, and words a plan without it as before", () => {
    const [, team] = state("plan").plans;
    expect(team && offerWord(team, "usd")).toBe("Team · $50 a month, $60 of computer time included, 100 agents at once");
    // With the rates, the hours beside the dollars, as the pricing page says them: one true thing in both places.
    const { rates } = state("plan");
    expect(team && planTerms(team, "usd", rates)).toBe(`$50 a month, $60 of computer time (${hoursWord(60_00, rates) ?? ""} on the smallest computer), 100 agents at once`);
    expect(hoursWord(30_00, [{ cpu: 2, memGb: 4, centsPerHour: 6 }, { cpu: 4, memGb: 8, centsPerHour: 12 }])).toBe("500 hours");
    expect(hoursWord(260_00, [{ cpu: 2, memGb: 4, centsPerHour: 6 }])).toBe("4,300 hours");
    expect(hoursWord(30_00, [])).toBeUndefined();
    expect(team && planChoice(team, "usd")).toBe("$50 a month · 100 agents at once");
    const [older] = readBilling({ ...BILLING_SAMPLES.plan, plans: [{ key: "team", name: "Team", priceCents: 50_00, creditsCents: 60_00 }] })?.plans ?? [];
    expect(older && planTerms(older, "usd")).toBe("$50 a month, $60 of computer time included");
    expect(older && planChoice(older, "usd")).toBe("$50 a month");
    const odd = readBilling({ ...BILLING_SAMPLES.plan, plans: [{ key: "team", name: "Team", priceCents: 50_00, creditsCents: 60_00, agentsAtOnce: "lots" }] });
    expect(odd?.plans).toEqual([{ key: "team", name: "Team", priceCents: 50_00, creditsCents: 60_00 }]);
  });

  it("keeps a notice's action only when the app knows it", () => {
    const read = readBilling({ ...BILLING_SAMPLES.failed, notice: { message: "Something new.", fix: "Do it.", action: "teleport" } });
    expect(read?.notice).toEqual({ message: "Something new.", fix: "Do it." });
  });

  it("opens only an https page, and reads the cap back", () => {
    expect(readPage({ url: "https://checkout.stripe.com/c/pay/cs_test_a1" })).toBe("https://checkout.stripe.com/c/pay/cs_test_a1");
    expect(readPage({ url: "http://checkout.stripe.com/x" })).toBeNull();
    expect(readPage({ url: "javascript:alert(1)" })).toBeNull();
    expect([readCap({ capCents: 5000 }), readCap({ capCents: null }), readCap({ capCents: -1 })]).toEqual([5000, null, undefined]);
  });
});

describe("what the page says in each state", () => {
  it("no plan: the service's line with Add credits, and nothing used", () => {
    const s = state("none");
    expect(topLine(s)).toEqual({ tone: "danger", message: "This workspace has no plan and no credits, so fleetd can't start a computer for its bots. Pick a plan or buy credits.", fix: "buy" });
    expect(planWord(s)).toBe("No plan");
    expect(planLine(s, SAMPLE_NOW)).toBeNull();
    expect(usageRows(s)).toEqual([]);
    expect(buys(s)).toBe(true);
  });

  it("a plan with credits: no line at the top, when it renews, the credits lapsing soon, use by size", () => {
    const s = state("plan");
    expect(topLine(s)).toBeNull();
    expect(planWord(s)).toBe("Team · $50 a month");
    expect(planLine(s, SAMPLE_NOW)).toBe("Renews Nov 12");
    expect(money(s.credits.leftCents)).toBe("$42.10");
    expect(expiringSoon(s, SAMPLE_NOW)).toEqual({ cents: 1000, at: "2026-11-02T09:00:00.000Z" });
    expect(usageRows(s).map((r) => `${sizeWord(r)} ${hours(r.seconds)} ${money(r.cents)}`)).toEqual(["2 CPU · 4 GB 41 h $2.46", "4 CPU · 8 GB 6.5 h $0.78"]);
    expect(capLine(s)).toBe("$31.20 of $100 this month");
  });

  it("names an expiry only within 30 days", () => {
    const s = state("plan");
    expect(expiringSoon(s, Date.parse("2026-09-01T00:00:00.000Z"))).toBeNull();
    expect(expiringSoon(s, Date.parse("2026-11-03T00:00:00.000Z"))).toBeNull();
  });

  it("a declined card: the service's line, fixed in the portal, and the plan ends", () => {
    const s = state("failed");
    expect(topLine(s)).toMatchObject({ tone: "danger", fix: "portal" });
    expect(topLine(s)?.message).toContain("declined");
    expect(planLine(s, SAMPLE_NOW)).toBe("Ends Nov 12");
  });

  it("the cap reached: one line with the cap, fixed by raising it", () => {
    const s = state("cap");
    expect(topLine(s)).toEqual({ tone: "danger", message: "This month's spend cap of $50 is reached, so bots on fleetd's computers are stopped until next month. Raise the cap to go on.", fix: "cap" });
    expect(capLine(s)).toMatch(/ this month: reached, so bots are stopped$/u);
    expect(usageRows(s).map((r) => r.cpu)).toEqual([16, 8, 2]);
  });

  it("credits used up with a plan: one line, fixed by adding credits", () => {
    const s = { ...state("plan"), held: "empty" as const, credits: { ...state("plan").credits, leftCents: 0, expiring: null } };
    expect(topLine(s)).toMatchObject({ fix: "buy", message: "No credits left, so bots on fleetd's computers are stopped. Add credits or pick a plan." });
  });

  it("not switched on: no Billing at all, so no line to say so and nothing to buy", () => {
    const s = state("off");
    expect(billingOn(s)).toBe(false);
    expect(topLine(s)).toBeNull();
    expect(buys(s)).toBe(false);
    // Not read yet is not on either: no entry shows and then goes.
    expect(billingOn(undefined)).toBe(false);
    expect(billingOn(state("plan"))).toBe(true);
  });

  it("says why nothing can be bought", () => {
    expect(noBuyWhy({ ...state("plan"), canBuy: false })).toBe("Only the workspace's owners and admins buy plans and credits.");
    expect(noBuyWhy({ ...state("plan"), setUp: false })).toBe("Payments aren't set up on fleetd cloud yet.");
  });
});

describe("the page's figures", () => {
  it("writes money plainly", () => {
    expect([money(2000), money(1240), money(5), money(-310), money(123_456_00)]).toEqual(["$20", "$12.40", "$0.05", "−$3.10", "$123,456"]);
  });

  it("writes hours plainly", () => {
    expect([hours(0), hours(300), hours(9000), hours(36_000), hours(460_800)]).toEqual(["0 h", "0 h", "2.5 h", "10 h", "128 h"]);
  });

  it("writes this period's computer time against what the plan includes, or alone with no plan", () => {
    const read = (s: unknown): BillingState => {
      const b = readBilling(s);
      if (b === null) throw new Error("sample doesn't read");
      return b;
    };
    const used = (b: BillingState): BillingState => ({ ...b, usage: { ...b.usage, seconds: 12 * 3600, cents: 4_20 } });
    expect(usedWord(used(read(BILLING_SAMPLES.plan)))).toBe("12 h · $4.20 of $60 included");
    expect(usedWord(used({ ...read(BILLING_SAMPLES.plan), plan: null }))).toBe("12 h · $4.20");
  });

  it("says why fleetd's computers are held in the reason's own words: the cap reached is not a lack of credits", () => {
    const read = (s: unknown): BillingState => {
      const b = readBilling(s);
      if (b === null) throw new Error("sample doesn't read");
      return b;
    };
    expect(heldLine(read(BILLING_SAMPLES.cap))).toContain("spend cap");
    expect(heldLine(read(BILLING_SAMPLES.cap))).not.toContain("credits");
    expect(heldLine(read(BILLING_SAMPLES.none))).toBe("This workspace has no plan and no credits, so fleetd can't start a computer for its bots. Pick a plan or buy credits.");
    expect(heldLine({ ...read(BILLING_SAMPLES.plan), notice: null, held: "empty", credits: { ...read(BILLING_SAMPLES.plan).credits, leftCents: 0 } })).toBe(
      "No credits left, so bots on fleetd's computers are stopped. Add credits or pick a plan.",
    );
  });

  it("reads the cap as typed", () => {
    expect([capFromInput(""), capFromInput(" 50 "), capFromInput("$12.5"), capFromInput("1,000"), capFromInput("12.345"), capFromInput("ten")]).toEqual([null, 5000, 1250, 100_000, undefined, undefined]);
    expect([capToInput(null), capToInput(5000), capToInput(1250)]).toEqual(["", "50", "12.50"]);
  });
});

describe("Stripe's way back", () => {
  const none: BillingState = BILLING_SAMPLES.none;
  const paid: BillingState = BILLING_SAMPLES.plan;
  it("reads paid or cancelled from the address, and cleans only that from it", () => {
    expect(billingReturnOf("?billing=paid&team=t1")).toBe("paid");
    expect(billingReturnOf("?billing=cancelled")).toBe("cancelled");
    expect(billingReturnOf("?billing=other")).toBeNull();
    expect(billingReturnOf("")).toBeNull();
    expect(withoutBillingReturn("?billing=paid&team=t1")).toBe("?team=t1");
    expect(withoutBillingReturn("?billing=paid")).toBe("");
  });
  it("says the payment arrived while Stripe's word is on its way, never the no-credits line, and nothing once it shows", () => {
    expect(none.plan).toBeNull();
    expect(none.credits.leftCents).toBe(0);
    expect(paidLine("paid", none, 0)).toBe("Payment received. The credits show here in a moment, once Stripe confirms it.");
    expect(paidLine("paid", none, PAID_WAIT_MS)).toBe(
      "Stripe hasn't confirmed the payment yet. It shows here once it does; if it doesn't within a few minutes, write to support@fleetd.dev.",
    );
    expect(paidLine("paid", paid, 0)).toBeNull();
    expect(paidLine("cancelled", none, 0)).toBeNull();
    expect(paidLine(null, none, 0)).toBeNull();
  });
});

describe("spend warnings and limits", () => {
  it("reads them, and an answer from before them as none", () => {
    const s = state("warned");
    expect(s.warnings).toEqual({ on: true, percents: [50, 80, 100], lowCredits: false });
    expect(s.warned).toEqual({ kind: "cap", percent: 80 });
    expect(s.limits?.members.map((m) => [m.name, m.limitCents, m.stopped])).toEqual([
      ["Sam Rivera", null, false],
      ["Alice Chen", 25_00, false],
      ["Bob Okafor", 10_00, true],
    ]);
    const { warnings: _w, warned: _d, limits: _l, ...older } = BILLING_SAMPLES.plan;
    expect(readBilling(older)).toMatchObject({ warnings: null, warned: null, limits: null });
  });

  it("refuses an answer whose limits or warnings aren't theirs", () => {
    const bad = (more: Record<string, unknown>) => readBilling({ ...BILLING_SAMPLES.plan, ...more });
    expect(bad({ limits: { members: [{ personId: "p1", name: "A", limitCents: -1, spentCents: 0, stopped: false }], bots: [] } })).toBeNull();
    expect(bad({ limits: { members: [] } })).toBeNull();
    expect(bad({ warnings: { on: "yes", percents: [50], lowCredits: true } })).toBeNull();
    expect(bad({ warnings: { on: true, percents: [150], lowCredits: true } })).toBeNull();
    // A warning this app doesn't know is no warning.
    expect(bad({ warned: { kind: "other" } })?.warned).toBeNull();
  });

  it("says a warning as a warning, with Raise cap, not as a stop", () => {
    expect(topLine(state("warned"))).toEqual({ tone: "warning", message: "This workspace has used 80% of its $100 spend cap this month. Raise the cap, or wait for next month.", fix: "cap" });
    const low = { ...state("plan"), warned: { kind: "low" as const }, notice: { message: "This workspace's credits are low: $3.12 left, about a day at its recent use.", fix: "Buy credits or pick a plan.", action: "buy" as const } };
    expect(topLine(low)).toMatchObject({ tone: "warning", fix: "buy" });
    // Once the cap stops the bots, the stop is what it says.
    expect(topLine({ ...state("cap"), warned: { kind: "cap", percent: 100 } })?.tone).toBe("danger");
  });

  it("words when the warnings go and each limit", () => {
    expect(warningsWhen({ on: true, percents: [50, 80, 100], lowCredits: true })).toBe("At 50%, 80% and 100% of the cap, and when credits run low.");
    expect(warningsWhen({ on: true, percents: [100], lowCredits: false })).toBe("At 100% of the cap.");
    expect(limitLine({ limitCents: 25_00, spentCents: 6_80 }, "usd")).toBe("$6.80 of $25 this month");
    expect(limitLine({ limitCents: null, spentCents: 14_40 }, "usd")).toBe("$14.40 this month");
    const set = limitsSet(state("plan").limits ?? { members: [], bots: [] });
    expect([...set.members.map((m) => m.name), ...set.bots.map((b) => b.name)]).toEqual(["Alice Chen", "Bob Okafor", "storefront"]);
  });

  it("reads a limit set for the one asked about, and the warnings' switch", () => {
    const row = { personId: "p1", limitCents: 500, spentCents: 120, stopped: false };
    expect(readLimit(row, { personId: "p1" })).toEqual({ limitCents: 500, spentCents: 120, stopped: false });
    expect(readLimit(row, { personId: "p2" })).toBeNull();
    expect(readLimit({ projectId: "b1", limitCents: null, spentCents: 0, stopped: false }, { projectId: "b1" })).toEqual({ limitCents: null, spentCents: 0, stopped: false });
    expect([readWarningsOn({ on: false }), readWarningsOn({ on: "no" })]).toEqual([false, undefined]);
  });
});
