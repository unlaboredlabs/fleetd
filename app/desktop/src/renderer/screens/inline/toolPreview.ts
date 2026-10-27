// An integration's approval card, as pure functions: what the tool would do in words, and the rows the card lists, in
// the order a person checks them (who it acts as, who it reaches, what it says, what it changes). Every value is read
// from the exact input the tool runs with once approved (hub/integrations), never from the agent's own summary.
import type { IntegrationKind, ToolAction, ToolPreview } from "../../../shared/contracts";

export const integrationName = (kind: IntegrationKind): string => (kind === "google" ? "Google" : kind === "notion" ? "Notion" : "MCP server");

/** The kicker over the card's title: "Sends · Google". */
export const actionWords = (action: ToolAction): string =>
  action === "send" ? "Sends" : action === "delete" ? "Deletes" : action === "share" ? "Shares" : action === "spend" ? "Spends money" : "Changes";

/** What the card says on its right, when the action needs a second look; none for an ordinary change. */
export const actionWarning = (action: ToolAction): { readonly text: string; readonly tone: "danger" | "warning" } | undefined =>
  action === "delete"
    ? { text: "Can't be undone", tone: "danger" }
    : action === "spend"
      ? { text: "Costs money", tone: "danger" }
      : action === "send"
        ? { text: "Reaches other people", tone: "warning" }
        : action === "share"
          ? { text: "Gives access", tone: "warning" }
          : undefined;

/** A delete or a spend asks once more in the card before it runs. */
export const previewNeedsConfirm = (p: ToolPreview): boolean => p.action === "delete" || p.action === "spend";

export const confirmWords = (p: ToolPreview): { readonly question: string; readonly yes: string } =>
  p.action === "spend" ? { question: "Spend this money? It can't be taken back here.", yes: "Yes, pay" } : { question: "Delete it? It can't be undone.", yes: "Yes, delete it" };

export interface PreviewRow {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
}

/** The labelled rows above the body, only those the tool has. */
export const previewRows = (p: ToolPreview): PreviewRow[] => {
  const rows: PreviewRow[] = [];
  const add = (label: string, values: ReadonlyArray<string> | string | undefined): void => {
    const list = typeof values === "string" ? [values] : (values ?? []);
    const shown = list.filter((v) => v.trim() !== "");
    if (shown.length > 0) rows.push({ label, values: shown });
  };
  add("From", p.account);
  add("To", p.to);
  add("Cc", p.cc);
  add("Bcc", p.bcc);
  add(p.to === undefined || p.to.length === 0 ? "Reaches" : "Also", p.audience);
  add("When", p.when);
  // An event's or a page's subject is its title.
  add(p.integration === "notion" || p.when !== undefined ? "Title" : "Subject", p.subject);
  add("On", p.target);
  return rows;
};

/** The folded card's one line once answered: "Send an email to ana@example.com", "Notion: patch page". */
export const previewTitle = (p: ToolPreview): string => {
  const to = [...(p.to ?? []), ...(p.cc ?? []), ...(p.bcc ?? [])];
  if (to.length === 0) return p.title;
  const first = to[0] ?? "";
  return to.length === 1 ? `${p.title} to ${first}` : `${p.title} to ${first} and ${String(to.length - 1)} more`;
};
