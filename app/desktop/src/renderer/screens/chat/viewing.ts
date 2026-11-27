// What a message's pictures share with the viewer (ImageViewer.tsx), apart from it: the viewer itself loads on first
// use, so the first chat draws without its code.
import { createContext, useContext } from "react";
import type { Shot } from "./shots";

/** Opens the viewer on one of the message's images; undefined where no viewer is (a block shown outside the chat). */
export const ImageViewerContext = createContext<((attachmentId: string) => void) | undefined>(undefined);

export const useOpenImage = (): ((attachmentId: string) => void) | undefined => useContext(ImageViewerContext);

/**
 * Every picture in the chat, in order, for the viewer to step through, asked as it opens (ChatList gives it); undefined
 * outside a chat.
 */
export const ChatShotsContext = createContext<(() => readonly Shot[]) | undefined>(undefined);
