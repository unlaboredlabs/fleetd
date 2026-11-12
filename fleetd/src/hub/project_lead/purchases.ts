// A project's purchases (D265): the card it pays with, the person's purchase log, and its node's calls.
// - `project_card_set`, from a person's own device: the card the project pays with, kept as its reference only
//   (store.ts `card`, `setCard`).
// - `project_purchases`: the card and every purchase the project asked for, newest first, with what the person said.
// - `purchase_open`, `purchase_claim`, `purchase_filled`: its node's calls for its lead's `purchase_request` and
//   `purchase_fill`. Only a project's lead buys; a purchase is a record approved as it opens, with no ask (D310,
//   approvals/purchases.ts), and its fill posts a quiet "Paid …" line in the chat.
// - `secure_input_open`, `secure_input_claim`, `secure_input_filled`: its node's calls for `request_secure_input` and
//   `secure_input_fill`.
import type { PaymentCard, ProjectRef, Purchase, PurchaseLogEntry } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_NO_ASK_FILL } from "../../shared/node_link.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Registry } from "../api/registry.ts";
import { approvals } from "../approvals/index.ts";
import {
  cardLabel,
  claimPurchase,
  claimSecureInput,
  type FilledCall,
  openPurchase,
  openSecureInput,
  type PurchaseOpenCall,
  purchaseFilled,
  purchases as purchaseRequests,
  type SecureInputOpenCall,
  secureInputFilled,
} from "../approvals/purchases.ts";
import { chat } from "../chat/index.ts";
import { neverWhy, type Never } from "../integrations/policy.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/types.ts";
import { link } from "../link/server.ts";
import { store } from "../store/hub_store.ts";
import { cardLabelOf, checkCardPick, purchaseSettled, sealedCardFor, vaultCardId } from "../vault/aliases.ts";
import { isProject } from "./bridge.ts";
import * as kept from "./store.ts";

export const OPS = ["purchase_open", "purchase_claim", "purchase_filled", "secure_input_open", "secure_input_claim", "secure_input_filled"] as const;

/** The most purchases `project_purchases` lists. */
const LOG_MAX = 200;

/** A card reference (fleetd-contracts purchase.rs `CardRef`): a vault card, or for one release an `op://<vault>/<item>`. */
const CARD_REF = /^(vault:V[0-9a-f]{32}|op:\/\/[^/?\r\n]+\/[^/?\r\n]+)$/;

/** The project's card, if a person picked one; a vault card with its label and last four digits. */
export function card(hub: Hub, r: ProjectRef): PaymentCard | undefined {
  const ref = kept.card(hub.db.conn, r);
  if (ref === undefined || !CARD_REF.test(ref)) return undefined;
  const shown = cardLabelOf(hub, ref);
  return { ref, ...(shown ?? {}) } as PaymentCard;
}

/** Exchanges and brokers: paying one buys holdings, which is trading (crypto included), whatever the basket says. */
const TRADING_SITES = [
  "coinbase.com", "binance.com", "kraken.com", "crypto.com", "bitstamp.net", "gemini.com", "bitpanda.com", "kucoin.com",
  "okx.com", "bybit.com", "robinhood.com", "etrade.com", "schwab.com", "fidelity.com", "vanguard.com",
  "interactivebrokers.com", "trading212.com", "etoro.com", "degiro.com", "webull.com",
];
/** Money-transfer services: paying one moves money to someone, not a purchase. */
const MONEY_SITES = ["wise.com", "westernunion.com", "remitly.com", "moneygram.com", "xoom.com", "worldremit.com", "venmo.com", "cash.app", "revolut.com"];

/** Whether `host` is `domain` or one of its subdomains (purchase.rs `on_domain`). */
export function onDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  return h === domain || (h.endsWith(domain) && h.slice(0, h.length - domain.length).endsWith("."));
}

/**
 * What no purchase may be, even approved: a payment to an exchange or a broker (trading, crypto), or to a
 * money-transfer service (moving money). Decided by who is paid, never by words in the shop's or the items' names.
 */
export function refusedPurchase(shopDomain: string): Never | undefined {
  if (TRADING_SITES.some((s) => onDomain(shopDomain, s))) return "trading";
  return MONEY_SITES.some((s) => onDomain(shopDomain, s)) ? "money" : undefined;
}

export function start(hub: Hub): void {
  for (const op of OPS) leadCalls(hub).register(op, (caller, call) => answer(hub, caller, call));
}

const text = (v: unknown, field: string): string => {
  if (typeof v !== "string" || v === "") throw new ToolError("invalid", `${field}: expected a non-empty string`);
  return v;
};

const filledOf = (call: LeadCall): FilledCall => ({
  requestId: text(call.requestId, "requestId"),
  ok: call.ok === true,
  typed: call.typed === true,
  message: typeof call.message === "string" ? call.message : "",
});

export async function answer(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  const r = caller.projectRef;
  // Any project's lead (D310), but an archived one's.
  if (caller.agent.kind !== "lead" || !isProject(hub.db.conn, r, false)) {
    throw new ToolError(
      "forbidden",
      "Only a project's lead pays at a checkout or asks for a secure input, and this session is none.",
      "leave the payment to the person and say so",
    );
  }
  // An older node waits for the person's answer: they are asked, as before.
  const noAsk = link(hub).can(r.machineId, CAP_NO_ASK_FILL);
  const a = approvals(hub);
  switch (call.op) {
    case "purchase_open": {
      const open = call as unknown as PurchaseOpenCall;
      const never = refusedPurchase(String(open.purchase?.shop?.domain ?? ""));
      if (never !== undefined) {
        throw new ToolError("forbidden", neverWhy(never), "don't buy it another way; tell the person what you wanted to do");
      }
      const paysWith = card(hub, r);
      if (!paysWith) {
        throw new ToolError(
          "invalid",
          "You have no card to pay with.",
          "ask the person to pick one: the project's Settings › Payments, from a card in fleetd's vault; then ask again",
        );
      }
      const opened = openPurchase(a, r, open, paysWith, noAsk);
      return {
        requestId: opened.requestId,
        state: opened.state,
        next: noAsk
          ? "recorded, with no ask (D310): fill the card now with purchase_fill, on this checkout"
          : "end your turn on the checkout: the person approves or denies it in the chat, and you are woken with the answer",
      };
    }
    case "purchase_claim": {
      const sessionId = text(call.sessionId, "sessionId");
      const claimed = claimPurchase(a, r, text(call.requestId, "requestId"), sessionId);
      // A vault card goes to the node hosting the checkout, sealed to it, once per claim.
      if (vaultCardId(claimed.card) === undefined) return claimed;
      let sealedCard: string | undefined;
      try {
        sealedCard = sealedCardFor(hub, r, claimed.card, claimed.requestId, caller.via ?? r.machineId, sessionId);
      } catch (e) {
        purchaseFilled(a, r, { requestId: claimed.requestId, ok: false, typed: false, message: (e as Error).message });
        throw e;
      }
      return { ...claimed, ...(sealedCard !== undefined ? { sealedCard } : {}) };
    }
    case "purchase_filled": {
      const filledCall = filledOf(call);
      purchaseSettled(hub, filledCall.requestId, filledCall.ok, filledCall.typed);
      const filled = purchaseFilled(a, r, filledCall);
      if (call.ok === true && filled.purchase) paidLine(hub, r, filled.purchase);
      return { requestId: filled.requestId, state: filled.state };
    }
    case "secure_input_open": {
      const opened = openSecureInput(a, r, call as unknown as SecureInputOpenCall, noAsk);
      return { requestId: opened.requestId, state: opened.state };
    }
    case "secure_input_claim":
      return claimSecureInput(a, r, text(call.requestId, "requestId"), text(call.sessionId, "sessionId"));
    case "secure_input_filled": {
      const filled = secureInputFilled(a, r, filledOf(call));
      return { requestId: filled.requestId, state: filled.state };
    }
  }
  throw new ToolError("invalid", `${call.op} is not a purchase or secure input call.`);
}

/** The chat's quiet line once a card filled into a checkout: what, where, and with which card. */
function paidLine(hub: Hub, r: ProjectRef, p: Purchase): void {
  chat(hub).add(r, { author: "system", text: `Paid ${p.total.amount} ${p.total.currency} at ${p.shop.name} with ${cardLabel(p.card)}` });
}

function projectRefOf(hub: Hub, input: { machineId: string; projectId: string }): ProjectRef {
  const r = { machineId: input.machineId, projectId: input.projectId };
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  return r;
}

export function register(tools: Registry): void {
  tools.add("project_purchases", (hub, caller, input) => {
    requireRole(caller, "read", input.machineId);
    const r = projectRefOf(hub, input);
    const paysWith = card(hub, r);
    const list: PurchaseLogEntry[] = purchaseRequests(approvals(hub), r, LOG_MAX).flatMap((q) =>
      q.purchase
        ? [
            {
              purchase: q.purchase,
              requestId: q.requestId,
              state: q.state,
              askedAt: q.createdAt,
              ...(q.answeredAt !== undefined ? { answeredAt: q.answeredAt } : {}),
              ...(q.answeredBy !== undefined ? { answeredBy: q.answeredBy } : {}),
              ...(q.evidence !== undefined ? { note: String(q.evidence) } : {}),
            },
          ]
        : [],
    );
    const next = !paysWith
      ? "No card yet: pick a card from the vault (Settings › Payments, then project_card_set) so the project can " +
        "pay; each purchase is recorded, with no ask."
      : list.length === 0
        ? "No purchases yet."
        : undefined;
    return { ...(paysWith ? { card: paysWith } : {}), purchases: list, ...(next !== undefined ? { next } : {}) };
  });
  tools.add("project_card_set", (hub, caller, input) => {
    requireRole(caller, "operate", input.machineId);
    if (!isHuman(caller)) {
      throw new ToolError("forbidden", "Only a person picks the card a project pays with.", "Pick it in the app: the project's Settings › Payments.");
    }
    const r = projectRefOf(hub, input);
    if (input.card !== undefined) checkCardPick(hub, input.card);
    kept.setCard(hub.db.conn, r, input.card);
    const paysWith = input.card !== undefined ? card(hub, r) : undefined;
    return {
      ...(paysWith ? { card: paysWith } : {}),
      next: paysWith
        ? `The project pays with ${cardLabel(paysWith)} from now on, with no ask at each purchase.`
        : "The project has no card now: it can't pay at a checkout.",
    };
  });
}
