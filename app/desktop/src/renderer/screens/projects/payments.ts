// Payments in the person's words (D265), shared with the phone: money as they read it, the card a project pays with,
// each thing bought, a purchase's title and its Pay question, and Settings' card picker and purchase log. Pure, with no
// UI, so it is unit-tested.
import type { NaviCard, OnePasswordCard, Purchase, PurchaseLogEntry, PurchaseTotal } from "../../../shared/contracts";

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
export const cardLabel = (card: NaviCard): string => {
  const rest = card.ref.replace(/^op:\/\//u, "");
  const slash = rest.indexOf("/");
  return slash < 0 ? rest : `${rest.slice(slash + 1)} (${rest.slice(0, slash)})`;
};

/** Each thing bought, as one line: `Double room, 2 nights · €129.90`, with how many when more than one. */
export const itemLines = (purchase: Purchase): string[] =>
  purchase.items.map((item) => {
    const many = item.quantity !== undefined && item.quantity > 1 ? `${String(item.quantity)} × ` : "";
    const price = item.amount === undefined ? "" : ` · ${money(item.amount, purchase.total.currency)}`;
    return `${many}${item.name}${price}`;
  });

/** What the folded row says it was about, in the person's words: the shop's name, not its domain. */
export const purchaseTitle = (purchase: Purchase): string => `${totalWords(purchase.total)} at ${purchase.shop.name}`;

/** The second question a Pay asks, before anything is approved. */
export const payQuestion = (purchase: Purchase): string =>
  `Pay ${totalWords(purchase.total)} at ${purchase.shop.name} with ${cardLabel(purchase.card)}?`;

/** The picker's value for "no card". */
export const NO_CARD = "none";

/** The cards to pick from, the one picked now first among them even if this token no longer reads it. */
export const cardOptions = (cards: readonly OnePasswordCard[], picked: string | undefined): { value: string; label: string }[] => {
  const options = cards.map((c) => ({ value: c.ref, label: `${c.title} (${c.vault})` }));
  if (picked !== undefined && !options.some((o) => o.value === picked)) options.unshift({ value: picked, label: cardLabel({ ref: picked }) });
  return [...options, { value: NO_CARD, label: "No card" }];
};

/** What became of a purchase, in a few words. */
export const purchaseState = (entry: PurchaseLogEntry): string => {
  switch (entry.state) {
    case "open":
      return "Waiting for you";
    case "approved":
      return "Approved";
    case "ran":
      return "Approved, card filled";
    case "failed":
      return "Approved, never filled";
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
