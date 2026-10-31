// A Navi's purchase approval (D265), as pure functions: its amounts in the person's words, the card it pays with, the
// one line an answered purchase folds to and its title. The hub keeps the card as an op:// reference only.
import type { CommandApprovalItem, NaviCard, Purchase, PurchaseTotal } from "../../../shared/contracts";
import type { Outcome } from "./request";

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

/** What the folded row says it was about. */
export const purchaseTitle = (purchase: Purchase): string => `${totalWords(purchase.total)} at ${purchase.shop.name} (${purchase.shop.domain})`;

/** The one line an answered purchase folds to, or undefined while it waits. */
export const purchaseOutcome = (item: CommandApprovalItem): Outcome | undefined => {
  switch (item.state) {
    case "open":
      return undefined;
    case "approved":
      return { tone: "success", text: "Approved, card not filled yet" };
    case "ran":
      return { tone: "success", text: "Approved, card filled" };
    case "failed":
      return { tone: "danger", text: "Approved, card never filled" };
    case "denied":
      return { tone: "quiet", text: "Not bought" };
    default:
      return { tone: "quiet", text: "Changed in a newer fleetd. Update the app to see it." };
  }
};

/** The second question a Pay asks, before anything is approved. */
export const payQuestion = (purchase: Purchase): string =>
  `Pay ${totalWords(purchase.total)} at ${purchase.shop.name} with ${cardLabel(purchase.card)}?`;
