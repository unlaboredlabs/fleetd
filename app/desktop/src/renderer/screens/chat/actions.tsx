// What a bubble can do in its chat, handed down the list once rather than through every row: reply to it, put a
// tapback on it, answer an ask in it, and go to the bubble a reply quotes.
import { createContext, useContext } from "react";
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
  /** Sends words to the lead as you (an ask's button, a 👍 that answers). */
  readonly send: (text: string) => void;
  /** Puts the bubble over the box: what you write next answers it. */
  readonly reply: (target: ReplyTarget) => void;
  /** Brings a message into view. */
  readonly show: (id: string) => void;
  /** Where a waiting Show last went, marked while it fades. */
  readonly shown?: ShownMark | undefined;
}

export const BubbleActionsContext = createContext<BubbleActions | undefined>(undefined);

export const useBubbleActions = (): BubbleActions | undefined => useContext(BubbleActionsContext);
