// An integration's approval card, as pure functions: who asks and what for, the rows the card lists in the order a
// person checks them (who it acts as, who it reaches, what it says, what it attaches, what it changes), the buttons
// in the act's own words, and the one line it folds to once answered. Every value is read from the exact input the
// tool runs with once approved (hub/integrations), never from the agent's own summary.
import type { CommandApprovalItem, IntegrationKind, PreviewAttachment, ToolAction, ToolPreview } from "../../../shared/contracts";
import { shortClock } from "../chat/format";
import type { Outcome } from "./request";

export const integrationName = (kind: IntegrationKind): string => (kind === "google" ? "Google" : kind === "notion" ? "Notion" : "MCP server");

/** The kicker over the card's title: "Sends · Google". */
export const actionWords = (action: ToolAction): string =>
  action === "send" ? "Sends" : action === "delete" ? "Deletes" : action === "share" ? "Shares" : action === "spend" ? "Spends money" : "Changes";

/** The one amber or red word, for what needs a second look; a send's recipient rows speak for it. */
export const actionWarning = (action: ToolAction): { readonly text: string; readonly tone: "danger" | "warning" } | undefined =>
  action === "delete" ? { text: "Can't be undone", tone: "danger" } : action === "spend" ? { text: "Costs money", tone: "danger" } : action === "share" ? { text: "Gives access", tone: "warning" } : undefined;

/** "Ada wants to send an email": the Navi by its name, then the tool's verb phrase. */
export const askTitle = (p: ToolPreview, asker: string): string => `${asker} wants to ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}`;

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

/** An address's domain: `Ana <ana@example.com>` gives `example.com`. */
export const domainOf = (address: string): string | undefined => {
  const inner = /<([^>]+)>/u.exec(address)?.[1] ?? address;
  const at = inner.lastIndexOf("@");
  return at < 0 ? undefined : inner.slice(at + 1).trim().toLowerCase() || undefined;
};

export interface PreviewValue {
  readonly text: string;
  /** Quiet words after it: "outside example.com", "120 KB · PDF", "from Drive". */
  readonly note?: string;
}

export interface PreviewRow {
  readonly label: string;
  readonly values: ReadonlyArray<PreviewValue>;
  /** Quiet words for the whole row: Bcc's "hidden from the others". */
  readonly note?: string;
}

/** "1.2 MB", "120 KB", "800 bytes". */
export const sizeText = (bytes: number): string =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : bytes >= 1000 ? `${String(Math.round(bytes / 1000))} KB` : `${String(bytes)} bytes`;

const TYPE_WORDS: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "application/zip": "ZIP archive",
  "application/msword": "Word document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word document",
  "application/vnd.ms-excel": "Excel spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel spreadsheet",
  "application/vnd.ms-powerpoint": "PowerPoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "application/octet-stream": "file",
  "text/plain": "text",
  "text/csv": "CSV",
  "text/calendar": "calendar invite",
};

/** A file's type in a word or two: "PDF", "PNG image", "Word document"; an unknown one as the email names it. */
export const typeText = (mime: string): string => {
  const known = TYPE_WORDS[mime];
  if (known !== undefined) return known;
  const [kind, sub] = mime.split("/");
  const name = (sub ?? "").replace(/\+.*$/u, "").toUpperCase();
  return (kind === "image" || kind === "video" || kind === "audio") && name !== "" ? `${name} ${kind}` : mime;
};

const attachment = (a: PreviewAttachment): PreviewValue => {
  const note = [a.bytes === undefined ? undefined : sizeText(a.bytes), a.mime === undefined ? undefined : typeText(a.mime), a.from]
    .filter((x): x is string => x !== undefined)
    .join(" · ");
  return note === "" ? { text: a.name } : { text: a.name, note };
};

/** The labelled rows above the body, only those the tool has. An address outside the From account's domain says so. */
export const previewRows = (p: ToolPreview): PreviewRow[] => {
  const rows: PreviewRow[] = [];
  const home = p.account === undefined ? undefined : domainOf(p.account);
  const people = (list: ReadonlyArray<string> | undefined): PreviewValue[] =>
    (list ?? [])
      .filter((v) => v.trim() !== "")
      .map((text) => {
        const domain = domainOf(text);
        return home !== undefined && domain !== undefined && domain !== home ? { text, note: `outside ${home}` } : { text };
      });
  const add = (label: string, values: PreviewValue[], note?: string): void => {
    if (values.length > 0) rows.push(note === undefined ? { label, values } : { label, values, note });
  };
  const one = (text: string | undefined): PreviewValue[] => (text === undefined || text.trim() === "" ? [] : [{ text }]);
  add("From", one(p.account));
  add("To", people(p.to));
  add("Cc", people(p.cc));
  add("Bcc", people(p.bcc), "hidden from the others");
  add(p.to === undefined || p.to.length === 0 ? "Reaches" : "Also", one(p.audience));
  add("When", one(p.when));
  // An event's or a page's subject is its title.
  add(p.integration === "notion" || p.when !== undefined ? "Title" : "Subject", one(p.subject));
  add("Attached", (p.attachments ?? []).map(attachment));
  add("On", one(p.target));
  return rows;
};

/** A body longer than this many characters or lines folds, with Show all. */
export const BODY_FOLD_CHARS = 1200;
export const BODY_FOLD_LINES = 18;

/** The part of a long body shown folded, or undefined when it shows whole. */
export const foldedBody = (body: string): string | undefined => {
  const lines = body.split("\n");
  if (body.length <= BODY_FOLD_CHARS && lines.length <= BODY_FOLD_LINES) return undefined;
  const head = lines.slice(0, BODY_FOLD_LINES).join("\n");
  return head.length > BODY_FOLD_CHARS ? `${head.slice(0, BODY_FOLD_CHARS).trimEnd()}…` : `${head.trimEnd()}…`;
};

/** " to ana@example.com and 2 more", or " · <target>", for the folded line. */
const reached = (p: ToolPreview): string => {
  const to = [...(p.to ?? []), ...(p.cc ?? []), ...(p.bcc ?? [])];
  const first = to[0];
  if (first !== undefined) return to.length === 1 ? ` to ${first}` : ` to ${first} and ${String(to.length - 1)} more`;
  return p.target === undefined ? "" : ` · ${p.target}`;
};

/**
 * The line an answered card folds to: what the person decided ("Approved: send an email to ana@example.com and 2 more"),
 * or undefined while it waits. Never "Sent": the hub knows the answer, not the tool's result, and the tool may still
 * refuse or fail. What happened then is in the Navi's chat.
 */
export const previewOutcome = (p: ToolPreview, item: CommandApprovalItem): Outcome | undefined => {
  const what = `${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}${reached(p)}`;
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
