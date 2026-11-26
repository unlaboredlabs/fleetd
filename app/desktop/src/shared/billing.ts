// A fleetd cloud team's billing as the apps read it (`GET /billing/v1` on the team's own address, fleetd-cloud's
// README "Payments"), shared by the desktop's main and page and the phone, and importable from the package
// (`fleetd/apps/billing`) so the cloud can test its answers through the apps' own reading. Every price, included
// amount and rate comes from the answer: nothing here knows what a plan costs. Checked by hand, as accounts.ts is: the
// package takes no dependency.

export const BILLING_PATH = "/billing/v1";
export const BILLING_CHECKOUT_PATH = "/billing/v1/checkout";
export const BILLING_PORTAL_PATH = "/billing/v1/portal";
export const BILLING_CAP_PATH = "/billing/v1/cap";
/** POST `{ personId, limitCents }` or `{ projectId, limitCents }` (null clears it), an owner's or admin's: answers the row as kept. */
export const BILLING_LIMIT_PATH = "/billing/v1/limit";
/** POST `{ on }`, an owner's or admin's: the spend warnings on or off, answered `{ on }`. */
export const BILLING_WARNINGS_PATH = "/billing/v1/warnings";

/**
 * Where a person writes about a payment, named in full wherever the apps send them to support (the cloud can import it
 * from the package too). A placeholder until the address reaches an inbox: launch-readiness step 2 routes it.
 */
export const SUPPORT_EMAIL = "support@fleetd.dev";

export interface BillingPlan {
  readonly key: string;
  readonly name: string;
  /** Stripe's word for the subscription: `active`, `past_due`, `unpaid`… */
  readonly status: string;
  readonly priceCents: number;
  /** The computer time each paid month includes, as credits. */
  readonly creditsCents: number;
  readonly paidThrough: string | null;
  /** It renews at `periodEnd`; false: it ends then. */
  readonly renews: boolean;
  readonly periodEnd: string | null;
}

export interface BillingSize {
  readonly cpu: number;
  readonly memGb: number;
  readonly seconds: number;
  readonly cents: number;
}

export interface BillingNotice {
  readonly message: string;
  readonly fix: string;
  readonly action?: "portal" | "buy";
}

/**
 * The spend warnings: an email to the owners and admins and a line in each bot on fleetd's computers at each of
 * `percents` of the cap, and when the credits left cover about a day (`lowCredits`, under the same switch). On unless
 * an admin turned them off.
 */
export interface BillingWarnings {
  readonly on: boolean;
  readonly percents: readonly number[];
  readonly lowCredits: boolean;
}

/** The warning in force now: this month's highest share of the cap crossed, or credits low. */
export type BillingWarned = { readonly kind: "cap"; readonly percent: number } | { readonly kind: "low" };

/** A member's or a bot's own monthly limit (null: none) and this UTC month's spend on fleetd's computers against it. */
export interface SpendLimit {
  readonly name: string;
  readonly limitCents: number | null;
  readonly spentCents: number;
  /** The month's spend reached the limit: that member's or bot's work on fleetd's computers is stopped. */
  readonly stopped: boolean;
}

export interface MemberLimit extends SpendLimit {
  readonly personId: string;
}

export interface BotLimit extends SpendLimit {
  readonly projectId: string;
}

/**
 * The limits as the caller may see them: for an owner or admin every person of the workspace and every bot on
 * fleetd's computers, limit or not; for a member, their own row alone and no bots.
 */
export interface BillingLimits {
  readonly members: readonly MemberLimit[];
  readonly bots: readonly BotLimit[];
}

/** What a limit is set on: a person or a bot. */
export type LimitOf = { readonly personId: string } | { readonly projectId: string };

/** Why the team's boxes are held: no plan and no credits ever, credits used up, or the cap reached this month. */
export type BillingHeld = "none" | "empty" | "cap";

export interface BillingState {
  /** Stripe is set up on the service; false: nothing can be bought yet. */
  readonly setUp: boolean;
  /** fleetd's computers are on for teams; false: bots run on the team's own machines and nothing is sold. */
  readonly providedOn: boolean;
  readonly currency: string;
  readonly plan: BillingPlan | null;
  readonly credits: {
    /** Below zero: what boxes used past the credits, which the next grant pays first. */
    readonly leftCents: number;
    readonly capCents: number | null;
    /** This UTC month's spend, which the cap counts against. */
    readonly capSpentCents: number;
    /** The soonest-expiring credits still left, any date. */
    readonly expiring: { readonly cents: number; readonly at: string } | null;
  };
  readonly usage: { readonly from: string; readonly to: string; readonly seconds: number; readonly cents: number; readonly bySize: readonly BillingSize[] };
  readonly held: BillingHeld | null;
  readonly notice: BillingNotice | null;
  /** The caller is an owner or admin: buys, opens the portal and sets the cap. */
  readonly canBuy: boolean;
  /** The workspace has paid at Stripe, so the portal has something to show; absent from an older cloud. */
  readonly customer?: boolean;
  /** `agentsAtOnce`: the agents the plan runs at once on fleetd's computers, from a cloud that sends it. */
  readonly plans: ReadonlyArray<{ readonly key: string; readonly name: string; readonly priceCents: number; readonly creditsCents: number; readonly agentsAtOnce?: number }>;
  readonly topUps: ReadonlyArray<{ readonly key: string; readonly priceCents: number; readonly creditsCents: number }>;
  readonly rates: ReadonlyArray<{ readonly cpu: number; readonly memGb: number; readonly centsPerHour: number }>;
  /** Absent from a cloud before spend warnings. */
  readonly warnings: BillingWarnings | null;
  readonly warned: BillingWarned | null;
  /** Absent from a cloud before spend limits: no limit is offered. */
  readonly limits: BillingLimits | null;
}

/** What a buy asks checkout for: a plan or a top-up, by the answer's own key. */
export type BillingBuy = { readonly plan: string } | { readonly topUp: string };

const record = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const words = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const time = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));
const timeOrNull = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : time(v) ? v : undefined);

/** A list of at most 50 rows each read by `one`; null when it isn't one or a row fails. */
const list = <T>(v: unknown, one: (row: Record<string, unknown>) => T | null): T[] | null => {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: T[] = [];
  for (const row of v as unknown[]) {
    const r = record(row);
    const read = r === null ? null : one(r);
    if (read === null) return null;
    out.push(read);
  }
  return out;
};

const plan = (v: unknown): BillingPlan | null | undefined => {
  if (v === null) return null;
  const p = record(v);
  if (p === null) return undefined;
  const paidThrough = timeOrNull(p.paidThrough);
  const periodEnd = timeOrNull(p.periodEnd);
  if (!words(p.key, 32) || !words(p.name, 40) || !words(p.status, 32) || !int(p.priceCents) || !int(p.creditsCents) || typeof p.renews !== "boolean") return undefined;
  if (paidThrough === undefined || periodEnd === undefined) return undefined;
  return { key: p.key, name: p.name, status: p.status, priceCents: p.priceCents, creditsCents: p.creditsCents, paidThrough, renews: p.renews, periodEnd };
};

const notice = (v: unknown): BillingNotice | null | undefined => {
  if (v === null || v === undefined) return null;
  const n = record(v);
  if (n === null || !words(n.message) || typeof n.fix !== "string" || n.fix.length > 500) return undefined;
  const action = n.action === "portal" || n.action === "buy" ? n.action : undefined;
  return { message: n.message, fix: n.fix, ...(action === undefined ? {} : { action }) };
};

const expiring = (v: unknown): BillingState["credits"]["expiring"] | undefined => {
  if (v === null || v === undefined) return null;
  const e = record(v);
  return e !== null && int(e.cents, 1) && time(e.at) ? { cents: e.cents, at: e.at } : undefined;
};

const warnings = (v: unknown): BillingWarnings | null | undefined => {
  if (v === null || v === undefined) return null;
  const w = record(v);
  const percents = w?.percents;
  const fine = Array.isArray(percents) && percents.length <= 10 && (percents as unknown[]).every((p) => int(p, 1) && p <= 100);
  return w !== null && typeof w.on === "boolean" && typeof w.lowCredits === "boolean" && fine ? { on: w.on, percents: percents as number[], lowCredits: w.lowCredits } : undefined;
};

const warned = (v: unknown): BillingWarned | null => {
  const w = record(v);
  if (w?.kind === "low") return { kind: "low" };
  return w?.kind === "cap" && int(w.percent, 1) && w.percent <= 100 ? { kind: "cap", percent: w.percent } : null;
};

const spend = (r: Record<string, unknown>): SpendLimit | null =>
  words(r.name, 200) && (r.limitCents === null || int(r.limitCents)) && int(r.spentCents) && typeof r.stopped === "boolean"
    ? { name: r.name, limitCents: r.limitCents, spentCents: r.spentCents, stopped: r.stopped }
    : null;

/** Each person and each bot at most a few hundred: a longer list reads as none rather than failing the page. */
const LIMIT_ROWS = 500;

const limitRows = <T>(v: unknown, one: (row: Record<string, unknown>) => T | null): T[] | null => {
  if (!Array.isArray(v) || v.length > LIMIT_ROWS) return null;
  const out: T[] = [];
  for (const row of v as unknown[]) {
    const r = record(row);
    const read = r === null ? null : one(r);
    if (read === null) return null;
    out.push(read);
  }
  return out;
};

const member = (r: Record<string, unknown>): MemberLimit | null => {
  const s = spend(r);
  return s !== null && words(r.personId, 200) ? { ...s, personId: r.personId } : null;
};

const bot = (r: Record<string, unknown>): BotLimit | null => {
  const s = spend(r);
  return s !== null && words(r.projectId, 200) ? { ...s, projectId: r.projectId } : null;
};

const limits = (v: unknown): BillingLimits | null | undefined => {
  if (v === null || v === undefined) return null;
  const l = record(v);
  const members = l === null ? null : limitRows(l.members, member);
  const bots = l === null ? null : limitRows(l.bots, bot);
  return members === null || bots === null ? undefined : { members, bots };
};

/**
 * The service's answer to `GET /billing/v1`, checked; null when it isn't one. What a newer field adds to an older
 * answer reads as its quiet default: `providedOn` absent is on (an answer from before the switch had no flag), no
 * `held`, no `rates`, nothing expiring.
 */
export const readBilling = (json: unknown): BillingState | null => {
  const o = record(json);
  const credits = record(o?.credits);
  const usage = record(o?.usage);
  if (o === null || credits === null || usage === null) return null;
  if (typeof o.setUp !== "boolean" || typeof o.canBuy !== "boolean" || !words(o.currency, 8)) return null;
  if (o.providedOn !== undefined && typeof o.providedOn !== "boolean") return null;
  const p = plan(o.plan);
  const n = notice(o.notice);
  const exp = expiring(credits.expiring);
  const w = warnings(o.warnings);
  const l = limits(o.limits);
  if (p === undefined || n === undefined || exp === undefined || w === undefined || l === undefined) return null;
  if (!int(credits.leftCents, Number.MIN_SAFE_INTEGER) || !(credits.capCents === null || int(credits.capCents))) return null;
  if (credits.capSpentCents !== undefined && !int(credits.capSpentCents)) return null;
  if (!time(usage.from) || !time(usage.to) || !int(usage.seconds) || !int(usage.cents)) return null;
  const bySize = list(usage.bySize, (r) => (int(r.cpu, 1) && int(r.memGb, 1) && int(r.seconds) && int(r.cents) ? { cpu: r.cpu, memGb: r.memGb, seconds: r.seconds, cents: r.cents } : null));
  const plans = list(o.plans, (r) =>
    words(r.key, 32) && words(r.name, 40) && int(r.priceCents) && int(r.creditsCents)
      ? { key: r.key, name: r.name, priceCents: r.priceCents, creditsCents: r.creditsCents, ...(int(r.agentsAtOnce, 1) ? { agentsAtOnce: r.agentsAtOnce } : {}) }
      : null,
  );
  const topUps = list(o.topUps, (r) => (words(r.key, 32) && int(r.priceCents, 1) && int(r.creditsCents, 1) ? { key: r.key, priceCents: r.priceCents, creditsCents: r.creditsCents } : null));
  const rates = o.rates === undefined ? [] : list(o.rates, (r) => (int(r.cpu, 1) && int(r.memGb, 1) && int(r.centsPerHour) ? { cpu: r.cpu, memGb: r.memGb, centsPerHour: r.centsPerHour } : null));
  if (bySize === null || plans === null || topUps === null || rates === null) return null;
  const held = o.held === "none" || o.held === "empty" || o.held === "cap" ? o.held : null;
  return {
    setUp: o.setUp,
    providedOn: o.providedOn ?? true,
    currency: o.currency,
    plan: p,
    credits: { leftCents: credits.leftCents, capCents: credits.capCents, capSpentCents: int(credits.capSpentCents) ? credits.capSpentCents : 0, expiring: exp },
    usage: { from: usage.from, to: usage.to, seconds: usage.seconds, cents: usage.cents, bySize },
    held,
    notice: n,
    canBuy: o.canBuy,
    ...(typeof o.customer === "boolean" ? { customer: o.customer } : {}),
    plans,
    topUps,
    rates,
    warnings: w,
    warned: warned(o.warned),
    limits: l,
  };
};

/** Whether Billing offers the portal (Manage billing): once the workspace has paid at Stripe; from an older cloud that
 * doesn't say, once it shows anything bought (fleetd's own credits read as bought there). */
export const portalShown = (state: BillingState): boolean =>
  state.customer ?? (state.plan !== null || state.credits.leftCents !== 0 || state.credits.expiring !== null || state.held === "empty");

/** `{ url }`, checkout's or the portal's page: only an https address, which the apps open in the browser. */
export const readPage = (json: unknown): string | null => {
  const url = record(json)?.url;
  return typeof url === "string" && url.length <= 2000 && /^https:\/\/[^\s]+$/u.test(url) ? url : null;
};

/** POST BILLING_LIMIT_PATH's answer, the row as kept, by what was asked; null when it isn't one. */
export const readLimit = (json: unknown, of: LimitOf): Omit<SpendLimit, "name"> | null => {
  const r = record(json);
  if (r === null) return null;
  const same = "personId" in of ? r.personId === of.personId : r.projectId === of.projectId;
  return same && (r.limitCents === null || int(r.limitCents)) && int(r.spentCents) && typeof r.stopped === "boolean"
    ? { limitCents: r.limitCents, spentCents: r.spentCents, stopped: r.stopped }
    : null;
};

/** POST BILLING_WARNINGS_PATH's answer, `{ on }`; undefined when it isn't one. */
export const readWarningsOn = (json: unknown): boolean | undefined => {
  const on = record(json)?.on;
  return typeof on === "boolean" ? on : undefined;
};

/** `{ capCents }`, the cap as the service keeps it now; undefined when it isn't one. */
export const readCap = (json: unknown): number | null | undefined => {
  const cap = record(json)?.capCents;
  return cap === null ? null : int(cap) ? cap : undefined;
};

// ── The page's words, the same on both apps ────────────────────────────────────────────────────────────────────

/** Cents as money: whole dollars without cents ($20), else to the cent ($12.40); below zero with a minus. */
export const money = (cents: number, currency = "usd"): string => {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const symbol = currency.toLowerCase() === "usd" ? "$" : `${currency.toUpperCase()} `;
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${sign}${symbol}${grouped}${rest === 0 ? "" : `.${rest.toString().padStart(2, "0")}`}`;
};

/** Seconds as hours: one decimal under 10 h (2.5 h), whole past it (128 h); under a tenth reads "0 h". */
export const hours = (seconds: number): string => {
  const h = seconds / 3600;
  if (h >= 10) return `${Math.round(h).toLocaleString("en-US")} h`;
  const tenth = Math.floor(h * 10) / 10;
  return `${tenth === Math.floor(tenth) ? tenth.toFixed(0) : tenth.toFixed(1)} h`;
};

/** A computer's size: "2 CPU · 4 GB". */
export const sizeWord = (size: { cpu: number; memGb: number }): string => `${String(size.cpu)} CPU · ${String(size.memGb)} GB`;

/** A day as the page writes it: "Dec 20" this year, "Dec 20, 2027" another. Dates are the service's, in UTC. */
export const dayWord = (iso: string, nowMs: number): string => {
  const at = new Date(iso);
  const sameYear = at.getUTCFullYear() === new Date(nowMs).getUTCFullYear();
  return at.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
};

/** How near an expiry has to be before the page names it. */
export const EXPIRY_SHOWN_MS = 30 * 24 * 3600_000;

/** The credits that lapse within 30 days, soonest first; null when none do. */
export const expiringSoon = (state: BillingState, nowMs: number): { cents: number; at: string } | null => {
  const e = state.credits.expiring;
  if (e === null) return null;
  const at = Date.parse(e.at);
  return at > nowMs && at - nowMs <= EXPIRY_SHOWN_MS ? e : null;
};

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

/** What fixes the top line: the portal (a card), checkout (plan or credits), the cap, or nothing to press. */
export type TopFix = "portal" | "buy" | "cap" | null;

/**
 * The one line at the top of the page, when something needs the team, with what fixes it; null when nothing does.
 * The service's own notice first (a declined card, no plan and no credits), then the boxes held for credits used up or
 * the cap reached. Never before fleetd's computers are on: there is no page then (`billingOn`).
 */
export const topLine = (state: BillingState): { tone: "danger" | "warning"; message: string; fix: TopFix } | null => {
  if (!state.providedOn) return null;
  if (state.notice !== null) {
    const fix = state.notice.fix === "" ? "" : ` ${state.notice.fix}`;
    // A spend warning (the cap's share crossed, credits low) while nothing is stopped yet: a warning, not a stop.
    const warned = state.held === null ? state.warned : null;
    return { tone: warned === null ? "danger" : "warning", message: `${state.notice.message}${fix}`, fix: state.notice.action ?? (warned?.kind === "cap" ? "cap" : null) };
  }
  if (state.held === "cap") {
    const cap = state.credits.capCents === null ? "" : ` of ${money(state.credits.capCents, state.currency)}`;
    return { tone: "danger", message: `This month's spend cap${cap} is reached, so bots on fleetd's computers are stopped until next month. Raise the cap to go on.`, fix: "cap" };
  }
  if (state.held === "empty" || state.held === "none" || state.credits.leftCents <= 0) {
    return { tone: "danger", message: "No credits left, so bots on fleetd's computers are stopped. Add credits or pick a plan.", fix: "buy" };
  }
  return null;
};

/** The cap's quiet line: this month's spend against it, and that the bots are stopped once it is reached. */
export const capLine = (state: BillingState): string | null => {
  if (state.credits.capCents === null) return null;
  const spent = `${money(state.credits.capSpentCents, state.currency)} of ${money(state.credits.capCents, state.currency)} this month`;
  return state.held === "cap" ? `${spent}: reached, so bots are stopped` : spent;
};

/** A list's words: "50%", "50% and 80%", "50%, 80% and 100%". */
const andList = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`);

/** The cap's shares warned at: "50%, 80% and 100%". */
export const percentsWord = (w: BillingWarnings): string => andList(w.percents.map((p) => `${String(p)}%`));

/** When the warnings go out: "At 50%, 80% and 100% of the cap, and when credits run low." */
export const warningsWhen = (w: BillingWarnings): string => {
  const at = w.percents.length === 0 ? null : `At ${percentsWord(w)} of the cap`;
  return at === null ? "When credits run low." : `${at}${w.lowCredits ? ", and when credits run low" : ""}.`;
};

/** A limit's line: "$4.10 of $20 this month", or "$4.10 this month" with none. Its caller says when it stopped the work. */
export const limitLine = (l: Pick<SpendLimit, "limitCents" | "spentCents">, currency: string): string =>
  l.limitCents === null ? `${money(l.spentCents, currency)} this month` : `${money(l.spentCents, currency)} of ${money(l.limitCents, currency)} this month`;

/** The limits set, people first then bots, each by name: what Billing lists. */
export const limitsSet = (l: BillingLimits): { members: MemberLimit[]; bots: BotLimit[] } => {
  const byName = (a: SpendLimit, b: SpendLimit) => a.name.localeCompare(b.name);
  // Not toSorted: Hermes, which runs the phone, has none.
  return { members: l.members.filter((m) => m.limitCents !== null).sort(byName), bots: l.bots.filter((b) => b.limitCents !== null).sort(byName) };
};

/** Dollars as typed into the cap's field, as cents; null for an empty field (no cap); undefined when it isn't money. */
export const capFromInput = (typed: string): number | null | undefined => {
  const t = typed.trim().replace(/^\$/u, "").replace(/,/gu, "");
  if (t === "") return null;
  if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(t)) return undefined;
  const [whole = "0", part = ""] = t.split(".");
  return Number(whole) * 100 + Number(part.padEnd(2, "0"));
};

/** The cap as its field shows it: "50", "12.50", empty for none. */
export const capToInput = (cents: number | null): string => (cents === null ? "" : cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** The usage rows the page lists: each size used this period, biggest spend first, then by size. */
export const usageRows = (state: BillingState): BillingSize[] =>
  // Not toSorted: Hermes, which runs the phone, has none.
  state.usage.bySize.filter((s) => s.seconds > 0 || s.cents > 0).sort((a, b) => b.cents - a.cents || a.cpu - b.cpu || a.memGb - b.memGb);

/** The usage period's words: "Since Nov 1". */
export const periodWord = (state: BillingState, nowMs: number): string => `Since ${dayWord(state.usage.from, nowMs)}`;

/**
 * Whether the team has Billing at all: only once its answer says fleetd's computers are on for it. Before, there is
 * nothing to buy or count, so neither app lists it, finds it in a search or opens a page that only says so; unread yet
 * (or unreadable) is not on either, so no entry shows and then goes.
 */
export const billingOn = (state: BillingState | null | undefined): boolean => state?.providedOn === true;

/** Whether the page offers anything to buy: fleetd's computers on, payments set up, and the person may buy. */
export const buys = (state: BillingState): boolean => state.providedOn && state.setUp && state.canBuy;

/** Why buying is off, for the one place that says so; null when it is on. */
export const noBuyWhy = (state: BillingState): string | null => {
  if (!state.canBuy) return "Only the workspace's owners and admins buy plans and credits.";
  if (!state.setUp) return "Payments aren't set up on fleetd cloud yet.";
  return null;
};

// ── Stripe's way back ──────────────────────────────────────────────────────────────────────────────────────────

/** How long the page reads again after a payment, waiting for Stripe's word of it, and how often. */
export const PAID_WAIT_MS = 60_000;
export const PAID_READ_EVERY_MS = 3_000;

/** What Stripe's way back said on the web app's address (`?billing=paid` or `cancelled`, fleetd-cloud README "Payments"); null for none. */
export const billingReturnOf = (search: string): "paid" | "cancelled" | null => {
  const said = new URLSearchParams(search).get("billing");
  return said === "paid" || said === "cancelled" ? said : null;
};

/** The address's query without Stripe's word, every other parameter kept: "" when none is left. */
export const withoutBillingReturn = (search: string): string => {
  const q = new URLSearchParams(search);
  q.delete("billing");
  const left = q.toString();
  return left === "" ? "" : `?${left}`;
};

/** Whether the answer shows something paid for: a plan, or credits left. */
export const showsPaid = (state: BillingState): boolean => state.plan !== null || state.credits.leftCents > 0;

/**
 * The page's line after Stripe's way back, in place of the top line while it waits; null when there is none to say.
 * `waitedMs`: since the page opened on it. A cancelled checkout charged nothing, which the toast says alone.
 */
export const paidLine = (said: "paid" | "cancelled" | null, state: BillingState, waitedMs: number): string | null => {
  if (said !== "paid" || showsPaid(state)) return null;
  return waitedMs < PAID_WAIT_MS
    ? "Payment received. The credits show here in a moment, once Stripe confirms it."
    : `Stripe hasn't confirmed the payment yet. It shows here once it does; if it doesn't within a few minutes, write to ${SUPPORT_EMAIL}.`;
};
