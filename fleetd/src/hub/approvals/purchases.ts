// A project's purchases and secure inputs as requests (crates/fleetd/src/hub/approvals/purchases.rs,
// secure_input.rs). Since D310 a purchase asks nobody: it is kept as a record, approved as it opens, and its card may
// be filled once, by the project's node, within FILL_WINDOW_MINUTES. A secure input the person types is a secret
// request with a `fill:` sink; one from 1Password is an approval filled the same way as a card.
import type {
  HumanRequest,
  PaymentCard,
  ProjectRef,
  Purchase,
  PurchaseItem,
  PurchaseShop,
  PurchaseTotal,
  SecureInput,
  SecureInputSite,
} from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { type Approvals, projectOf, refuse } from "./index.ts";
import {
  type ClaimWords,
  claimRefusal,
  expiredWhy,
  filledEvidence,
  notOwnPurchase,
  notOwnSecureInput,
  pastWindow,
  PURCHASE_CLAIM,
  purchaseText,
  SECURE_INPUT_CLAIM,
  SECURE_INPUT_KEY,
  secureInputText,
  typedInput,
} from "./purchase_rules.ts";
import { clip } from "./text.ts";

export { PAYMENT_CLIS, pays, personOnly } from "./person_only.ts";

export { cardLabel } from "./purchase_rules.ts";

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

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * A project's `purchase_request`, from its node: opens the purchase card with the project's card. `noAsk`: approved as it
 * opens (D310); false for a node that would wait for the person, who is asked instead.
 */
export function openPurchase(a: Approvals, project: ProjectRef, call: PurchaseOpenCall, card: PaymentCard, noAsk: boolean): HumanRequest {
  const { sessionId, purchase } = call;
  const now = a.deps.clock.now();
  const text = purchaseText(purchase, card);
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
    throw notOwnPurchase(requestId);
  }
  return [r, r.purchase];
}

/** Refuses a claim of `r` unless it is approved, and expires it past its window. */
function claimable(a: Approvals, r: HumanRequest, sessionId: string, asked: string, what: ClaimWords) {
  const id = r.requestId;
  const refused = claimRefusal(r, sessionId, asked, what);
  if (refused) throw refused;
  const now = a.deps.clock.now();
  if (pastWindow(r, now)) {
    const why = expiredWhy(what.expired);
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
 * The project's node claims an approved purchase for one fill: refused unless it is approved, unfilled, within its
 * window and asked for in this browser session. Claimed, it is `ran` until the node says nothing was typed.
 */
export function claimPurchase(a: Approvals, project: ProjectRef, requestId: string, sessionId: string) {
  const [r, purchase] = ownPurchase(a, project, requestId);
  const now = claimable(a, r, sessionId, purchase.sessionId, PURCHASE_CLAIM);
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
  const { evidence, again } = filledEvidence(call, ok, partly);
  if (!again) {
    return a.changeFrom(r.requestId, "ran", (r) => {
      r.evidence = evidence;
    });
  }
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
    if (!pastWindow(r, now)) continue;
    const why = expiredWhy("not filled");
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
 * A project's `request_secure_input`, from its node: a sealed field for the person to type in, or an approval to fill
 * it from 1Password. `noAsk`: a 1Password field is approved as it opens (D310).
 */
export function openSecureInput(a: Approvals, project: ProjectRef, call: SecureInputOpenCall, noAsk: boolean): HumanRequest {
  const { sessionId, input } = call;
  const now = a.deps.clock.now();
  const from1Password = input.ref !== undefined;
  const text = secureInputText(input, from1Password);
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
    throw notOwnSecureInput(requestId);
  }
  return [r, r.secureInput];
}

/** The project's node claims an approved 1Password secure input for one fill, within its window, from the asking session. */
export function claimSecureInput(a: Approvals, project: ProjectRef, requestId: string, sessionId: string) {
  const [r, input] = ownSecureInput(a, project, requestId);
  const reference = input.ref;
  if (reference === undefined) {
    throw typedInput(requestId);
  }
  const now = claimable(a, r, sessionId, input.sessionId, SECURE_INPUT_CLAIM);
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
