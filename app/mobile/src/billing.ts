// A fleetd cloud team's billing on the phone (fleetd-cloud README "Payments"; the reading and the words are the
// desktop's, shared/billing.ts): plain HTTP calls to the team's own address with this phone's key, as the desktop's
// main makes them. Checkout and the portal are Stripe's own pages, which the phone opens in its browser sheet; no card
// is ever typed into fleetd. Only a fleetd cloud team is asked, signed in or paired with a code: a self-hosted hub has
// no Billing, and a team has none until fleetd's computers are on for it. The iPhone app sells nothing (D733, App
// Review 3.1.1): there Billing reads the plan and credits only, with no price, no buy and no word of buying elsewhere.
import {
  BILLING_CAP_PATH,
  BILLING_CHECKOUT_PATH,
  BILLING_PATH,
  BILLING_PORTAL_PATH,
  billingOn,
  readBilling,
  readCap,
  readPage,
  topLine,
  type BillingBuy,
  type BillingState,
} from "../../desktop/src/shared/billing";
import type { KeptHub } from "./cloud/account";

export * from "../../desktop/src/shared/billing";

/** Whether this phone sells plans and credits: Android does, iOS doesn't (D733). `os` is Platform.OS. */
export const sells = (os: string): boolean => os !== "ios";

/**
 * The top line as this phone shows it. One that sells nothing keeps what's wrong and drops the call to buy and its
 * row: the service's notice, its first sentence without its fix, and credits run out said plainly. The cap's line and row stay, as
 * setting a cap buys nothing.
 */
export const shownTopLine = (state: BillingState, selling: boolean): ReturnType<typeof topLine> => {
  const top = topLine(state);
  if (top === null || selling || top.fix === "cap") return top;
  // Its first sentence: what's wrong. What follows may say how to pay ("Update it by …").
  if (state.notice !== null) return { tone: top.tone, message: state.notice.message.match(/^.+?[.!?](?=\s|$)/u)?.[0] ?? state.notice.message, fix: null };
  return { tone: top.tone, message: "No credits left, so bots on fleetd's computers are stopped.", fix: null };
};

const CALL_TIMEOUT_MS = 20_000;

/** Why a call didn't do what it asked, in the team's words where it gave them. */
export interface BillingFailure {
  readonly message: string;
  readonly fix?: string;
}

export type Got<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: BillingFailure };

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Billing shows for a team's owners and admins on a fleetd cloud team (cloud/account.ts shownHub), once the team's answer says
 * fleetd's computers are on for it (`billingOn`), and nowhere else: no row for a page that would only say so.
 */
export const billingShown = (hub: Pick<KeptHub, "cloud">, admin: boolean | undefined, billing: BillingState | null | undefined): boolean =>
  hub.cloud === true && admin === true && billingOn(billing);

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** One call to the team's own address with this phone's key; its refusal in the team's words. */
export const call = async (fetch: Fetch, hub: Pick<KeptHub, "hub" | "key" | "hubName">, method: "GET" | "POST", path: string, body?: unknown): Promise<Got<unknown>> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${hub.hub.replace(/\/+$/u, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${hub.key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: abort.signal,
      redirect: "error",
    });
  } catch {
    return { ok: false, failure: { message: `Can't reach ${hub.hubName}.`, fix: "Check your connection, then try again." } };
  } finally {
    clearTimeout(timer);
  }
  let answer: unknown;
  try {
    answer = await response.json();
  } catch {
    answer = undefined;
  }
  if (response.ok) return { ok: true, value: answer };
  const refused = record(answer);
  if (refused !== null && typeof refused.message === "string" && refused.message.length > 0) {
    return { ok: false, failure: { message: refused.message, ...(typeof refused.fix === "string" && refused.fix !== "" ? { fix: refused.fix } : {}) } };
  }
  return { ok: false, failure: { message: `${hub.hubName} answered ${String(response.status)}.`, fix: "Try again in a minute." } };
};

const odd = (hub: Pick<KeptHub, "hubName">): { ok: false; failure: BillingFailure } => ({
  ok: false,
  failure: { message: `${hub.hubName} answered in a way this app doesn't read.`, fix: "Update fleetd, then try again." },
});

export const readTeamBilling = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, fetch: Fetch = globalThis.fetch): Promise<Got<BillingState>> => {
  const got = await call(fetch, hub, "GET", BILLING_PATH);
  if (!got.ok) return got;
  const billing = readBilling(got.value);
  return billing === null ? odd(hub) : { ok: true, value: billing };
};

/** Stripe's page for a plan, credits or the portal, as the team answers it: an https address to open. */
export const billingPage = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, what: "portal" | BillingBuy, fetch: Fetch = globalThis.fetch): Promise<Got<string>> => {
  const got = what === "portal" ? await call(fetch, hub, "POST", BILLING_PORTAL_PATH, {}) : await call(fetch, hub, "POST", BILLING_CHECKOUT_PATH, what);
  if (!got.ok) return got;
  const url = readPage(got.value);
  return url === null ? odd(hub) : { ok: true, value: url };
};

/** The team's monthly spend cap in cents, null for none: as the team keeps it now. */
export const setTeamCap = async (hub: Pick<KeptHub, "hub" | "key" | "hubName">, capCents: number | null, fetch: Fetch = globalThis.fetch): Promise<Got<number | null>> => {
  const got = await call(fetch, hub, "POST", BILLING_CAP_PATH, { capCents });
  if (!got.ok) return got;
  const cap = readCap(got.value);
  return cap === undefined ? odd(hub) : { ok: true, value: cap };
};

/** A failure as one line: its words, then its fix. */
export const failureWords = (f: BillingFailure): string => (f.fix === undefined ? f.message : `${f.message} ${f.fix}`);

/** The top line's fix, in the phone's title case. */
export const FIX_TITLE = { portal: "Update Card", buy: "Add Credits", cap: "Raise Cap" } as const;
