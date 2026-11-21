// A chat's pinned messages: the bot's, the same for everyone in it, kept on the hub with who pinned each and when
// (chat_message_pins), newest pinned first; any message is pinned or unpinned from its bubble's menu
// (chat_message_pin), and every open app reads them again when one is (chat.message_pins). Not the person's pinned
// chats over the list (pins.ts). Under the chat's name a glass capsule shows the newest pin's first line: with one pin
// it goes to its message, with several it opens the Pinned sheet. Pure, so it is unit-tested.
import type { ChatMessagePin, HubState } from "./desktop";
import { previewText } from "./markdown";

/** The hub searches a chat for people and keeps its pins (`chat_find_pins`): the search bar and Pin show only then. */
export const FIND_PINS = "chat_find_pins";
export const findPinsShown = (hub: HubState): boolean => hub.phase === "live" && hub.features?.includes(FIND_PINS) === true;

/** The capsule under the chat's name: the newest pin's line, and how many there are; undefined with none. */
export interface PinCapsule {
  readonly line: string;
  readonly count: number;
  /** One pin: the message the capsule goes to. Several open the sheet. */
  readonly goesTo: string | undefined;
}

/** A pin's line as the capsule and the sheet show it: its words as plain text on one line, never a block's JSON. */
export const pinLine = (pin: Pick<ChatMessagePin, "text" | "author">): string => {
  const plain = previewText(pin.text, { blocks: pin.author !== "human" }).replace(/\s+/gu, " ").trim();
  return plain === "" ? "Message" : plain;
};

export const capsuleOf = (pins: readonly ChatMessagePin[] | undefined): PinCapsule | undefined => {
  const newest = pins?.[0];
  if (pins === undefined || newest === undefined) return undefined;
  return { line: pinLine(newest), count: pins.length, goesTo: pins.length === 1 ? newest.messageId : undefined };
};

/** What VoiceOver says for the capsule. */
export const capsuleLabel = (c: PinCapsule): string => (c.count === 1 ? `Pinned message: ${c.line}` : `${String(c.count)} pinned messages. Newest: ${c.line}`);

export const isPinned = (pins: readonly ChatMessagePin[] | undefined, messageId: string): boolean => pins?.some((p) => p.messageId === messageId) === true;

/** Who pinned it and when, under its line in the sheet: "Pinned by Ada · 9:41". */
export const pinnedByLine = (pin: Pick<ChatMessagePin, "pinnedBy">, me: string | undefined, when: string): string =>
  `Pinned by ${pin.pinnedBy.personId === me ? "you" : pin.pinnedBy.name} · ${when}`;
