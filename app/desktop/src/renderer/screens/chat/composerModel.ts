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

/** `away`: the hub restarting, by name; what is sent waits for it. */
export const placeholder = (working: boolean | undefined, away?: string, about?: string): string => {
  // From a lens: the order it goes about.
  const to = about === undefined ? "Message the lead" : `Message the lead about ${about}`;
  return away !== undefined ? `${to} · sends when ${away} is back` : working === true ? `${to}. It reads this at its next step.` : to;
};

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
  /** Where it was written (ChatMessage.client); none is this app. */
  readonly client?: string | undefined;
}

/**
 * The receipt under one of your messages. A sent message says nothing unless it is your latest: then how it reached
 * the lead. Trouble and a message that stopped the lead's step always show; a lead that can't take it yet is the bot's
 * to say, in the reply's place (WakeRow.tsx). Written elsewhere than the app, it says where.
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
      return { kind: "quiet", line: "sending… the link to the workspace dropped; it goes again when the link is back" };
    case "unanswered":
      // Safe to send again: the hub keeps one message per id.
      return { kind: "warn", line: "no answer from the workspace yet; it may have it", acts: ["resend", "dismiss"] };
    case "failed":
      return { kind: "bad", line: "not sent: the workspace refused it", ...(m.error ? { detail: m.error.message } : {}), acts: ["resend", "edit", "dismiss"] };
    case "sent":
    case "streaming":
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
 * A quiet receipt as a mark beside the bubble instead of a line under it: a faint check while it goes, a check once
 * the hub has it, at once, whether the lead took it or it waits for the lead (the bot in the reply's place says what
 * the lead does with it, WakeRow.tsx). The words go to its tooltip. Trouble, and anything you can act on, keeps its
 * line: undefined then.
 */
export interface ReceiptMark {
  readonly mark: "sending" | "delivered";
  /** The receipt in one word ("Sending", "Received", "Delivered"). */
  readonly word: string;
  /** The receipt's words in full, for the tooltip. */
  readonly words: string;
}

export function receiptMark(m: Sendable, latest: boolean): ReceiptMark | undefined {
  const r = receiptFor(m, latest);
  if (r === undefined || r.kind !== "quiet" || r.acts !== undefined) return undefined;
  const words = r.line.charAt(0).toUpperCase() + r.line.slice(1);
  if (m.state === "pending") return { mark: "sending", word: "Sending", words };
  // A steer is delivered (the lead reads it at its next step); one waiting for the lead to be free is received.
  return { mark: "delivered", word: m.delivery === "queued" ? "Received" : "Delivered", words };
}

/** Why Stop didn't stop the lead and its agents, in one plain sentence; never the hub's own words. */
export function stopFailed(code: string): string {
  switch (code) {
    case "forbidden":
      return "This computer’s key can’t stop this bot’s work.";
    case "offline":
    case "disconnected":
      return "Not connected to the workspace, so nothing was stopped.";
    case "timeout":
      return "The workspace didn’t answer, so the lead and its agents may still be working. Try Stop again.";
    default:
      return "Couldn’t stop the lead and its agents. Try Stop again.";
  }
}
