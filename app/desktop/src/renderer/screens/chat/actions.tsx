// What a bubble can do in its chat, handed down the list once rather than through every row: reply to it, put a
// tapback on it, answer an ask in it or skip its questions, go to the bubble a reply quotes, and say a message you were
// nudged about was seen.
import { createContext, useContext } from "react";
import type { ChatAbout } from "../../../shared/contracts";
import type { ShownMark } from "./shown";
import type { ProjectRef } from "./slots";

export interface ReplyTarget {
  readonly id: string;
  /** The bubble's place in its message (its `parts` index; 0 for a message of one bubble). */
  readonly part: number;
  readonly quote: string;
}

export interface BubbleActions {
  readonly project: ProjectRef;
  /** The lead's message it waits on you about, when it does. */
  readonly waitedOn: string | undefined;
  /** The lead's message whose questions you may skip (Not needed), when it waits on questions. */
  readonly skips?: string | undefined;
  /** Sends words to the lead as you (an ask's button, a 👍 that answers). */
  readonly send: (text: string) => void;
  /** Puts the bubble over the box: what you write next answers it. */
  readonly reply: (target: ReplyTarget) => void;
  /** Brings a message into view. */
  readonly show: (id: string) => void;
  /** Where a waiting Show last went, marked while it fades. */
  readonly shown?: ShownMark | undefined;
  /** The messages to look at (nudges) still waiting, by id. */
  readonly lookAt?: ReadonlySet<string> | undefined;
  /** One of them has been seen (looked.ts). */
  readonly seen?: ((id: string) => void) | undefined;
  /** The project's chat is tagged (its trial is on): its tags, folds and lens (lens/tags.ts). */
  readonly tags?: TagActions | undefined;
}

export interface TagActions {
  /** Two or more orders are open: the tags name them. */
  readonly named: boolean;
  /** The order a lens shows, by id. */
  readonly lens?: string | undefined;
  /** The project's open orders, oldest first: what About… moves a message to. */
  readonly open: readonly ChatAbout[];
  /** Opens a lens on an order, from a tag on message `from`: closed, the chat goes back to that message. */
  readonly look: (about: ChatAbout, from: string) => void;
  /** Moves a message to an open order, or to none (About…). */
  readonly retag: (messageId: string, workstreamId: string | undefined) => void;
  /** Opens or closes a closed order's fold. */
  readonly toggleFold: (workstreamId: string) => void;
}

export const BubbleActionsContext = createContext<BubbleActions | undefined>(undefined);

export const useBubbleActions = (): BubbleActions | undefined => useContext(BubbleActionsContext);
