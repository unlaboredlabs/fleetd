// Payments in the person's words (D265, D312), shared with the phone: money as they read it, the card a project pays
// with, and Settings' help, card picker and purchase log. Pure, with no UI, so it is unit-tested.
import type { PaymentCard, OnePasswordCard, PurchaseLogEntry, PurchaseTotal } from "../../../shared/contracts";

/** `129.90 EUR` as the person reads money: `€129.90`. An amount Intl can't place stays as the hub sent it. */
export const money = (amount: string, currency: string): string => {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
};

export const totalWords = (total: PurchaseTotal): string => money(total.amount, total.currency);

/** `op://Personal/Visa` as `Visa (Personal)`, as the hub names it. */
export const cardLabel = (card: PaymentCard): string => {
  const rest = card.ref.replace(/^op:\/\//u, "");
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : `${rest.slice(slash + 1)} (${rest.slice(0, slash)})`;
};

/** Payments' help, word for word on the desktop's settings and the phone's (D312: a purchase fills without asking). */
export const PAYMENTS_HELP =
  "The card it pays with at a checkout, from your 1Password. fleetd fills it in at the checkout, and the project never sees it. Use a virtual or low-limit card, never your main one. Each purchase is listed below, with the shop and the total.";

/** The picker's value for "no card". */
export const NO_CARD = "none";

/** The cards to pick from, the one picked now first among them even if this token no longer reads it. */
export const cardOptions = (cards: readonly OnePasswordCard[], picked: string | undefined): { value: string; label: string }[] => {
  const options = cards.map((c) => ({ value: c.ref, label: `${c.title} (${c.vault})` }));
  if (picked !== undefined && !options.some((o) => o.value === picked)) options.unshift({ value: picked, label: cardLabel({ ref: picked }) });
  return [...options, { value: NO_CARD, label: "No card" }];
};

/** What became of a purchase, in a few words; one from before D312 may have been turned down. */
export const purchaseState = (entry: PurchaseLogEntry): string => {
  switch (entry.state) {
    case "open":
    case "approved":
      return "Not filled yet";
    case "ran":
      return "Card filled";
    case "failed":
      return "Never filled";
    case "denied":
      return "Not bought";
    default:
      return "Changed";
  }
};

/** One purchase as its log line: the shop, by its name, and what it cost. */
export const purchaseLine = (entry: PurchaseLogEntry): { shop: string; amount: string } => ({
  shop: entry.purchase.shop.name,
  amount: totalWords(entry.purchase.total),
});
