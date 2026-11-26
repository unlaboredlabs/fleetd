// A fleetd cloud team's billing (fleetd-cloud README "Payments"; the reading is shared/billing.ts): plain HTTP
// calls to the team's own address with this device's key. The plan, credits and use are read by anyone of the team
// (and the spend limits: a member reads their own alone); checkout and the portal are Stripe's own pages, whose
// address the team answers and the browser opens, so no card is ever typed into fleetd; the spend cap, each person's
// and bot's limit and the warnings are set by an owner or admin. Made for a hub that came with the account
// only, so a self-hosted hub is never asked.
import {
  BILLING_CAP_PATH,
  BILLING_CHECKOUT_PATH,
  BILLING_LIMIT_PATH,
  BILLING_PATH,
  BILLING_PORTAL_PATH,
  BILLING_WARNINGS_PATH,
  readBilling,
  readCap,
  readLimit,
  readPage,
  readWarningsOn,
  type LimitOf,
} from "../../shared/billing";
import type { BillingCapOutcome, BillingLimitOutcome, BillingOpen, BillingOpenOutcome, BillingOutcome, BillingWarningsOutcome } from "../../shared/cloud";
import type { Fetch } from "../pairing/hubHttp";
import { call, odd, type KeyedTeam } from "./invites";

export const readTeamBilling = async (fetch: Fetch, team: KeyedTeam): Promise<BillingOutcome> => {
  const answer = await call(fetch, team, "GET", BILLING_PATH);
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const billing = readBilling(answer.body);
  return billing === null ? odd(team) : { ok: true, billing };
};

/** Stripe's checkout for a plan or credits, or its portal (card, invoices, plan change, cancel), opened by `open`. */
export const openBilling = async (fetch: Fetch, team: KeyedTeam, what: BillingOpen, open: (url: string) => Promise<void>): Promise<BillingOpenOutcome> => {
  const answer = what === "portal" ? await call(fetch, team, "POST", BILLING_PORTAL_PATH, {}) : await call(fetch, team, "POST", BILLING_CHECKOUT_PATH, what);
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const url = readPage(answer.body);
  if (url === null) return odd(team);
  try {
    await open(url);
  } catch (error) {
    return { ok: false, failure: { code: "", message: `The browser didn't open: ${String(error)}` } };
  }
  return { ok: true };
};

/** The team's own monthly spend cap in cents, or null for none. */
export const setBillingCap = async (fetch: Fetch, team: KeyedTeam, capCents: number | null): Promise<BillingCapOutcome> => {
  const answer = await call(fetch, team, "POST", BILLING_CAP_PATH, { capCents });
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const cap = readCap(answer.body);
  return cap === undefined ? odd(team) : { ok: true, capCents: cap };
};

/** A person's or a bot's own monthly spend limit in cents, or null for none. */
export const setBillingLimit = async (fetch: Fetch, team: KeyedTeam, of: LimitOf, limitCents: number | null): Promise<BillingLimitOutcome> => {
  const answer = await call(fetch, team, "POST", BILLING_LIMIT_PATH, { ...of, limitCents });
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const limit = readLimit(answer.body, of);
  return limit === null ? odd(team) : { ok: true, limit };
};

/** The spend warnings on or off. */
export const setBillingWarnings = async (fetch: Fetch, team: KeyedTeam, on: boolean): Promise<BillingWarningsOutcome> => {
  const answer = await call(fetch, team, "POST", BILLING_WARNINGS_PATH, { on });
  if (!answer.ok) return { ok: false, failure: answer.failure };
  const kept = readWarningsOn(answer.body);
  return kept === undefined ? odd(team) : { ok: true, on: kept };
};
