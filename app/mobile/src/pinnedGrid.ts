// The pinned chats as Messages draws them over its list (screens/Pinned.tsx), as plain view data: which chats go in
// the grid and which stay rows, each cell's size, and what each avatar shows. Pure, so it is unit-tested.
import type { ChatRow, Filter } from "./lists";
import type { Key } from "./store";

/** Three to a row, as in Messages; the avatars as big as a third of the screen leaves room for, up to 84 pt. */
export const PER_ROW = 3;
const MOST = 84;

/** A cell's width and its avatar's, for a screen `width` points across with an 8 pt inset on each side. */
export const gridSize = (width: number): { readonly cell: number; readonly avatar: number } => {
  const cell = Math.floor((width - 16) / PER_ROW);
  return { cell, avatar: Math.min(MOST, cell - 36) };
};

/**
 * The grid's chats, in the person's order, and the list's rows without them. Only the whole list has a grid: a filter
 * or a search shows every chat as a row, pinned ones too.
 */
export const pinnedSplit = (rows: readonly ChatRow[], pinned: readonly Key[], filter: Filter, query: string): { readonly grid: readonly ChatRow[]; readonly rows: readonly ChatRow[] } => {
  if (filter !== "all" || query !== "") return { grid: [], rows };
  const grid = rows.filter((r) => r.pinned).sort((a, b) => pinned.indexOf(a.key) - pinned.indexOf(b.key));
  return { grid, rows: rows.filter((r) => !r.pinned) };
};

/** What rises out of the avatar: its lead's typing bubble while it works, else the newest message when unread. */
export type PinBubble = { readonly t: "typing" } | { readonly t: "said"; readonly text: string } | undefined;

export interface PinFace {
  readonly bubble: PinBubble;
  /** The dot beside the name: unread, grey when muted. */
  readonly dot: "unread" | "muted" | undefined;
  /** The orange count on the avatar: approvals waiting. */
  readonly approvals: number;
}

export const pinFace = (row: ChatRow): PinFace => {
  const unread = row.unread > 0 || row.markedUnread;
  return {
    bubble: row.working ? { t: "typing" } : unread && row.preview !== undefined && row.preview !== "" ? { t: "said", text: row.preview } : undefined,
    dot: unread ? (row.muted ? "muted" : "unread") : undefined,
    approvals: row.approvals,
  };
};
