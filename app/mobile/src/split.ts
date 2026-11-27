// A window wide enough for two (the iPhone Duo unfolded, an iPad) shows Chats beside the open chat, as Messages does
// on an iPad: the list on the left, the chat on the right, and picking another chat swaps it in place rather than
// pushing it over the one before. On the Duo half-open or open the two meet at the fold, as iOS says where it runs
// (src/hinge.ts), so the crease never runs through the chat. A phone, or the Duo folded, keeps the one stack: a chat
// pushed over the list. Pure, so it is unit-tested; App.tsx lays the panes out.
import type { Key } from "./store";

/** The narrowest window that has the list beside the chat: under an iPad mini's 744 pt, over any phone's portrait. */
export const SPLIT_LEAST = 700;
/** The list's share of the window, kept between Messages' narrowest sidebar and a width the chat doesn't miss. */
const LIST_SHARE = 0.36;
const LIST_LEAST = 320;
const LIST_MOST = 400;

/** Narrower than this, a pane beside the fold would be too cramped: the panes keep their own widths then. */
const PANE_LEAST = 240;

/** How wide each pane is, in points: the list, the fold between them (none off a foldable), and the chat. */
export interface Split {
  readonly list: number;
  readonly fold: number;
  readonly chat: number;
}

/** Where the fold runs down the window, in its points from the left: where it starts and how wide iOS keeps it. */
export interface Fold {
  readonly x: number;
  readonly width: number;
}

/**
 * The panes of a window `width` points across, or undefined where it's one screen at a time. With a `fold` down it,
 * the list ends where the fold starts and the chat starts where it ends.
 */
export const splitOf = (width: number, fold?: Fold): Split | undefined => {
  if (width < SPLIT_LEAST) return undefined;
  if (fold !== undefined) {
    const list = Math.round(fold.x);
    const gap = Math.round(fold.width);
    const chat = width - list - gap;
    if (list >= PANE_LEAST && chat >= PANE_LEAST) return { list, fold: gap, chat };
  }
  const list = Math.min(LIST_MOST, Math.max(LIST_LEAST, Math.round(width * LIST_SHARE)));
  return { list, fold: 0, chat: width - list };
};

/** A root stack's route, as much as is read of it. */
interface RouteLike {
  readonly name: string;
  readonly params?: object | undefined;
}

/**
 * The chat showing in the root stack: its topmost, whatever is over it (its Info, a sheet), unless Home or Settings is
 * over it (Open Approvals goes to Home over whatever was open; the W beside the list opens Settings in the pane), where
 * the pane shows none. The list marks its row.
 */
export const openChatKey = (routes: readonly RouteLike[]): Key | undefined => {
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (r?.name === "Home" || r?.name === "Settings") return undefined;
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
export const sideStrip = (insets: InsetsLike): Strip | undefined =>
  insets.top > 0 || (insets.left <= 0 && insets.right <= 0) ? undefined : { left: Math.max(insets.left, 0), right: Math.max(insets.right, 0) };

/**
 * The strip a sheet's content keeps out of in a window `width` wide: all of it where the window is a phone's width (the
 * Duo folded), where a sheet spans the window and its own safe area says nothing of the strip, so its rows ran under the
 * status; none where it is wide enough for the list beside the chat (the Duo unfolded), where a sheet is a card centred
 * well clear of either side.
 */
export const sheetStrip = (strip: Strip | undefined, width: number): Strip | undefined => (width < SPLIT_LEAST ? strip : undefined);

/** How far a screen's content keeps from each side for the strip. */
export interface Strip {
  readonly left: number;
  readonly right: number;
}

/**
 * The part of the window's `strip` a pane touches: the list's (`list`) only the window's left edge, the chat's
 * (`chat`) only its right; the whole window (undefined) both. Undefined where it touches none.
 */
export const paneStrip = (strip: Strip | undefined, side: "list" | "chat" | undefined): Strip | undefined => {
  if (strip === undefined) return undefined;
  const left = side === "chat" ? 0 : strip.left;
  const right = side === "list" ? 0 : strip.right;
  return left > 0 || right > 0 ? { left, right } : undefined;
};
