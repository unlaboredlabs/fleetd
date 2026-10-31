// A Navi's Payments setting (D265), as pure functions: the card picker's choices and each purchase's line in the log.
import type { OnePasswordCard, PurchaseLogEntry } from "../../../shared/contracts";
import { cardLabel, totalWords } from "../inline/purchase";

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
