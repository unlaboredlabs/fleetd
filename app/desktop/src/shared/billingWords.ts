// The Billing page's own words, on both apps: the plan, its terms as the pricing page says them, usage and warnings.
// Apart from billing.ts, which the first chat loads to read a team's billing, so that chat doesn't carry them
// (app/desktop/scripts/web-check.ts's budget).

import { dayWord, money, type BillingSize, type BillingState, type BillingWarnings } from "./billing";

/** What the plan row says: "Team · $50 a month", or "No plan". */
export const planWord = (state: BillingState): string => (state.plan === null ? "No plan" : `${state.plan.name} · ${money(state.plan.priceCents, state.currency)} a month`);

/** The plan's quiet line: when it renews or ends, or that its card was declined. */
export const planLine = (state: BillingState, nowMs: number): string | null => {
  const p = state.plan;
  if (p === null) return null;
  const end = p.periodEnd ?? p.paidThrough;
  if (end === null) return null;
  return p.renews ? `Renews ${dayWord(end, nowMs)}` : `Ends ${dayWord(end, nowMs)}`;
};

/**
 * `cents` of computer time as hours of the smallest computer `rates` has, rounded down to two figures as the pricing
 * page says them ("500 hours", "4,300 hours"); undefined with no rate.
 */
export const hoursWord = (cents: number, rates: BillingState["rates"]): string | undefined => {
  const least = Math.min(...rates.map((r) => r.centsPerHour).filter((c) => c > 0));
  if (!Number.isFinite(least)) return undefined;
  const h = cents / least;
  const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(h, 1))) - 1);
  return `${(Math.floor(h / step) * step).toLocaleString("en-US")} hours`;
};

/** What a plan gives, as the pricing page says it: "$50 a month, $60 of computer time (1,000 hours on the smallest
 * computer), 100 agents at once" (the hours with the rates, the agents when the cloud says). */
export const planTerms = (offer: BillingState["plans"][number], currency: string, rates: BillingState["rates"] = []): string => {
  const hours = hoursWord(offer.creditsCents, rates);
  return (
    `${money(offer.priceCents, currency)} a month, ${money(offer.creditsCents, currency)} of computer time` +
    (hours === undefined ? " included" : ` (${hours} on the smallest computer)`) +
    (offer.agentsAtOnce === undefined ? "" : `, ${offer.agentsAtOnce} agents at once`)
  );
};

/** A plan's price as a pick list shows it beside its name: "$50 a month · 100 agents at once". */
export const planChoice = (offer: BillingState["plans"][number], currency: string): string =>
  `${money(offer.priceCents, currency)} a month` + (offer.agentsAtOnce === undefined ? "" : ` · ${offer.agentsAtOnce} agents at once`);

/** A plan offered, as a choice reads: "Team · $50 a month, $60 of computer time (1,000 hours on the smallest computer),
 * 100 agents at once". */
export const offerWord = (offer: BillingState["plans"][number], currency: string, rates: BillingState["rates"] = []): string =>
  `${offer.name} · ${planTerms(offer, currency, rates)}`;

/** A size's rate: "$0.06 an hour". */
export const rateWord = (centsPerHour: number, currency: string): string => `${money(centsPerHour, currency)} an hour`;

/** A list's words: "50%", "50% and 80%", "50%, 80% and 100%". */
const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`);

/** The cap's shares warned at: "50%, 80% and 100%". */
export const percentsWord = (w: BillingWarnings): string => andList(w.percents.map((p) => `${String(p)}%`));

/** When the warnings go out: "At 50%, 80% and 100% of the cap, and when credits run low." */
export const warningsWhen = (w: BillingWarnings): string => {
  const at = w.percents.length === 0 ? null : `At ${percentsWord(w)} of the cap`;
  return at === null ? "When credits run low." : `${at}${w.lowCredits ? ", and when credits run low" : ""}.`;
};

/** The usage rows the page lists: each size used this period, biggest spend first, then by size. */
export const usageRows = (state: BillingState): BillingSize[] =>
  // Not toSorted: Hermes, which runs the phone, has none.
  state.usage.bySize.filter((s) => s.seconds > 0 || s.cents > 0).sort((a, b) => b.cents - a.cents || a.cpu - b.cpu || a.memGb - b.memGb);
