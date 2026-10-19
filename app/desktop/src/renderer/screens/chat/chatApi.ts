// The composer's slice of the chat contract (H1) and of the data layer's chat actions (A7).

import type { AttachmentId } from "../../../shared/contracts";

/** "sent": the hub has it. "pending": cut off or unanswered, resent by the layer. "failed": not sent, its item says
 *  why. "offline": not sent and no item; the words stay in the box. */
export type SendOutcome = "sent" | "pending" | "failed" | "offline";

/** The data layer's chat actions (E1, A7): the layer owns pending messages and their clientRequestIds. */
export interface ChatActions {
  send(key: string, input: { readonly text: string; readonly attachments?: readonly AttachmentId[] }): Promise<SendOutcome>;
  retry(key: string, clientRequestId: string): void;
  discard(key: string, clientRequestId: string): void;
}
