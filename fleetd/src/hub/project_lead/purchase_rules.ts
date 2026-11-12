// What a project may buy and with which card, with no hub behind it (purchases.ts answers the calls): the card's
// form, the purchases a list shows, and the sites no purchase may pay.
import type { Never } from "../integrations/policy.ts";

/** The most purchases `project_purchases` lists. */
export const LOG_MAX = 200;

/** A card reference (fleetd-contracts purchase.rs `CardRef`): a vault card, or for one release an `op://<vault>/<item>`. */
export const CARD_REF = /^(vault:V[0-9a-f]{32}|op:\/\/[^/?\r\n]+\/[^/?\r\n]+)$/;

/** Exchanges and brokers: paying one buys holdings, which is trading (crypto included), whatever the basket says. */
export const TRADING_SITES = [
  "coinbase.com", "binance.com", "kraken.com", "crypto.com", "bitstamp.net", "gemini.com", "bitpanda.com", "kucoin.com",
  "okx.com", "bybit.com", "robinhood.com", "etrade.com", "schwab.com", "fidelity.com", "vanguard.com",
  "interactivebrokers.com", "trading212.com", "etoro.com", "degiro.com", "webull.com",
];
/** Money-transfer services: paying one moves money to someone, not a purchase. */
export const MONEY_SITES = ["wise.com", "westernunion.com", "remitly.com", "moneygram.com", "xoom.com", "worldremit.com", "venmo.com", "cash.app", "revolut.com"];

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
