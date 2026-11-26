// `GET /billing/v1` answers in each state the Billing page shows, as fleetd cloud sends them (its README, "Payments"),
// for the apps' tests and the QA fixtures (fixtures/cloud). The fixtures' clock is 2026-10-19 10:30 UTC
// (fixtures/kit's NOW). The prices and rates are D598's, here only because the service would answer them.

export const SAMPLE_NOW = Date.parse("2026-10-19T10:30:00.000Z");

const PLANS = [
  { key: "solo", name: "Solo", priceCents: 20_00, creditsCents: 30_00, agentsAtOnce: 25 },
  { key: "team", name: "Team", priceCents: 50_00, creditsCents: 60_00, agentsAtOnce: 100 },
  { key: "scale", name: "Scale", priceCents: 200_00, creditsCents: 260_00, agentsAtOnce: 300 },
];
const TOPUPS = [
  { key: "10", priceCents: 10_00, creditsCents: 10_00 },
  { key: "25", priceCents: 25_00, creditsCents: 25_00 },
  { key: "100", priceCents: 100_00, creditsCents: 100_00 },
];
const RATES = [
  { cpu: 2, memGb: 4, centsPerHour: 6 },
  { cpu: 4, memGb: 8, centsPerHour: 12 },
  { cpu: 8, memGb: 16, centsPerHour: 24 },
  { cpu: 16, memGb: 32, centsPerHour: 60 },
];

const base = {
  setUp: true,
  providedOn: true,
  currency: "usd",
  canBuy: true,
  plans: PLANS,
  topUps: TOPUPS,
  rates: RATES,
  held: null,
  notice: null,
  warnings: { on: true, percents: [50, 80, 100], lowCredits: false },
  warned: null,
  limits: null,
};

/**
 * Each person's and bot's spend this month on the Team plan's $31.20, with limits: Alice's $25, Bob's $10 reached (his
 * work stopped), the storefront bot's $40. People are fixtures/admin's; the bots' ids are stand-ins a fixture swaps
 * for its snapshot's.
 */
export const SAMPLE_LIMITS = {
  members: [
    { personId: "p_aaaaaaaa", name: "Sam Rivera", limitCents: null, spentCents: 14_40, stopped: false },
    { personId: "p_bbbbbbbb", name: "Alice Chen", limitCents: 25_00, spentCents: 6_80, stopped: false },
    { personId: "p_cccccccc", name: "Bob Okafor", limitCents: 10_00, spentCents: 10_00, stopped: true },
  ],
  bots: [
    { projectId: "storefront", name: "storefront", limitCents: 40_00, spentCents: 18_70, stopped: false },
    { projectId: "checkout", name: "checkout", limitCents: null, spentCents: 12_50, stopped: false },
  ],
};

const month = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-19T10:30:00.000Z" };
const period = { from: "2026-10-12T00:00:00.000Z", to: "2026-10-19T10:30:00.000Z" };

const team = (more: Record<string, unknown> = {}) => ({
  key: "team",
  name: "Team",
  status: "active",
  priceCents: 50_00,
  creditsCents: 60_00,
  paidThrough: "2026-11-12T00:00:00.000Z",
  renews: true,
  periodEnd: "2026-11-12T00:00:00.000Z",
  ...more,
});

/** Each state, by the name the tests and fixtures give it. */
export const BILLING_SAMPLES = {
  /** No plan and no credits: nothing runs on fleetd's computers, and the service says so. */
  none: {
    ...base,
    plan: null,
    credits: { leftCents: 0, capCents: null, capSpentCents: 0, expiring: null },
    usage: { ...month, seconds: 0, cents: 0, bySize: [] },
    held: "none",
    notice: { message: "This workspace has no plan and no credits, so fleetd can't start a computer for its bots.", fix: "Pick a plan or buy credits.", action: "buy" },
  },
  /** The Team plan, renewing, with credits left and $10 of them lapsing within 30 days; two sizes used; a cap; limits. */
  plan: {
    ...base,
    plan: team(),
    credits: { leftCents: 42_10, capCents: 100_00, capSpentCents: 31_20, expiring: { cents: 10_00, at: "2026-11-02T09:00:00.000Z" } },
    usage: {
      ...period,
      seconds: 41 * 3600 + 6.5 * 3600,
      cents: 246 + 78,
      bySize: [
        { cpu: 2, memGb: 4, seconds: 41 * 3600, cents: 246 },
        { cpu: 4, memGb: 8, seconds: 6.5 * 3600, cents: 78 },
      ],
    },
    limits: SAMPLE_LIMITS,
  },
  /** The Team plan past 80% of its $100 cap this month: the warning's line at the top, with Raise cap. */
  warned: {
    ...base,
    plan: team(),
    credits: { leftCents: 21_60, capCents: 100_00, capSpentCents: 82_40, expiring: null },
    usage: { ...period, seconds: 96 * 3600, cents: 82_40, bySize: [{ cpu: 8, memGb: 16, seconds: 96 * 3600, cents: 82_40 }] },
    warned: { kind: "cap", percent: 80 },
    notice: { message: "This workspace has used 80% of its $100 spend cap this month.", fix: "Raise the cap, or wait for next month." },
    limits: SAMPLE_LIMITS,
  },
  /** The card for the Team plan declined: the plan lasts to the end of the month paid for, unless it is updated. */
  failed: {
    ...base,
    plan: team({ status: "past_due", renews: false }),
    credits: { leftCents: 18_40, capCents: null, capSpentCents: 41_60, expiring: null },
    usage: { ...period, seconds: 12 * 3600, cents: 72, bySize: [{ cpu: 2, memGb: 4, seconds: 12 * 3600, cents: 72 }] },
    notice: { message: "The card for the Team plan was declined. Update it by Nov 12, 2026, or the plan ends then.", fix: "Open Manage billing and update the card.", action: "portal" },
  },
  /** The spend cap the team set reached this month: bots on fleetd's computers wait. */
  cap: {
    ...base,
    plan: { key: "solo", name: "Solo", status: "active", priceCents: 20_00, creditsCents: 30_00, paidThrough: "2026-11-04T00:00:00.000Z", renews: true, periodEnd: "2026-11-04T00:00:00.000Z" },
    credits: { leftCents: 18_30, capCents: 50_00, capSpentCents: 50_00, expiring: null },
    usage: {
      from: "2026-10-04T00:00:00.000Z",
      to: month.to,
      seconds: (110 + 60 + 48) * 3600,
      cents: 49_80,
      bySize: [
        { cpu: 2, memGb: 4, seconds: 110 * 3600, cents: 6_60 },
        { cpu: 8, memGb: 16, seconds: 60 * 3600, cents: 14_40 },
        { cpu: 16, memGb: 32, seconds: 48 * 3600, cents: 28_80 },
      ],
    },
    held: "cap",
  },
  /** fleetd's computers not switched on for teams yet: nothing is sold. */
  off: {
    ...base,
    providedOn: false,
    plan: null,
    credits: { leftCents: 0, capCents: null, capSpentCents: 0, expiring: null },
    usage: { ...month, seconds: 0, cents: 0, bySize: [] },
    notice: { message: "fleetd's computers aren't on yet, so there is nothing to buy.", fix: "Bots run on the workspace's own machines until then." },
  },
} as const;

export type BillingSample = keyof typeof BILLING_SAMPLES;
