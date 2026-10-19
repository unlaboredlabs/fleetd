// STAND-IN until E1's chat data layer lands (fix/desktop-chat-data: src/renderer/src/data/{selectors,chat}): the
// shapes it announced, field for field. Swap these for its exports and delete this file; add nothing here.
import type { HubError } from "../../../shared/hub";

export interface ChatAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface ChatItem {
  /** The message id; the clientRequestId while pending. */
  readonly id: string;
  readonly author: "human" | "lead" | "system";
  /** "event": PR / merge one-liners and migrated history lines. "secret" / "gated": inline items. */
  readonly kind: "message" | "event" | "secret" | "gated";
  /** Markdown; the text so far while streaming. */
  readonly text: string;
  readonly at: string;
  readonly attachments: readonly ChatAttachment[];
  readonly state: "sent" | "streaming" | "pending" | "failed";
  readonly error?: HubError;
  readonly clientRequestId?: string;
}

export interface ChatView {
  /** Oldest first; a streaming lead message is the last item. */
  readonly items: readonly ChatItem[];
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly error?: HubError;
}
