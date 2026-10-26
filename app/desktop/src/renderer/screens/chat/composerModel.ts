// The chat composer's words and rules, pure. One box: the hub decides whether a message starts the lead's turn or
// reaches it mid-turn as a steer (chat_send, or with ⌘Enter `now`, which stops its step), so the composer only says
// which to expect.

import { CHAT_TEXT_MAX, type ChatDelivery } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";

export interface KeyLike {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** An IME is composing: Enter picks a candidate, it never sends. */
  readonly isComposing: boolean;
}

/** Enter sends; Shift+Enter (or Alt+Enter) is a newline. */
export const sendsOn = (e: KeyLike): boolean => e.key === "Enter" && !e.shiftKey && !e.altKey && !e.isComposing;

export const placeholder = (working: boolean | undefined): string =>
  working === true ? "Message the lead. It reads this at its next step." : "Message the lead";

/** ↑ with nothing in the box (no words, no files) brings back your last message, as in a shell. */
export const recallsOn = (e: KeyLike & { readonly metaKey: boolean; readonly ctrlKey: boolean }, box: { readonly text: string; readonly attached: readonly unknown[] }): boolean =>
  e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing && box.text === "" && box.attached.length === 0;

/** chat_send's limit on a message's text (ChatSendInput.text, JSON string length); more goes in as a file. */
export const MAX_CHARS = CHAT_TEXT_MAX;

/** The trimmed text, or why it can't be sent. "1 go" and "nvm" are messages like any other; files need a word. */
export function checkMessage(text: string, attachments: number): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (t === "") return { ok: false, reason: attachments > 0 ? "Add a few words about the files." : "" };
  if (t.length > MAX_CHARS) return { ok: false, reason: `A message is at most ${MAX_CHARS.toLocaleString("en-US")} characters; this is ${t.length.toLocaleString("en-US")}. Attach the rest as a file.` };
  return { ok: true, text: t };
}

/** What a sent message's line says, quietly: where it is, or why it isn't there. */
export type Receipt =
  | { readonly kind: "quiet"; readonly line: string; readonly acts?: readonly Act[] }
  | { readonly kind: "warn"; readonly line: string; readonly acts: readonly Act[] }
  | { readonly kind: "bad"; readonly line: string; readonly detail?: string; readonly acts: readonly Act[] };

export type Act = "resend" | "edit" | "dismiss";

export const ACT_LABEL: Readonly<Record<Act, string>> = { resend: "Resend", edit: "Edit", dismiss: "Dismiss" };

/** A message of yours as the layer holds it (selectChat's item). */
export interface Sendable {
  readonly state: "sent" | "streaming" | "pending" | "queued" | "reconnecting" | "unanswered" | "failed";
  readonly error?: HubError | undefined;
  /**
   * How it reached the lead (ChatMessage.delivery): it started a turn, joined the running one, stopped the running
   * step (`now`), or waits for one.
   */
  readonly delivery?: ChatDelivery | undefined;
  /** chat_send's word on why the lead doesn't have it yet, with the fix. */
  readonly leadWaiting?: string | undefined;
  /** Where it was written (ChatMessage.client); none is this app. */
  readonly client?: string | undefined;
}

/**
 * The receipt under one of your messages. A sent message says nothing unless it is your latest: then how it reached
 * the lead. Trouble, a lead that can't take it yet, and a message that stopped the lead's step always show. Written
 * elsewhere than the app, it says where.
 */
export function receiptFor(m: Sendable, latest: boolean): Receipt | undefined {
  const r = receiptOf(m, latest);
  if (m.client === undefined || m.client === "app") return r;
  const from = `from ${m.client}`;
  return r === undefined ? { kind: "quiet", line: from } : { ...r, line: `${r.line} · ${from}` };
}

function receiptOf(m: Sendable, latest: boolean): Receipt | undefined {
  switch (m.state) {
    case "pending":
      return { kind: "quiet", line: "sending…" };
    case "queued":
      // Written offline: it goes by itself, under its own id, when the link is back. Until then it can be taken back.
      return { kind: "quiet", line: "queued; sends when the connection is back", acts: ["edit", "dismiss"] };
    case "reconnecting":
      return { kind: "quiet", line: "sending… the link to the hub dropped; it goes again when the link is back" };
    case "unanswered":
      // Safe to send again: the hub keeps one message per id.
      return { kind: "warn", line: "no answer from the hub yet; it may have it", acts: ["resend", "dismiss"] };
    case "failed":
      return { kind: "bad", line: "not sent: the hub refused it", ...(m.error ? { detail: m.error.message } : {}), acts: ["resend", "edit", "dismiss"] };
    case "sent":
    case "streaming":
      if (m.leadWaiting !== undefined && latest) return { kind: "warn", line: `sent; the lead doesn’t have it yet: ${m.leadWaiting}`, acts: [] };
      if (m.delivery === "now") return { kind: "quiet", line: "delivered; the lead stopped its step to read this" };
      if (!latest) return undefined;
      switch (m.delivery) {
        case "turn":
          return { kind: "quiet", line: "delivered" };
        case "steer":
          return { kind: "quiet", line: "delivered; the lead reads it at its next step" };
        case "queued":
          return { kind: "quiet", line: "sent; the lead takes it when it’s free" };
        default:
          return { kind: "quiet", line: "sent" };
      }
  }
}

/**
 * A quiet receipt as a mark beside the bubble instead of a line under it (W42): an open ring while it waits for the
 * lead (sending, or queued for when it's free), a check once the lead has it. The words go to its tooltip. Trouble,
 * and anything you can act on, keeps its line: undefined then.
 */
export interface ReceiptMark {
  readonly mark: "waiting" | "delivered";
  /** Direction B's one word under the bubble. */
  readonly word: string;
  /** The receipt's words in full, for the tooltip. */
  readonly words: string;
}

export function receiptMark(m: Sendable, latest: boolean): ReceiptMark | undefined {
  const r = receiptFor(m, latest);
  if (r === undefined || r.kind !== "quiet" || r.acts !== undefined) return undefined;
  const words = r.line.charAt(0).toUpperCase() + r.line.slice(1);
  if (m.state === "pending") return { mark: "waiting", word: "Sending", words };
  // A steer is delivered (the lead reads it at its next step); only one waiting for the lead to be free is queued.
  return m.delivery === "queued" ? { mark: "waiting", word: "Queued", words } : { mark: "delivered", word: "Delivered", words };
}

/** Why Stop didn't stop the lead and its agents, in one plain sentence; never the hub's own words. */
export function stopFailed(code: string): string {
  switch (code) {
    case "forbidden":
      return "This computer’s key can’t stop this project’s work.";
    case "offline":
    case "disconnected":
      return "Not connected to the hub, so nothing was stopped.";
    case "timeout":
      return "The hub didn’t answer, so the lead and its agents may still be working. Try Stop again.";
    default:
      return "Couldn’t stop the lead and its agents. Try Stop again.";
  }
}
