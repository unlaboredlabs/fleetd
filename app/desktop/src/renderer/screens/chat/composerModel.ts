// The chat composer's words and rules, pure. One box: the hub decides whether a message starts the lead's turn or
// reaches it mid-turn as a steer (chat_send), so the composer only says which to expect.

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

export const KEY_HINT = "Enter send · ⇧Enter new line";

const utf8 = new TextEncoder();
/** The hub's limit on a message's text, in UTF-8 bytes; more goes in as a file. */
export const MAX_BYTES = 4000;

/** The trimmed text, or why it can't be sent. "1 go" and "nvm" are messages like any other. */
export function checkMessage(text: string, attachments: number): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (t === "" && attachments === 0) return { ok: false, reason: "" };
  const bytes = utf8.encode(t).length;
  if (bytes > MAX_BYTES) return { ok: false, reason: `That’s ${bytes} bytes; a message is at most ${MAX_BYTES}. Paste the rest as a file.` };
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
  readonly delivery?: "sent" | "delivered" | undefined;
  /** It reached the lead mid-turn. */
  readonly steer?: boolean | undefined;
}

/**
 * The receipt under one of your messages. A sent message says nothing unless it is your latest: then "sent", or
 * "delivered" once the lead has it ("at its next step" when it was working). Trouble always shows.
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
      if (!latest) return undefined;
      if (m.delivery === "delivered") return { kind: "quiet", line: m.steer === true ? "delivered at its next step" : "delivered" };
      return { kind: "quiet", line: m.steer === true ? "sent; the lead reads it at its next step" : "sent" };
  }
}
