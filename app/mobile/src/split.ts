// A window wide enough for two (the iPhone Duo unfolded, an iPad) shows Chats beside the open chat, as Messages does
// on an iPad: the list on the left, the chat on the right, and picking another chat swaps it in place rather than
// pushing it over the one before. A phone, or the Duo folded, keeps the one stack: a chat pushed over the list. Pure,
// so it is unit-tested; App.tsx lays the panes out.
import type { Key } from "./store";

/** The narrowest window that has the list beside the chat: under an iPad mini's 744 pt, over any phone's portrait. */
export const SPLIT_LEAST = 700;
/** The list's share of the window, kept between Messages' narrowest sidebar and a width the chat doesn't miss. */
const LIST_SHARE = 0.36;
const LIST_LEAST = 320;
const LIST_MOST = 400;

/** How wide each pane is, in points: the list and the chat beside it. */
export interface Split {
  readonly list: number;
  readonly chat: number;
}

/** The panes of a window `width` points across, or undefined where it's one screen at a time. */
export const splitOf = (width: number): Split | undefined => {
  if (width < SPLIT_LEAST) return undefined;
  const list = Math.min(LIST_MOST, Math.max(LIST_LEAST, Math.round(width * LIST_SHARE)));
  return { list, chat: width - list };
};

/** A root stack's route, as much as is read of it. */
interface RouteLike {
  readonly name: string;
  readonly params?: object | undefined;
}

/**
 * The chat showing in the root stack: its topmost, whatever is over it (its Info), unless Home is over it (Open
 * Approvals goes to Home over whatever was open), where the pane shows none. The list marks its row.
 */
export const openChatKey = (routes: readonly RouteLike[]): Key | undefined => {
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (r?.name === "Home") return undefined;
    if (r?.name !== "Chat") continue;
    const key = (r.params as { key?: unknown } | undefined)?.key;
    return typeof key === "string" ? key : undefined;
  }
  return undefined;
};

/** Whether the chat at `index` stands straight on Home: beside the list it has nothing to go back to. */
export const onHome = (routes: readonly RouteLike[], index: number): boolean => index > 0 && routes[index - 1]?.name === "Home";

/** A window's safe-area insets, as much as is read of them. */
interface InsetsLike {
  readonly top: number;
  readonly left: number;
  readonly right: number;
}

/**
 * The iPhone Duo's control strip: in every pose but the unfolded screen held upright, iOS puts the status and an app's
 * bars in a column at the side, in reach of the thumb, rather than across the top (Apple's "Design for iPhone Duo").
 * Its insets say so: none at the top, and the strip's width at its side, the right one, or the left in a split with
 * another app. Undefined elsewhere: a phone's status is across its top. Content stays out of it; the chat's Back and
 * Info stand in it, as iOS puts its own bars' buttons there.
 */
export const sideStrip = (insets: InsetsLike): { readonly left: number; readonly right: number } | undefined =>
  insets.top > 0 || (insets.left <= 0 && insets.right <= 0) ? undefined : { left: Math.max(insets.left, 0), right: Math.max(insets.right, 0) };
