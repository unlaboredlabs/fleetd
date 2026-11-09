// The node-made lead calls of a project's checkouts and secure inputs:
// `purchase_open`, `purchase_claim`, `purchase_filled`, `secure_input_open`, `secure_input_claim` and
// `secure_input_filled`. Only a live project's lead pays at a checkout or asks for a secure input; the requests
// themselves are the approvals area's (src/hub/approvals/purchases.ts). A purchase from a trading or money-moving site
// is never opened, whatever the person would say.
import type { NaviCard, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
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
  type SecureInputOpenCall,
  secureInputFilled,
} from "../approvals/purchases.ts";
import { chat } from "../chat/index.ts";
import { leadCalls } from "../lead_calls/index.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { link } from "../link/index.ts";
import { isSessionId } from "./check.ts";

export const OPS = ["purchase_open", "purchase_claim", "purchase_filled", "secure_input_open", "secure_input_claim", "secure_input_filled"] as const;

const CAP_NO_ASK_FILL = "no_ask_fill";

const TRADING_SITES = [
  "coinbase.com", "binance.com", "kraken.com", "crypto.com", "bitstamp.net", "gemini.com", "bitpanda.com", "kucoin.com",
  "okx.com", "bybit.com", "robinhood.com", "etrade.com", "schwab.com", "fidelity.com", "vanguard.com",
  "interactivebrokers.com", "trading212.com", "etoro.com", "degiro.com", "webull.com",
];
const MONEY_SITES = ["wise.com", "westernunion.com", "remitly.com", "moneygram.com", "xoom.com", "worldremit.com", "venmo.com", "cash.app", "revolut.com"];

const TRADING =
  "Blocked by fleetd: an assistant never trades, even with your approval. Tell the person what you wanted to do; they place the trade themselves.";
const MONEY =
  "Blocked by fleetd: an assistant never moves money between accounts, even with your approval. Tell the person what you wanted to do; they make the transfer themselves.";

/** `host` is `domain` or one of its subdomains (purchase.rs `on_domain`). */
export const onDomain = (host: string, domain: string) => {
  const h = host.toLowerCase();
  return h === domain || (h.endsWith(domain) && h.slice(0, -domain.length).endsWith("."));
};

/** Why a purchase is never opened: who is paid, never the words in the basket. */
export function refusedPurchase(domain: string): string | undefined {
  if (TRADING_SITES.some((s) => onDomain(domain, s))) return TRADING;
  return MONEY_SITES.some((s) => onDomain(domain, s)) ? MONEY : undefined;
}

/** The card a project pays with: `project_settings.card_ref`, a 1Password item's reference. */
export function cardOf(hub: Hub, r: ProjectRef): NaviCard | undefined {
  const row = hub.db.all<{ card_ref: string | null }>("SELECT card_ref FROM project_settings WHERE machine_id = ? AND project_id = ?", [
    r.machineId,
    r.projectId,
  ])[0];
  const ref = row?.card_ref;
  return ref && /^op:\/\/[^/?\r\n]+\/[^/?\r\n]+(\/[^/?\r\n]+){1,2}(\?attribute=[a-z]+)?$/.test(ref) ? { ref } : undefined;
}

/** A project that is on the hub and not archived (navi/bridge.rs `is_project`). */
function isLiveProject(hub: Hub, r: ProjectRef): boolean {
  return (
    hub.db.all(
      `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND NOT EXISTS (
         SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2 AND s.archived_ms IS NOT NULL)`,
      [r.machineId, r.projectId],
    ).length > 0
  );
}

const invalid = (field: string) => new ToolError("invalid", `${field} is missing or not what the contract has.`);

function requestId(call: Record<string, unknown>): string {
  if (typeof call.requestId !== "string" || call.requestId.length === 0) throw invalid("requestId");
  return call.requestId;
}

function sessionId(call: Record<string, unknown>): string {
  if (!isSessionId(call.sessionId)) throw invalid("sessionId");
  return call.sessionId;
}

function filledCall(call: Record<string, unknown>): FilledCall {
  if (typeof call.ok !== "boolean" || typeof call.typed !== "boolean") throw invalid("ok and typed");
  const message = typeof call.message === "string" ? call.message : "";
  if ([...message].length < 1 || [...message].length > 500) throw invalid("message");
  return { requestId: requestId(call), ok: call.ok, typed: call.typed, message };
}

async function answer(hub: Hub, caller: LeadCaller, call: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = caller.projectRef;
  if (caller.agent.kind !== "lead" || !isLiveProject(hub, r)) {
    throw new ToolError(
      "forbidden",
      "Only a project's lead pays at a checkout or asks for a secure input, and this session is none.",
      "leave the payment to the person and say so",
    );
  }
  const a = approvals(hub);
  const noAsk = link(hub).can(r.machineId, CAP_NO_ASK_FILL);
  switch (call.op) {
    case "purchase_open": {
      const open = call as unknown as PurchaseOpenCall;
      sessionId(call);
      if (typeof open.page !== "string" || !open.purchase?.shop?.domain) throw invalid("purchase");
      const never = refusedPurchase(open.purchase.shop.domain);
      if (never) throw new ToolError("forbidden", never, "don't buy it another way; tell the person what you wanted to do");
      const card = cardOf(hub, r);
      if (!card) {
        throw new ToolError(
          "invalid",
          "You have no card to pay with.",
          "ask the person to pick one: the project's Settings › Payments, from a Credit Card item in their 1Password; then ask again",
        );
      }
      const opened = openPurchase(a, r, open, card, noAsk);
      return {
        requestId: opened.requestId,
        state: opened.state,
        next: noAsk
          ? "recorded, with no ask (D310): fill the card now with purchase_fill, on this checkout"
          : "end your turn on the checkout: the person approves or denies it in the chat, and you are woken with the answer",
      };
    }
    case "purchase_claim":
      return claimPurchase(a, r, requestId(call), sessionId(call));
    case "purchase_filled": {
      const filled = filledCall(call);
      const done = purchaseFilled(a, r, filled);
      const p = done.purchase;
      if (filled.ok && p) {
        chat(hub).add(r, { author: "system", text: `Paid ${p.total.amount} ${p.total.currency} at ${p.shop.name} with ${cardLabel(p.card)}` });
      }
      return { requestId: done.requestId, state: done.state };
    }
    case "secure_input_open": {
      sessionId(call);
      const opened = openSecureInput(a, r, call as unknown as SecureInputOpenCall, noAsk);
      return { requestId: opened.requestId, state: opened.state };
    }
    case "secure_input_claim":
      return claimSecureInput(a, r, requestId(call), sessionId(call));
    case "secure_input_filled": {
      const done = secureInputFilled(a, r, filledCall(call));
      return { requestId: done.requestId, state: done.state };
    }
    default:
      throw new ToolError("invalid", `${String(call.op)} is not a purchase or secure input call.`);
  }
}

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  for (const op of OPS) calls.register(op, (caller, call) => answer(hub, caller, call));
}
