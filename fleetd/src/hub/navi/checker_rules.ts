// A Navi's approval checker's rules, without the hub (checker_turn.ts): what an action does in a line, the review the
// checker is given, a plain public read that needs no checker, the class of action it never judges, and the log entry
// and chat line of an action that ran without asking.
import type { AutoApproved, AutoApprovedBy } from "../../shared/contracts.ts";
import type { Action } from "../approvals/ports.ts";
import { namedReads } from "../integrations/policy.ts";
import { isoMs } from "../store/time.ts";
import * as review from "./review.ts";
import { clip, type Read, type Standing } from "./review.ts";

export const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** The email addresses in an input's text, each once, lower case. */
export function addresses(input: unknown): string[] {
  const out: string[] = [];
  for (const [, text] of review.leaves(input)) {
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      const found = m[0].replace(/\.+$/, "").toLowerCase();
      if (!out.includes(found)) out.push(found);
    }
  }
  return out;
}

/** What `action` does, in one line of markdown, for the chat and the log: "`send_message` on `mail`, to sam@example.com". */
export function what(action: Action): string {
  const to = addresses(action.input);
  const more = to.length > 3 ? ` and ${to.length - 3} more` : "";
  const toText = to.length === 0 ? "" : `, to ${to.slice(0, 3).join(", ")}${more}`;
  // Markdown: names and hosts in backticks, as the chat and the app show code.
  const field = (k: string) => {
    const v = action.input !== null && typeof action.input === "object" ? (action.input as Record<string, unknown>)[k] : undefined;
    return (typeof v === "string" ? v : "").replaceAll("`", "'");
  };
  let text: string;
  if (action.preview?.action === "confirm") text = `Click "${field("button")}" on \`${field("site")}\``;
  else if (action.preview) text = `\`${action.preview.tool}\` on \`${action.preview.server}\`${toText}`;
  else if (action.site !== undefined) text = action.tool === "WebFetch" ? `Fetch \`${action.site}\`` : `Open \`${action.site}\``;
  else text = `\`${action.tool}\`: ${action.summary.replaceAll("`", "'")}`;
  return clip(oneLine(text), 300);
}

/** The class of action no mode lets through without the person, nor gives the checker: a spend. */
export const alwaysAsks = (action: Action) => action.preview?.action === "spend";

/** A `Line<1, max>` the hub builds: undefined when it isn't one. */
const line = (text: string, max: number) => (text !== "" && text.length <= max && !/[\r\n]/.test(text) ? text : undefined);

/** The checker's reason in one line, or undefined for none. */
const reasonLine = (reason: string | undefined) =>
  reason === undefined ? undefined : oneLine(reason) === "" ? undefined : clip(oneLine(reason), 300);

/**
 * The quiet chat line of an action that ran without asking: a checker's go has one, which its log entry links to;
 * YOLO posts nothing, since the person chose not to be bothered.
 */
export function autoApprovedText(action: Action, by: AutoApprovedBy, reason?: string): string | undefined {
  if (by !== "checker") return undefined;
  const did = what(action);
  const why = reasonLine(reason);
  return why !== undefined ? `Let through without asking you: ${did}. The checker's reason: ${why}` : `Let through without asking you: ${did}.`;
}

/** An action that ran without asking at `atMs`, as the Navi's auto-approved log keeps it, linked to its chat line. */
export function autoApprovedEntry(
  action: Action,
  by: AutoApprovedBy,
  reason: string | undefined,
  atMs: number,
  messageId?: AutoApproved["messageId"],
): AutoApproved {
  const why = reasonLine(reason);
  const r1 = why !== undefined ? line(why, 300) : undefined;
  return {
    at: isoMs(atMs),
    by,
    tool: line(clip(action.tool, 200), 200) ?? "a tool",
    what: line(what(action), 300) ?? "an action",
    ...(r1 !== undefined ? { reason: r1 } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

/** What the checker's review is built from besides the action. */
export type Context = {
  /** The person: their name. */
  person: unknown;
  /** Oldest first. */
  personMessages: string[];
  leadLastQuestion?: string;
  /** The automations the person wrote or said yes to whose runs are open now (`standing`). */
  standing: Standing[];
  reads: Read[];
  allowedSites: string[];
  today: string;
};

export const TURN_NOT_PORTED = "the Bun hub can't run the checker's session yet (src/hub/executor: turn)";

const field = (input: unknown) => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined);

/** The checker's review of `action`: the action as it runs, with its tool and kind, and where each part came from. */
export function reviewOf(action: Action, context: Context): review.Review {
  const url = action.site !== undefined ? review.visitUrl(action.input) : undefined;
  const p = action.preview;
  const kind =
    p?.action === "send"
      ? "send"
      : p?.action === "share"
        ? "share"
        : p?.action === "delete"
          ? "delete"
          : p?.action === "spend"
            ? "spend"
            : // A read that reaches the checker links somewhere (`policy::rule`).
              p?.action === "write"
              ? namedReads(p.tool, action.input)
                ? "read"
                : "write"
              : p?.action === "confirm"
                ? "confirm_step"
                : action.site !== undefined
                  ? "visit"
                  : "tool";
  const shown: Record<string, unknown> = { tool: action.tool, kind };
  const o = field(action.input);
  if (o) {
    for (const [k, v] of Object.entries(o)) if (k !== "tool" && k !== "kind") shown[k] = v;
  } else shown.input = action.input;
  if (url !== undefined) shown.url = url;
  const [mine, contacts] = review.known(context.personMessages, context.reads);
  let person = context.person;
  const po = field(person);
  if (po && mine.length > 0) person = { ...po, emails: mine };
  return {
    person,
    contacts: contacts.map((email) => ({ email })),
    allowed_sites: [...context.allowedSites],
    today: context.today,
    person_messages: [...context.personMessages],
    ...(context.leadLastQuestion !== undefined ? { lead_last_question: `(written by the lead, not the person) ${context.leadLastQuestion}` } : {}),
    standing_requests: [...context.standing],
    provenance: review.provenance(action.input, url, context.personMessages, context.standing, context.reads, context.allowedSites),
    action: shown,
  };
}

/**
 * Whether `action` is a plain public page read (D286): a fetch or a browser's first visit to a site whose link carries
 * no data from the person's chat, their own data or a secret, and no floor. Anything else keeps the gate.
 */
export function publicRead(action: Action, context: Context): boolean {
  if (action.preview !== undefined || action.site === undefined) return false;
  const url = review.visitUrl(action.input);
  if (url === undefined) return false;
  const shown = { ...(field(action.input) ?? {}), tool: action.tool };
  return review.floor(shown) === undefined && review.plainRead(url, context.personMessages, context.reads);
}
