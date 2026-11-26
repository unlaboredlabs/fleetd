// The images the viewer steps through, in the order they show: a message's image blocks, then the images sent with
// it; and the chat's, every message's in turn, so ← and → go on past the message's own. A clip plays where it is and
// isn't one of them. Pure.
import type { ChatItem } from "../../src/data/chat";
import { bubblesOf, type Bubble } from "./bubbles";

export interface Shot {
  readonly attachmentId: string;
  readonly caption?: string | undefined;
  /** The file's name, said when there is no caption. */
  readonly name?: string | undefined;
}

export function shotsOf(item: ChatItem, bubbles: readonly Bubble[]): readonly Shot[] {
  const out: Shot[] = [];
  for (const b of bubbles) if (b.kind === "block" && b.block.kind === "image") out.push({ attachmentId: b.block.attachmentId, caption: b.block.caption });
  for (const a of item.attachments) if (a.mime.startsWith("image/")) out.push({ attachmentId: a.attachmentId, name: a.name });
  return out;
}

/** Every picture in the chat's loaded messages, oldest first, each once. */
export function chatShots(items: readonly ChatItem[]): readonly Shot[] {
  const seen = new Set<string>();
  const out: Shot[] = [];
  for (const item of items) {
    for (const shot of shotsOf(item, bubblesOf(item))) {
      if (seen.has(shot.attachmentId)) continue;
      seen.add(shot.attachmentId);
      out.push(shot);
    }
  }
  return out;
}

/** The shot `by` places from `at` (-1 the one before, 1 the one after); undefined past either end. */
export const stepShot = (shots: readonly Shot[], at: string, by: -1 | 1): string | undefined => {
  const i = shots.findIndex((s) => s.attachmentId === at);
  return i < 0 ? undefined : shots[i + by]?.attachmentId;
};

/** What the viewer steps through: the chat's pictures when they hold the one open, else the message's. */
export const viewerShots = (chat: readonly Shot[] | undefined, message: readonly Shot[], at: string): readonly Shot[] =>
  chat?.some((s) => s.attachmentId === at) === true ? chat : message;
