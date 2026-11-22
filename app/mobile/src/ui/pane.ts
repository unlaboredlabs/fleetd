// What a screen knows of the list beside the chat (../split.ts), where the window has room for both: the width of the
// pane it draws in, and, beside the list, the way a chat picked there opens in the other pane.
import { createContext, useContext } from "react";
import { useWindowDimensions } from "react-native";
import type { ChatsParams } from "../hubContext";
import type { Key } from "../store";

/** The width of the pane a screen draws in, where it's one of two; the window's otherwise. */
export const PaneWidth = createContext<number | undefined>(undefined);

/** How wide a bubble, a picture or the pinned grid may draw: its pane's width, not the window's, beside the list. */
export const usePaneWidth = (): number => {
  const { width } = useWindowDimensions();
  return useContext(PaneWidth) ?? width;
};

/** The list beside the chat: what the list opens goes into the chat's pane, the open chat's row marked. */
export interface Beside {
  /** Shows the chat `key` in the chat's pane, in place of whatever was there; `messageId` a search hit in it. */
  readonly open: (key: Key, messageId?: string) => void;
  readonly settings: () => void;
  readonly newChat: () => void;
  /** The chat open in the other pane, whose row the list marks. */
  readonly openKey: Key | undefined;
  /** A link's filter for the list (Open Approvals: Needs You), as Chats' route params carry it where it's one screen. */
  readonly asked: ChatsParams["Chats"];
}

export const BesideContext = createContext<Beside | null>(null);

/** The list beside the chat, or null where they're one screen at a time. */
export const useBeside = (): Beside | null => useContext(BesideContext);
