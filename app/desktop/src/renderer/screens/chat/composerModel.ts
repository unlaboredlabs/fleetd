// The chat composer's words and rules, pure. One box: the hub decides whether a message starts the lead's turn or
// reaches it mid-turn as a steer (chat_send), so the composer only says which to expect.

import type { ChatDelivery } from "../../../shared/contracts";
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
export const MAX_CHARS = 20_000;

/** The trimmed text, or why it can't be sent. "1 go" and "nvm" are messages like any other; files need a word. */
export function checkMessage(text: string, attachments: number): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (t === "") return { ok: false, reason: attachments > 0 ? "Add a few words about the files." : "" };
  if (t.length > MAX_CHARS) return { ok: false, reason: `A message is at most ${MAX_CHARS.toLocaleString("en-US")} characters; this is ${t.length.toLocaleString("en-US")}. Attach the rest as a file.` };
  return { ok: true, text: t };
}

/** What a sent message's line says, quietly: where it is, or why it isn't there. */
export type Receipt =
  | { readonly kind: "quiet"; readonly line: string }
  | { readonly kind: "warn"; readonly line: string; readonly acts: readonly Act[] }
  | { readonly kind: "bad"; readonly line: string; readonly detail?: string; readonly acts: readonly Act[] };

export type Act = "resend" | "edit" | "dismiss";

export const ACT_LABEL: Readonly<Record<Act, string>> = { resend: "Resend", edit: "Edit", dismiss: "Dismiss" };

/** A message of yours as the layer holds it (selectChat's item). */
export interface Sendable {
  readonly state: "sent" | "streaming" | "pending" | "reconnecting" | "unanswered" | "failed";
  readonly error?: (HubError & { readonly offline?: boolean }) | undefined;
  /** How it reached the lead (ChatMessage.delivery): it started a turn, joined the running one, or waits for one. */
  readonly delivery?: ChatDelivery | undefined;
  /** chat_send's word on why the lead doesn't have it yet, with the fix. */
  readonly leadWaiting?: string | undefined;
}

/**
 * The receipt under one of your messages. A sent message says nothing unless it is your latest: then how it reached
 * the lead. Trouble, and a lead that can't take it yet, always show.
 */
export function receiptFor(m: Sendable, latest: boolean): Receipt | undefined {
  switch (m.state) {
    case "pending":
      return { kind: "quiet", line: "sending…" };
    case "reconnecting":
      return { kind: "quiet", line: "sending… the link to the hub dropped; it goes again when the link is back" };
    case "unanswered":
      // Safe to send again: the hub keeps one message per id.
      return { kind: "warn", line: "no answer from the hub yet; it may have it", acts: ["resend", "dismiss"] };
    case "failed":
      return m.error?.offline === true
        ? { kind: "bad", line: "not sent: not connected to the hub", acts: ["resend", "edit", "dismiss"] }
        : { kind: "bad", line: "not sent: the hub refused it", ...(m.error ? { detail: m.error.message } : {}), acts: ["resend", "edit", "dismiss"] };
    case "sent":
    case "streaming":
      if (m.leadWaiting !== undefined && latest) return { kind: "warn", line: `sent; the lead doesn’t have it yet: ${m.leadWaiting}`, acts: [] };
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

/** Why Stop didn't stop the lead, in one plain sentence; never the hub's own words. */
export function stopFailed(code: string): string {
  switch (code) {
    case "forbidden":
      return "This computer’s key can’t stop the lead.";
    case "offline":
    case "disconnected":
      return "Not connected to the hub, so the lead wasn’t stopped.";
    case "timeout":
      return "The hub didn’t answer, so the lead may still be working. Try Stop again.";
    default:
      return "Couldn’t stop the lead. Try Stop again.";
  }
}
