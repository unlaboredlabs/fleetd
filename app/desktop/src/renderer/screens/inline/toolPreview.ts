// An integration's approval card, as pure functions: who asks and what for, the buttons in the act's own words, and
// the one line it folds to once answered. The card shows the exact input the tool runs with once approved
// (hub/integrations), never the agent's own summary.
import type { CommandApprovalItem, ToolAction, ToolPreview } from "../../../shared/contracts";
import { shortClock } from "../chat/format";
import type { Outcome } from "./request";

/** The kicker over the card's title: "Sends · MCP server". */
export const actionWords = (action: ToolAction): string =>
  action === "send" ? "Sends" : action === "delete" ? "Deletes" : action === "share" ? "Shares" : action === "spend" ? "Spends money" : "Changes";

/** The one amber or red word, for what needs a second look. */
export const actionWarning = (action: ToolAction): { readonly text: string; readonly tone: "danger" | "warning" } | undefined =>
  action === "delete" ? { text: "Can't be undone", tone: "danger" } : action === "spend" ? { text: "Costs money", tone: "danger" } : action === "share" ? { text: "Gives access", tone: "warning" } : undefined;

/** The buttons, naming the act. */
export const answerWords = (action: ToolAction): { readonly yes: string; readonly no: string } =>
  action === "send"
    ? { yes: "Send it", no: "Don't send" }
    : action === "share"
      ? { yes: "Share it", no: "Don't share" }
      : action === "delete"
        ? { yes: "Delete it", no: "Don't delete" }
        : action === "spend"
          ? { yes: "Pay", no: "Don't pay" }
          : { yes: "Do it", no: "Don't" };

/** A delete or a spend asks once more in the card before it runs. */
export const previewNeedsConfirm = (p: ToolPreview): boolean => p.action === "delete" || p.action === "spend";

export const confirmWords = (p: ToolPreview): { readonly question: string; readonly yes: string } =>
  p.action === "spend" ? { question: "Spend this money? It can't be taken back here.", yes: "Yes, pay" } : { question: "Delete it? It can't be undone.", yes: "Yes, delete it" };

const ACT_WORDS: Readonly<Record<ToolAction, string>> = { send: "a send", write: "a change", delete: "a delete", share: "a share", spend: "a payment" };

/**
 * The line an answered card folds to: what the person decided ("Approved: a send"), or undefined while it waits. Never "Sent": the hub knows the answer, not the tool's result, and the tool may still
 * refuse or fail. What happened then is in the Navi's chat.
 */
export const previewOutcome = (p: ToolPreview, item: CommandApprovalItem): Outcome | undefined => {
  // Its act, not the tool's name: a name is a slug, which the open card shows as code.
  const what = ACT_WORDS[p.action];
  switch (item.state) {
    case "open":
      return undefined;
    case "approved":
    case "ran":
      return { tone: "quiet", text: `Approved: ${what}` };
    case "failed":
      return { tone: "danger", text: `Approved, didn't run: ${what}` };
    case "denied":
      return { tone: "quiet", text: `Declined: ${what}` };
    default:
      return { tone: "quiet", text: "Changed in a newer fleetd. Update the app to see it." };
  }
};

/** Who answered and when, after the folded line: "you approved at 09:12". */
export const answeredWords = (item: CommandApprovalItem): string => {
  const at = item.answeredAt === undefined ? "" : ` at ${shortClock(item.answeredAt)}`;
  return item.state === "denied" ? `you said no${at}` : `you approved${at}`;
};
