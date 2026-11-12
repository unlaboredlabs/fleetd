// Purchases' and secure inputs' rules and words, with no requests store behind them (purchases.ts keeps them as
// requests): a card as the person reads it, the request's line, and what a claim or a fill that can't go is told.
import type { HumanRequest, PaymentCard, PurchaseShop, PurchaseTotal, SecureInputSite } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { parseMs } from "../store/time.ts";
import { FILL_WINDOW_MINUTES } from "./outcome.ts";
import { clip } from "./text.ts";

/** A PaymentCard as the person reads it: a vault card's label, or an `op://vault/item` as "item (vault)". */
export function cardLabel(card: PaymentCard): string {
  if (card.label) return card.label;
  const rest = card.ref.replace(/^(op:\/\/)+/, "");
  const at = rest.indexOf("/");
  return at < 0 ? rest : `${rest.slice(at + 1)} (${rest.slice(0, at)})`;
}

/** The key a secure input's secret request goes by: never a variable, only a name for the request. */
export const SECURE_INPUT_KEY = "browser.secure_input";

/** A purchase's request line. */
export const purchaseText = (purchase: { shop: PurchaseShop; total: PurchaseTotal }, card: PaymentCard) =>
  `Pay ${purchase.total.amount} ${purchase.total.currency} at ${purchase.shop.name} (${purchase.shop.domain}) with ${cardLabel(card)}`;

/** A secure input's request line: filled from 1Password, or typed by the person. */
export const secureInputText = (input: { site: SecureInputSite; label: string; why: string }, from1Password: boolean) =>
  from1Password
    ? `Fill ${input.label} on ${input.site.name} (${input.site.domain}) from 1Password: ${input.why}`
    : `Enter ${input.label} for ${input.site.name} (${input.site.domain}): ${input.why}`;

/** What a refused claim says, in a purchase's words or a secure input's. */
export type ClaimWords = { once: string; how: string; again: string; other: string; none: string; expired: string; expiredFix: string };

export const PURCHASE_CLAIM: ClaimWords = {
  once: "'s card was filled already: a purchase fills once.",
  again: "Finish that checkout; for another purchase, ask again with purchase_request.",
  none: "its card isn't filled.",
  other: "Don't buy it another way; say so in the chat.",
  how: "Ask again with purchase_request from this checkout.",
  expired: "its card wasn't filled",
  expiredFix: "Ask again with purchase_request if the person still wants it.",
};

export const SECURE_INPUT_CLAIM: ClaimWords = {
  once: " was filled already: a secure input fills once.",
  again: "Ask again with request_secure_input if the page needs it again.",
  none: "it isn't filled.",
  other: "Don't get it another way; say so in the chat.",
  how: "Ask again with request_secure_input from this page.",
  expired: "it wasn't filled",
  expiredFix: "Ask again with request_secure_input if the page still needs it.",
};

/** Why `r` can't be claimed by `sessionId` (`asked`: the session it was asked from), before its window is looked at. */
export function claimRefusal(r: HumanRequest, sessionId: string, asked: string, what: ClaimWords): ToolError | undefined {
  const id = r.requestId;
  if (r.state === "open") return new ToolError("invalid", `The person hasn't answered ${id} yet.`, "End your turn: you are woken with their answer.");
  if (r.state === "ran") return new ToolError("forbidden", `${id}${what.once}`, what.again);
  if (r.state !== "approved") return new ToolError("forbidden", `${id} is ${r.state}: ${what.none}`, what.other);
  if (asked !== sessionId) return new ToolError("forbidden", `${id} was asked for in another browser session.`, what.how);
  return undefined;
}

/** Whether an approved `r` is past its fill window at `now` (ms). */
export const pastWindow = (r: HumanRequest, now: number) => now - ((r.answeredAt ? parseMs(r.answeredAt) : undefined) ?? 0) > FILL_WINDOW_MINUTES * 60_000;

/** An approval's evidence once its window is over unfilled: `expired` in the claim's words. */
export const expiredWhy = (expired: string) => `expired: ${expired} within ${FILL_WINDOW_MINUTES} minutes of the approval`;

/** `requestId` is no purchase of the project's. */
export const notOwnPurchase = (requestId: string) =>
  new ToolError("not_found", `${requestId} is none of your purchases.`, "Use the requestId purchase_request returned.");

/** `requestId` is no secure input of the project's. */
export const notOwnSecureInput = (requestId: string) =>
  new ToolError("not_found", `${requestId} is none of your secure inputs.`, "Use the requestId request_secure_input returned.");

/** A claim of a secure input the person types. */
export const typedInput = (requestId: string) =>
  new ToolError("invalid", `${requestId} is for the person to type: fleetd fills it as they do.`, "End your turn: you are woken once it is filled.");

/**
 * The evidence a reported fill leaves (`ok`, `partly`: the fill's words), and whether it goes back to approved, to be
 * filled again within its window: one that typed nothing does.
 */
export function filledEvidence(call: { ok: boolean; typed: boolean; message: string }, ok: string, partly: string): { evidence: string; again: boolean } {
  const said = clip(call.message, 300);
  if (call.ok || call.typed) return { evidence: call.ok ? `${ok}: ${said}` : `${partly}: ${said}`, again: false };
  return { evidence: `not filled: ${said}; it may be filled again within its window`, again: true };
}
