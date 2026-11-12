// A project's purchases and secure inputs as requests (crates/fleetd/src/hub/approvals/purchases.rs,
// secure_input.rs). Since D310 a purchase asks nobody: it is kept as a record, approved as it opens, and its card may
// be filled once, by the project's node, within FILL_WINDOW_MINUTES. A secure input the person types is a secret
// request with a `fill:` sink; one from 1Password is an approval filled the same way as a card.
import type {
  HumanRequest,
  NaviCard,
  ProjectRef,
  Purchase,
  PurchaseItem,
  PurchaseShop,
  PurchaseTotal,
  SecureInput,
  SecureInputSite,
} from "../../shared/contracts.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { type Approvals, projectOf, refuse } from "./index.ts";
import { FILL_WINDOW_MINUTES } from "./outcome.ts";
import { clip } from "./text.ts";

export { PAYMENT_CLIS, pays, personOnly } from "./person_only.ts";

/** A NaviCard as the person reads it: a vault card's label, or an `op://vault/item` as "item (vault)". */
export function cardLabel(card: NaviCard): string {
  if (card.label) return card.label;
  const rest = card.ref.replace(/^(op:\/\/)+/, "");
  const at = rest.indexOf("/");
  return at < 0 ? rest : `${rest.slice(at + 1)} (${rest.slice(0, at)})`;
}

export type PurchaseOpenCall = {
  sessionId: string;
  page: string;
  purchase: { shop: PurchaseShop; total: PurchaseTotal; items: PurchaseItem[] };
};
export type FilledCall = { requestId: string; ok: boolean; typed: boolean; message: string };
export type SecureInputOpenCall = {
  sessionId: string;
  input: { site: SecureInputSite; target: string; label: string; why: string; ref?: string };
};

/** The key a secure input's secret request goes by: never a variable, only a name for the request. */
const SECURE_INPUT_KEY = "navi.secure_input";

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * A Navi's `purchase_request`, from its node: opens the purchase card with the Navi's card. `noAsk`: approved as it
 * opens (D310); false for a node that would wait for the person, who is asked instead.
 */
export function openPurchase(a: Approvals, project: ProjectRef, call: PurchaseOpenCall, card: NaviCard, noAsk: boolean): HumanRequest {
  const { sessionId, purchase } = call;
  const now = a.deps.clock.now();
  const text = `Pay ${purchase.total.amount} ${purchase.total.currency} at ${purchase.shop.name} (${purchase.shop.domain}) with ${cardLabel(card)}`;
  const add = {
    projectRef: project,
    kind: "approval" as const,
    text: clip(text, 500),
    purchase: { shop: purchase.shop, total: purchase.total, items: purchase.items, card, sessionId } satisfies Purchase,
    at: isoMs(now),
    atMs: now,
  };
  return noAsk ? a.createApproved(add) : a.create(add);
}

function ownPurchase(a: Approvals, project: ProjectRef, requestId: string): [HumanRequest, Purchase] {
  const r = a.get(requestId);
  if (!r || !sameProject(projectOf(r), project) || !r.purchase) {
    throw refuse("not_found", `${requestId} is none of your purchases.`, "Use the requestId purchase_request returned.");
  }
  return [r, r.purchase];
}

/** Refuses a claim of `r` unless it is approved, and expires it past its window. */
function claimable(a: Approvals, r: HumanRequest, sessionId: string, asked: string, what: { once: string; how: string; again: string; other: string; none: string; expired: string; expiredFix: string }) {
  const id = r.requestId;
  if (r.state === "open") {
    throw refuse("invalid", `The person hasn't answered ${id} yet.`, "End your turn: you are woken with their answer.");
  }
  if (r.state === "ran") throw refuse("forbidden", `${id}${what.once}`, what.again);
  if (r.state !== "approved") throw refuse("forbidden", `${id} is ${r.state}: ${what.none}`, what.other);
  if (asked !== sessionId) throw refuse("forbidden", `${id} was asked for in another browser session.`, what.how);
  const now = a.deps.clock.now();
  const approved = (r.answeredAt ? parseMs(r.answeredAt) : undefined) ?? 0;
  if (now - approved > FILL_WINDOW_MINUTES * 60_000) {
    const why = `expired: ${what.expired} within ${FILL_WINDOW_MINUTES} minutes of the approval`;
    a.quietly(() =>
      a.changeFrom(id, "approved", (r) => {
        r.state = "failed";
        r.evidence = why;
        r.finishedAt = isoMs(now);
      }),
    );
    throw refuse("forbidden", `${id} ${why}.`, what.expiredFix);
  }
  return now;
}

/**
 * The Navi's node claims an approved purchase for one fill: refused unless it is approved, unfilled, within its
 * window and asked for in this browser session. Claimed, it is `ran` until the node says nothing was typed.
 */
export function claimPurchase(a: Approvals, project: ProjectRef, requestId: string, sessionId: string) {
  const [r, purchase] = ownPurchase(a, project, requestId);
  const now = claimable(a, r, sessionId, purchase.sessionId, {
    once: "'s card was filled already: a purchase fills once.",
    again: "Finish that checkout; for another purchase, ask again with purchase_request.",
    none: "its card isn't filled.",
    other: "Don't buy it another way; say so in the chat.",
    how: "Ask again with purchase_request from this checkout.",
    expired: "its card wasn't filled",
    expiredFix: "Ask again with purchase_request if the person still wants it.",
  });
  // Guarded on approved: of two claims at once only one moves it, so a purchase fills at most once.
  const at = isoMs(now);
  const claimed = a.changeFrom(r.requestId, "approved", (r) => {
    r.state = "ran";
    r.evidence = "filling the card into the checkout";
    r.finishedAt = at;
    if (r.purchase) r.purchase.filledAt = at;
  });
  return { requestId: claimed.requestId, domain: purchase.shop.domain, card: purchase.card.ref };
}

/** How a claimed fill went. One that typed nothing goes back to approved, to be filled again within its window. */
export function purchaseFilled(a: Approvals, project: ProjectRef, call: FilledCall): HumanRequest {
  const [r] = ownPurchase(a, project, call.requestId);
  return filled(a, r, call, "card filled into the checkout", "card partly filled, then", (r) => {
    if (r.purchase) delete r.purchase.filledAt;
  });
}

function filled(a: Approvals, r: HumanRequest, call: FilledCall, ok: string, partly: string, unfill: (r: HumanRequest) => void) {
  const said = clip(call.message, 300);
  if (call.ok || call.typed) {
    const evidence = call.ok ? `${ok}: ${said}` : `${partly}: ${said}`;
    return a.changeFrom(r.requestId, "ran", (r) => {
      r.evidence = evidence;
    });
  }
  const evidence = `not filled: ${said}; it may be filled again within its window`;
  return a.changeFrom(r.requestId, "ran", (r) => {
    r.state = "approved";
    r.evidence = evidence;
    delete r.finishedAt;
    unfill(r);
  });
}

/** Approved purchases and secure inputs past their fill window: failed, saying why. */
export function expireUnfilled(a: Approvals): void {
  const now = a.deps.clock.now();
  for (const r of a.listQuiet({ states: ["approved"], kind: "approval" })) {
    if (!r.purchase && !r.secureInput) continue;
    const at = (r.answeredAt ? parseMs(r.answeredAt) : undefined) ?? 0;
    if (now - at <= FILL_WINDOW_MINUTES * 60_000) continue;
    const why = `expired: not filled within ${FILL_WINDOW_MINUTES} minutes of the approval`;
    a.quietly(() =>
      a.changeFrom(r.requestId, "approved", (r) => {
        r.state = "failed";
        r.evidence = why;
        r.finishedAt = isoMs(now);
      }),
    );
  }
}

/** Every purchase of the project, newest first. */
export const purchases = (a: Approvals, project: ProjectRef, limit: number) =>
  a
    .listQuiet({ projectRef: project, kind: "approval" })
    .filter((r) => r.purchase)
    .slice(0, Math.max(0, limit));

/**
 * A Navi's `request_secure_input`, from its node: a sealed field for the person to type in, or an approval to fill
 * it from 1Password. `noAsk`: a 1Password field is approved as it opens (D310).
 */
export function openSecureInput(a: Approvals, project: ProjectRef, call: SecureInputOpenCall, noAsk: boolean): HumanRequest {
  const { sessionId, input } = call;
  const now = a.deps.clock.now();
  const from1Password = input.ref !== undefined;
  const text = from1Password
    ? `Fill ${input.label} on ${input.site.name} (${input.site.domain}) from 1Password: ${input.why}`
    : `Enter ${input.label} for ${input.site.name} (${input.site.domain}): ${input.why}`;
  const secureInput: SecureInput = {
    site: input.site,
    target: input.target,
    label: input.label,
    why: input.why,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    sessionId,
  };
  const add = {
    projectRef: project,
    kind: from1Password ? ("approval" as const) : ("secret" as const),
    text: clip(text, 500),
    ...(from1Password ? {} : { secret: { key: SECURE_INPUT_KEY, sink: `fill:${project.machineId}:${sessionId}` } }),
    secureInput,
    at: isoMs(now),
    atMs: now,
  };
  // From 1Password it fills with no ask (D310); a value the person types is theirs to enter, as before.
  return from1Password && noAsk ? a.createApproved(add) : a.create(add);
}

function ownSecureInput(a: Approvals, project: ProjectRef, requestId: string): [HumanRequest, SecureInput] {
  const r = a.get(requestId);
  if (!r || !sameProject(projectOf(r), project) || !r.secureInput) {
    throw refuse("not_found", `${requestId} is none of your secure inputs.`, "Use the requestId request_secure_input returned.");
  }
  return [r, r.secureInput];
}

/** The Navi's node claims an approved 1Password secure input for one fill, within its window, from the asking session. */
export function claimSecureInput(a: Approvals, project: ProjectRef, requestId: string, sessionId: string) {
  const [r, input] = ownSecureInput(a, project, requestId);
  const reference = input.ref;
  if (reference === undefined) {
    throw refuse("invalid", `${requestId} is for the person to type: fleetd fills it as they do.`, "End your turn: you are woken once it is filled.");
  }
  const now = claimable(a, r, sessionId, input.sessionId, {
    once: " was filled already: a secure input fills once.",
    again: "Ask again with request_secure_input if the page needs it again.",
    none: "it isn't filled.",
    other: "Don't get it another way; say so in the chat.",
    how: "Ask again with request_secure_input from this page.",
    expired: "it wasn't filled",
    expiredFix: "Ask again with request_secure_input if the page still needs it.",
  });
  const at = isoMs(now);
  const claimed = a.changeFrom(r.requestId, "approved", (r) => {
    r.state = "ran";
    r.evidence = "filling it in";
    r.finishedAt = at;
    if (r.secureInput) r.secureInput.filledAt = at;
  });
  return { requestId: claimed.requestId, domain: input.site.domain, target: input.target, ref: reference };
}

/** How a claimed fill went; one that typed nothing goes back to approved. */
export function secureInputFilled(a: Approvals, project: ProjectRef, call: FilledCall): HumanRequest {
  const [r] = ownSecureInput(a, project, call.requestId);
  return filled(a, r, call, "filled", "partly filled, then", (r) => {
    if (r.secureInput) delete r.secureInput.filledAt;
  });
}
