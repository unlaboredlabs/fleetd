// A purchase approval's one line once answered (D265). Its words in the person's money and card are
// projects/payments.ts's.
import type { CommandApprovalItem } from "../../../shared/contracts";
import type { Outcome } from "./request";

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
